/**
 * Central memory store: materializes pushed sync batches into
 * `memory.memories`, keeps version history, records concurrent-edit
 * conflicts, and serves the per-project changes feed.
 *
 * Ordering uses the same `(revision, writer)` total order as every replica
 * (src/sync/merge.ts), so the server converges to the state each client
 * would reach by itself, and re-pushing a batch is a no-op.
 */
import type { Observation } from '../../types.js';
import {
  canTransitionConfidence,
  classifyObservation,
  toMemoryStatus,
  type MemoryCategory,
  type MemoryConfidence,
  type MemoryStatus,
} from '../../domain/memory.js';
import { contentHash } from '../../sync/journal.js';
import { containsCredential } from '../../memory/secret-filter.js';
import { compareVersion } from '../../sync/merge.js';
import type { ChangeBatch, ChangeEntry, RowVersion } from '../../sync/types.js';
import type { Queryable } from './db.js';
import { audit, type AuthUser, type ProjectRecord } from './identity.js';

/** Device id the server uses for the batches it serves; clients key their cursor by it. */
export const SERVER_DEVICE_ID = 'baton-server';

export type PushOutcome = 'applied' | 'duplicate' | 'stale' | 'rejected';

export interface PushEntryResult {
  syncKey: string;
  outcome: PushOutcome;
  reason?: string;
  conflict?: boolean;
}

export interface PushResult {
  results: PushEntryResult[];
  lastSeq: number;
}

interface StoredRow {
  id: string;
  project_id: string;
  revision: number;
  writer: string;
  content_hash: string;
  deleted: boolean;
  version: number;
  confidence: MemoryConfidence;
  body: Observation | null;
}

export async function applyPushedBatch(
  tx: Queryable,
  project: ProjectRecord,
  user: AuthUser,
  batch: ChangeBatch,
): Promise<PushResult> {
  const results: PushEntryResult[] = [];
  const applied = new Map<string, { syncKey: string; op: 'upsert' | 'delete' }>();
  for (const entry of batch.entries) {
    const result = await applyEntry(tx, project, user, batch, entry);
    results.push(result.result);
    if (result.applied) {
      applied.delete(result.applied.syncKey);
      applied.set(result.applied.syncKey, result.applied);
    }
  }
  const lastSeq = await assignFeedPositions(tx, project.id, [...applied.values()]);
  const counts = results.reduce<Record<string, number>>((acc, item) => {
    acc[item.outcome] = (acc[item.outcome] ?? 0) + 1;
    return acc;
  }, {});
  await audit(tx, {
    action: 'sync.push',
    actorUserId: user.id,
    orgId: project.orgId,
    projectId: project.id,
    deviceId: batch.deviceId,
    targetType: 'sync_batch',
    targetId: `${batch.deviceId}:${batch.sequence}`,
    detail: { counts },
  });
  return { results, lastSeq };
}

async function applyEntry(
  tx: Queryable,
  project: ProjectRecord,
  user: AuthUser,
  batch: ChangeBatch,
  entry: ChangeEntry,
): Promise<{ result: PushEntryResult; applied?: { syncKey: string; op: 'upsert' | 'delete' } }> {
  const syncKey = entry.syncKey;
  if (entry.kind === 'upsert' && entry.row && hasCredential(entry.row)) {
    // Secrets never reach project memory (spec §14). The row stays on the
    // device that wrote it; the client is told why.
    return { result: { syncKey, outcome: 'rejected', reason: 'contains a credential-like value' } };
  }

  const [owner] = await tx.query<{ project_id: string | null }>('SELECT memory.memory_project($1) AS project_id', [syncKey]);
  if (owner?.project_id && owner.project_id !== project.id) {
    return { result: { syncKey, outcome: 'rejected', reason: 'the sync key belongs to another project' } };
  }
  const [stored] = await tx.query<StoredRow>(
    `SELECT id, project_id, revision, writer, content_hash, deleted_at IS NOT NULL AS deleted, version, confidence, body
       FROM memory.memories WHERE id = $1 FOR UPDATE`,
    [syncKey],
  );

  let conflict = false;
  if (stored) {
    const storedVersion: RowVersion = { revision: stored.revision, writer: stored.writer };
    const cmp = compareVersion(entry.version, storedVersion);
    if (cmp === 0) {
      if (stored.content_hash !== entry.contentHash) {
        return { result: { syncKey, outcome: 'rejected', reason: 'same version with different content' } };
      }
      return { result: { syncKey, outcome: 'duplicate' } };
    }
    if (entry.version.revision === stored.revision) {
      conflict = true;
      const incomingWins = cmp > 0;
      const storedSide = { version: storedVersion, kind: stored.deleted ? 'tombstone' : 'upsert', row: stored.body };
      const incomingSide = { version: entry.version, kind: entry.kind, row: entry.row ?? null };
      await tx.query(
        `INSERT INTO memory.conflicts (project_id, memory_id, kind, detected_by, winner, loser)
         VALUES ($1, $2, 'concurrent_edit', 'sync', $3::jsonb, $4::jsonb)`,
        [project.id, syncKey, JSON.stringify(incomingWins ? incomingSide : storedSide), JSON.stringify(incomingWins ? storedSide : incomingSide)],
      );
    }
    if (cmp < 0) return { result: { syncKey, outcome: 'stale', reason: 'the server holds a newer version', conflict } };
  }
  const protectedReason = confidenceGuard(stored, entry);
  if (protectedReason) return { result: { syncKey, outcome: 'rejected', reason: protectedReason, conflict } };

  // The feed position is assigned for the whole batch at the end (assignFeedPositions).
  const serverSeq = 0;
  const version = (stored?.version ?? 0) + 1;

  if (entry.kind === 'tombstone') {
    if (stored) {
      await tx.query(
        `UPDATE memory.memories SET deleted_at = now(), revision = $2, writer = $3, version = $4,
                content_hash = '', updated_at = now(), server_seq = $5
          WHERE id = $1`,
        [syncKey, entry.version.revision, entry.version.writer, version, serverSeq],
      );
    } else {
      // Remember tombstones for rows we never saw, so a stale upsert from
      // another replica cannot bring the row back.
      await tx.query(
        `INSERT INTO memory.memories (id, project_id, legacy_project_id, category, confidence, revision, writer,
                                      version, deleted_at, created_at, updated_at, server_seq)
         VALUES ($1, $2, $3, 'development_history', 'observed', $4, $5, $6, now(), now(), now(), $7)`,
        [syncKey, project.id, batch.projectId, entry.version.revision, entry.version.writer, version, serverSeq],
      );
    }
  } else {
    await upsertMemoryRow(tx, {
      syncKey, projectId: project.id, legacyProjectId: batch.projectId, row: entry.row!, contentHash: entry.contentHash,
      revision: entry.version.revision, writer: entry.version.writer, version, serverSeq, authorUserId: user.id,
    });
  }

  await tx.query(
    `INSERT INTO memory.memory_versions (memory_id, version, snapshot, deleted, changed_by_user, changed_by_device, change_reason)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'sync')`,
    [syncKey, version, entry.row ? JSON.stringify(entry.row) : null, entry.kind === 'tombstone', user.id, batch.deviceId],
  );
  return { result: { syncKey, outcome: 'applied', conflict }, applied: { syncKey, op: entry.kind === 'tombstone' ? 'delete' : 'upsert' } };
}

/**
 * Give the applied memories their changes-feed positions in one step at the
 * end of the transaction. The project_seq row lock is what keeps commit order
 * equal to feed order (no reader can skip a position that commits later), so
 * it is taken last and held only for these three statements.
 */
async function assignFeedPositions(tx: Queryable, projectId: string, applied: Array<{ syncKey: string; op: 'upsert' | 'delete' }>): Promise<number> {
  if (!applied.length) return 0;
  const [{ first }] = await tx.query<{ first: string }>(
    'UPDATE work.project_seq SET next_seq = next_seq + $2 WHERE project_id = $1 RETURNING next_seq - $2 AS first',
    [projectId, applied.length],
  );
  const seqs = applied.map((_, index) => Number(first) + index);
  await tx.query(
    `UPDATE memory.memories m SET server_seq = v.seq FROM unnest($1::text[], $2::bigint[]) AS v(id, seq) WHERE m.id = v.id`,
    [applied.map((item) => item.syncKey), seqs],
  );
  await tx.query(
    `INSERT INTO work.changes (project_id, seq, entity, entity_id, op)
     SELECT $1, v.seq, 'memory', v.id, v.op FROM unnest($2::text[], $3::bigint[], $4::text[]) AS v(id, seq, op)`,
    [projectId, applied.map((item) => item.syncKey), seqs, applied.map((item) => item.op)],
  );
  return seqs.at(-1)!;
}

/**
 * Sync carries what agents and hooks wrote, so it is held to the agent rules
 * of the confidence model: it may not confirm knowledge, and confirmed
 * knowledge changes only through an explicit, audited human action
 * (`POST /v1/memories/:id/deprecate`).
 */
function confidenceGuard(stored: StoredRow | undefined, entry: ChangeEntry): string | undefined {
  const live = stored && !stored.deleted ? stored : undefined;
  if (live?.confidence === 'confirmed') return 'confirmed knowledge changes only through review; deprecate it and save a new memory';
  if (entry.kind === 'tombstone') return undefined;
  const incoming = classifyObservation(entry.row!).confidence;
  const transition = canTransitionConfidence(live?.confidence ?? 'observed', incoming, 'agent');
  if (!transition.ok) return incoming === 'confirmed' ? 'confirmation requires an explicit confirm by a person' : transition.reason;
  return undefined;
}

/** Write the materialized row of a memory from its Observation body (sync and server-authored writes). */
async function upsertMemoryRow(
  tx: Queryable,
  input: {
    syncKey: string; projectId: string; legacyProjectId: string; row: Observation; contentHash: string;
    revision: number; writer: string; version: number; serverSeq: number; authorUserId: string;
  },
): Promise<void> {
  const { row } = input;
  const { category, confidence } = classifyObservation(row);
  await tx.query(
    `INSERT INTO memory.memories (
       id, project_id, legacy_project_id, category, confidence, status, title, content, facts, component,
       topic_key, source, author_user_id, author_agent, session_id, related_files, related_commits, body,
       content_hash, tokens, revision, writer, version, created_at, updated_at, server_seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb,
             $19, $20, $21, $22, $23, $24, $25, $26)
     ON CONFLICT (id) DO UPDATE SET
       category = excluded.category, confidence = excluded.confidence, status = excluded.status,
       title = excluded.title, content = excluded.content, facts = excluded.facts, component = excluded.component,
       topic_key = excluded.topic_key, source = excluded.source, author_agent = excluded.author_agent,
       session_id = excluded.session_id, related_files = excluded.related_files,
       related_commits = excluded.related_commits, body = excluded.body, content_hash = excluded.content_hash,
       tokens = excluded.tokens, revision = excluded.revision, writer = excluded.writer,
       version = excluded.version, deleted_at = NULL, updated_at = excluded.updated_at,
       server_seq = excluded.server_seq,
       -- New content needs a new vector; the embedding job fills it in.
       embedding = CASE WHEN memory.memories.content_hash = excluded.content_hash THEN memory.memories.embedding ELSE NULL END`,
    [
      input.syncKey, input.projectId, input.legacyProjectId, category, confidence, toMemoryStatus(row.status, row.review),
      row.title ?? '', row.narrative ?? '', JSON.stringify(row.facts ?? []), row.entityName ?? null,
      row.topicKey ?? null, row.source ?? 'agent', input.authorUserId, row.createdByAgentId ?? null, row.sessionId ?? null,
      row.filesModified ?? [], row.relatedCommits ?? [], JSON.stringify(row), input.contentHash, row.tokens ?? 0,
      input.revision, input.writer, input.version, row.createdAt, row.updatedAt ?? row.createdAt, input.serverSeq,
    ],
  );
}

/**
 * A memory written by the server itself (git analysis, confirmations): a new
 * revision by `baton-server`, with history and a changes-feed entry, so every
 * client receives it like any other edit. Unchanged content is a no-op.
 */
export async function writeServerMemory(
  tx: Queryable,
  project: { id: string; legacyProjectIds: string[] },
  user: AuthUser,
  input: { syncKey: string; legacyProjectId: string; body: Observation; reason: string },
): Promise<{ written: boolean }> {
  const [owner] = await tx.query<{ project_id: string | null }>('SELECT memory.memory_project($1) AS project_id', [input.syncKey]);
  if (owner?.project_id && owner.project_id !== project.id) return { written: false };
  const [stored] = await tx.query<{ revision: number; version: number; content_hash: string; deleted: boolean; confidence: MemoryConfidence }>(
    'SELECT revision, version, content_hash, deleted_at IS NOT NULL AS deleted, confidence FROM memory.memories WHERE id = $1 FOR UPDATE',
    [input.syncKey],
  );
  const hash = contentHash(input.body);
  if (stored && !stored.deleted && stored.content_hash === hash) return { written: false };
  // Confirmed knowledge is never rewritten by an automatic process.
  if (stored && !stored.deleted && stored.confidence === 'confirmed' && input.reason !== 'confirm') return { written: false };
  const [{ seq }] = await tx.query<{ seq: string }>(
    'UPDATE work.project_seq SET next_seq = next_seq + 1 WHERE project_id = $1 RETURNING next_seq - 1 AS seq',
    [project.id],
  );
  const version = (stored?.version ?? 0) + 1;
  await upsertMemoryRow(tx, {
    syncKey: input.syncKey, projectId: project.id, legacyProjectId: input.legacyProjectId, row: input.body, contentHash: hash,
    revision: (stored?.revision ?? 0) + 1, writer: SERVER_DEVICE_ID, version, serverSeq: Number(seq), authorUserId: user.id,
  });
  await tx.query(
    `INSERT INTO memory.memory_versions (memory_id, version, snapshot, changed_by_user, change_reason) VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [input.syncKey, version, JSON.stringify(input.body), user.id, input.reason],
  );
  await tx.query(`INSERT INTO work.changes (project_id, seq, entity, entity_id, op) VALUES ($1, $2, 'memory', $3, 'upsert')`, [project.id, Number(seq), input.syncKey]);
  return { written: true };
}

function hasCredential(row: Observation): boolean {
  return [row.title, row.narrative, ...(row.facts ?? [])].some((text) => typeof text === 'string' && containsCredential(text));
}

export interface FeedChange {
  seq: number;
  entry: ChangeEntry;
}

/**
 * Changes after `after`, oldest first. Only the latest change of each memory
 * is served (`server_seq = seq`), so a client catching up never replays
 * intermediate versions. `legacyProjectId` limits rows to the Baton
 * identity the caller replicates.
 */
export async function readChanges(
  db: Queryable,
  projectId: string,
  legacyProjectId: string,
  after: number,
  limit: number,
): Promise<{ changes: FeedChange[]; hasMore: boolean; lastSeq: number }> {
  const rows = await db.query<{ seq: string; id: string; revision: number; writer: string; content_hash: string; deleted: boolean; body: Observation | null }>(
    `SELECT c.seq, m.id, m.revision, m.writer, m.content_hash, m.deleted_at IS NOT NULL AS deleted, m.body
       FROM work.changes c
       JOIN memory.memories m ON m.id = c.entity_id AND m.server_seq = c.seq
      WHERE c.project_id = $1 AND c.entity = 'memory' AND c.seq > $2 AND m.legacy_project_id = $3
      ORDER BY c.seq
      LIMIT $4`,
    [projectId, after, legacyProjectId, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const changes = page.map((row) => ({
    seq: Number(row.seq),
    entry: row.deleted
      ? { syncKey: row.id, kind: 'tombstone' as const, version: { revision: row.revision, writer: row.writer }, contentHash: '' }
      : { syncKey: row.id, kind: 'upsert' as const, version: { revision: row.revision, writer: row.writer }, contentHash: row.content_hash, row: row.body! },
  }));
  return { changes, hasMore, lastSeq: changes.at(-1)?.seq ?? after };
}

export interface MemoryView {
  id: string;
  category: MemoryCategory;
  confidence: MemoryConfidence;
  status: MemoryStatus;
  title: string;
  content: string;
  facts: string[];
  component: string | null;
  topicKey: string | null;
  source: string;
  authorUserId: string | null;
  authorEmail: string | null;
  authorAgent: string | null;
  relatedFiles: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  serverSeq: number;
}

const MEMORY_VIEW_COLUMNS = `id, category, confidence, status, title, content, facts, component, topic_key AS "topicKey",
  source, author_user_id AS "authorUserId", core.user_email(author_user_id) AS "authorEmail", author_agent AS "authorAgent", related_files AS "relatedFiles", version,
  created_at AS "createdAt", updated_at AS "updatedAt", server_seq::int AS "serverSeq"`;

export interface MemoryFilters {
  category?: MemoryCategory;
  confidence?: MemoryConfidence;
  status?: MemoryStatus;
  component?: string;
  file?: string;
  limit: number;
  offset?: number;
}

export async function listMemories(db: Queryable, projectId: string, filters: MemoryFilters): Promise<MemoryView[]> {
  const where = ['project_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [projectId];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (filters.category) add('category = ?', filters.category);
  if (filters.confidence) add('confidence = ?', filters.confidence);
  if (filters.status) add('status = ?', filters.status);
  if (filters.component) add('component = ?', filters.component);
  if (filters.file) add('? = ANY (related_files)', filters.file);
  params.push(filters.limit);
  return db.query<MemoryView>(
    `SELECT ${MEMORY_VIEW_COLUMNS} FROM memory.memories WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, id LIMIT $${params.length} OFFSET ${Math.max(0, Math.trunc(filters.offset ?? 0))}`,
    params,
  );
}

export async function getMemory(
  db: Queryable,
  memoryId: string,
): Promise<(MemoryView & { projectId: string; deleted: boolean }) | undefined> {
  const [row] = await db.query<MemoryView & { projectId: string; deleted: boolean }>(
    `SELECT ${MEMORY_VIEW_COLUMNS}, project_id AS "projectId", deleted_at IS NOT NULL AS deleted
       FROM memory.memories WHERE id = $1`,
    [memoryId],
  );
  return row;
}

export async function listVersions(db: Queryable, memoryId: string): Promise<Array<{ version: number; deleted: boolean; changedAt: string; changedByUser: string | null; changedByEmail: string | null; changedByDevice: string | null; reason: string }>> {
  return db.query(
    `SELECT version, deleted, changed_at AS "changedAt", changed_by_user AS "changedByUser",
            core.user_email(changed_by_user) AS "changedByEmail", changed_by_device AS "changedByDevice", change_reason AS reason
       FROM memory.memory_versions WHERE memory_id = $1 ORDER BY version DESC`,
    [memoryId],
  );
}

export async function listConflicts(db: Queryable, projectId: string, state = 'open'): Promise<Array<Record<string, unknown>>> {
  return db.query(
    `SELECT id, memory_id AS "memoryId", kind, detected_by AS "detectedBy", winner, loser, state, created_at AS "createdAt"
       FROM memory.conflicts WHERE project_id = $1 AND state = $2 ORDER BY created_at DESC LIMIT 200`,
    [projectId, state],
  );
}

/** Memory views for ids, in the given order (search results). */
export async function memoriesByIds(db: Queryable, ids: string[]): Promise<Array<MemoryView & { projectId: string }>> {
  if (ids.length === 0) return [];
  const rows = await db.query<MemoryView & { projectId: string }>(
    `SELECT ${MEMORY_VIEW_COLUMNS}, project_id AS "projectId" FROM memory.memories WHERE id = ANY ($1::text[]) AND deleted_at IS NULL`,
    [ids],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is MemoryView & { projectId: string } => Boolean(row));
}

/**
 * A person confirms or deprecates a memory. The server authors a new
 * revision (writer `baton-server`) with the new confidence in the body, so
 * every client receives it through the changes feed like any other edit.
 */
export async function setConfidence(
  tx: Queryable,
  project: { id: string; orgId: string },
  user: AuthUser,
  memoryId: string,
  to: 'confirmed' | 'deprecated',
  reason?: string,
): Promise<MemoryView | undefined> {
  const [stored] = await tx.query<StoredRow>(
    `SELECT id, project_id, revision, writer, content_hash, deleted_at IS NOT NULL AS deleted, version, confidence, body
       FROM memory.memories WHERE id = $1 AND project_id = $2 FOR UPDATE`,
    [memoryId, project.id],
  );
  if (!stored || stored.deleted || !stored.body) return undefined;
  if (stored.confidence !== to) {
    const transition = canTransitionConfidence(stored.confidence, to, 'human');
    if (!transition.ok) throw new Error(transition.reason);
    const body: Observation = { ...stored.body, confidence: to };
    const [{ seq }] = await tx.query<{ seq: string }>(
      'UPDATE work.project_seq SET next_seq = next_seq + 1 WHERE project_id = $1 RETURNING next_seq - 1 AS seq',
      [project.id],
    );
    const version = stored.version + 1;
    await tx.query(
      `UPDATE memory.memories
          SET confidence = $2::text::memory.confidence, body = $3::jsonb, content_hash = $4, revision = revision + 1, writer = $5,
              version = $6, updated_at = now(), server_seq = $7,
              confirmed_by = CASE WHEN $2::text = 'confirmed' THEN $8::uuid ELSE confirmed_by END,
              confirmed_at = CASE WHEN $2::text = 'confirmed' THEN now() ELSE confirmed_at END
        WHERE id = $1`,
      [memoryId, to, JSON.stringify(body), contentHash(body), SERVER_DEVICE_ID, version, Number(seq), user.id],
    );
    await tx.query(
      `INSERT INTO memory.memory_versions (memory_id, version, snapshot, changed_by_user, change_reason)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [memoryId, version, JSON.stringify(body), user.id, reason ? `${to === 'confirmed' ? 'confirm' : 'deprecate'}: ${reason}` : (to === 'confirmed' ? 'confirm' : 'deprecate')],
    );
    await tx.query(
      `INSERT INTO work.changes (project_id, seq, entity, entity_id, op) VALUES ($1, $2, 'memory', $3, 'upsert')`,
      [project.id, Number(seq), memoryId],
    );
    await audit(tx, {
      action: to === 'confirmed' ? 'memory.confirm' : 'memory.deprecate',
      actorUserId: user.id,
      orgId: project.orgId,
      projectId: project.id,
      targetType: 'memory',
      targetId: memoryId,
      detail: reason ? { reason: reason.slice(0, 500) } : {},
    });
  }
  return getMemory(tx, memoryId);
}

