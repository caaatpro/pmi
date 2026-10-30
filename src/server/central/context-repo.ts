/**
 * Server side of the context engine (CONTEXT_ENGINE.md §2–§5, §8):
 * hybrid search over the whole shared project memory (tsvector + pgvector,
 * fused with RRF), the cached L1 overview, assembling candidates for
 * `buildContext`, the embedding job and metric events.
 *
 * Project data is read through the caller's RLS-scoped transaction; the
 * overview cache and embeddings are written on the owner connection because
 * they are derived from data every project member may read.
 */
import { buildContext, buildOverview, reciprocalRankFusion, type ContextLevel, type ContextMemory, type ContextPackage, type HistoryItem } from '../../context/engine.js';
import { countTextTokens } from '../../compact/token-budget.js';
import type { SessionState } from '../../domain/session.js';
import type { Queryable } from './db.js';

/** What the server needs from an embedding provider; dimensions must match the `vector(384)` column. */
export interface ServerEmbeddings {
  readonly name: string;
  readonly dimensions: number;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_DIMENSIONS = 384;
const OVERVIEW_CATEGORIES = ['project_overview', 'architecture', 'component', 'coding_convention', 'current_state', 'active_task', 'architecture_decision'];

interface MemoryRow {
  id: string;
  category: ContextMemory['category'];
  confidence: ContextMemory['confidence'];
  status: ContextMemory['status'];
  title: string;
  content: string;
  facts: string[];
  component: string | null;
  related_files: string[];
  updated_at: string;
  conflicted: boolean;
}

const MEMORY_COLUMNS = `m.id, m.category, m.confidence, m.status, m.title, m.content, m.facts, m.component, m.related_files, m.updated_at,
  EXISTS (SELECT 1 FROM memory.conflicts c WHERE c.memory_id = m.id AND c.state = 'open') AS conflicted`;

function toContextMemory(row: MemoryRow, relevance?: number): ContextMemory {
  return {
    id: row.id,
    category: row.category,
    confidence: row.confidence,
    status: row.status,
    title: row.title,
    content: row.content,
    facts: Array.isArray(row.facts) ? row.facts.map(String) : [],
    component: row.component,
    relatedFiles: row.related_files ?? [],
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(relevance !== undefined ? { relevance } : {}),
    ...(row.conflicted ? { conflicted: true } : {}),
  };
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => Number(value).toFixed(6)).join(',')}]`;
}

export interface HybridHit {
  id: string;
  relevance: number;
  keywordRank: number | null;
  semanticRank: number | null;
}

/**
 * Hybrid search (§3): keyword (`websearch_to_tsquery`, `ts_rank_cd`, title
 * weighted over content) and, when embeddings are configured, cosine
 * similarity over pgvector; fused with Reciprocal Rank Fusion. Without
 * embeddings it is keyword search, with no error.
 */
export async function hybridSearch(
  tx: Queryable,
  projectIds: string[],
  query: string,
  options: { limit?: number; embeddings?: ServerEmbeddings | null; includeDeprecated?: boolean } = {},
): Promise<HybridHit[]> {
  const limit = options.limit ?? 50;
  if (projectIds.length === 0 || !query.trim()) return [];
  const live = options.includeDeprecated ? '' : "AND m.confidence <> 'deprecated'";
  const keyword = (await tx.query<{ id: string }>(
    `SELECT m.id FROM memory.memories m, websearch_to_tsquery('simple', $2) q
      WHERE m.project_id = ANY ($1::uuid[]) AND m.deleted_at IS NULL ${live} AND m.search @@ q
      ORDER BY ts_rank_cd(m.search, q) DESC, m.updated_at DESC LIMIT $3`,
    [projectIds, query, limit],
  )).map((row) => row.id);
  let semantic: string[] = [];
  if (options.embeddings) {
    const [vector] = await options.embeddings.embedBatch([query]);
    if (vector?.length === EMBEDDING_DIMENSIONS) {
      semantic = (await tx.query<{ id: string }>(
        `SELECT m.id FROM memory.memories m
          WHERE m.project_id = ANY ($1::uuid[]) AND m.deleted_at IS NULL ${live} AND m.embedding IS NOT NULL
          ORDER BY m.embedding <=> $2::vector LIMIT $3`,
        [projectIds, vectorLiteral(vector), limit],
      )).map((row) => row.id);
    }
  }
  const fused = reciprocalRankFusion(semantic.length ? [keyword, semantic] : [keyword]);
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, relevance]) => ({
      id,
      relevance,
      keywordRank: keyword.includes(id) ? keyword.indexOf(id) + 1 : null,
      semanticRank: semantic.includes(id) ? semantic.indexOf(id) + 1 : null,
    }));
}

/**
 * L1 overview, cached in memory.overviews. Rebuilt when memories of the
 * overview categories changed (max server_seq grew) and the cache is older
 * than `minAgeSeconds`, so busy projects do not rebuild it on every call.
 */
export async function getOverview(
  tx: Queryable,
  owner: Queryable,
  project: { id: string; slug: string },
  options: { minAgeSeconds?: number; budgetTokens?: number } = {},
): Promise<{ text: string; ids: string[]; cacheHit: boolean; tokens: number }> {
  const [{ seq }] = await tx.query<{ seq: string | null }>(
    `SELECT max(server_seq)::text AS seq FROM memory.memories WHERE project_id = $1 AND category::text = ANY ($2::text[])`,
    [project.id, OVERVIEW_CATEGORIES],
  );
  const maxSeq = Number(seq ?? 0);
  const [cached] = await tx.query<{ content: string; memory_ids: string[]; tokens: number; source_max_seq: string; age: number }>(
    `SELECT content, memory_ids, tokens, source_max_seq::text, extract(epoch FROM now() - built_at) AS age FROM memory.overviews WHERE project_id = $1`,
    [project.id],
  );
  const minAge = options.minAgeSeconds ?? 600;
  if (cached && (Number(cached.source_max_seq) >= maxSeq || cached.age < minAge)) {
    return { text: cached.content, ids: cached.memory_ids, cacheHit: true, tokens: cached.tokens };
  }
  const rows = await tx.query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memory.memories m
      WHERE m.project_id = $1 AND m.deleted_at IS NULL AND m.category::text = ANY ($2::text[])
      ORDER BY m.updated_at DESC LIMIT 400`,
    [project.id, OVERVIEW_CATEGORIES],
  );
  const overview = buildOverview(rows.map((row) => toContextMemory(row)), { projectName: project.slug, budgetTokens: options.budgetTokens });
  const tokens = countTextTokens(overview.text);
  await owner.query(
    `INSERT INTO memory.overviews (project_id, content, memory_ids, tokens, source_max_seq, built_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, now())
     ON CONFLICT (project_id) DO UPDATE SET content = excluded.content, memory_ids = excluded.memory_ids,
       tokens = excluded.tokens, source_max_seq = excluded.source_max_seq, built_at = now()`,
    [project.id, overview.text, JSON.stringify(overview.ids), tokens, maxSeq],
  );
  return { ...overview, cacheHit: false, tokens };
}

export interface ServerContextRequest {
  task?: string;
  budgetTokens?: number;
  levels?: ContextLevel[];
  files?: string[];
  components?: string[];
  recentGitFiles?: string[];
  session?: SessionState | null;
}

/**
 * Candidates for L2 (search hits for the task, everything tied to the task's
 * files and components, recent memories as a floor) and L3 history when
 * asked, then `buildContext`.
 */
export async function buildServerContext(
  tx: Queryable,
  owner: Queryable,
  project: { id: string; slug: string },
  request: ServerContextRequest,
  options: { embeddings?: ServerEmbeddings | null; overviewMinAgeSeconds?: number } = {},
): Promise<ContextPackage & { search: { hits: number; semantic: boolean } }> {
  const levels = request.levels ?? ['L1', 'L2'];
  const files = [...new Set([...(request.files ?? []), ...(request.session?.git?.modifiedFiles.map((file) => file.path) ?? [])])];
  const query = [request.task, request.session?.task, request.session?.nextAction].filter(Boolean).join(' ');
  const hits = await hybridSearch(tx, [project.id], query, { limit: 80, embeddings: options.embeddings, includeDeprecated: levels.includes('L3') });
  const relevance = new Map(hits.map((hit) => [hit.id, hit.relevance]));
  const rows = await tx.query<MemoryRow>(
    `SELECT ${MEMORY_COLUMNS} FROM memory.memories m
      WHERE m.project_id = $1 AND m.deleted_at IS NULL
        AND (m.id = ANY ($2::text[])
             OR m.related_files && $3::text[]
             OR lower(m.component) = ANY ($4::text[])
             OR m.id IN (SELECT id FROM memory.memories r WHERE r.project_id = $1 AND r.deleted_at IS NULL ORDER BY r.updated_at DESC LIMIT 40))`,
    [project.id, [...relevance.keys()], files, (request.components ?? []).map((component) => component.toLowerCase())],
  );
  const memories = rows.map((row) => toContextMemory(row, relevance.get(row.id) ?? 0));

  let history: HistoryItem[] = [];
  if (levels.includes('L3')) {
    const topIds = hits.slice(0, 10).map((hit) => hit.id);
    const versions = await tx.query<{ title: string; version: number; change_reason: string; changed_at: string }>(
      `SELECT m.title, v.version, v.change_reason, v.changed_at FROM memory.memory_versions v JOIN memory.memories m ON m.id = v.memory_id
        WHERE v.memory_id = ANY ($1::text[]) AND v.version < m.version ORDER BY v.changed_at DESC LIMIT 20`,
      [topIds],
    );
    const sessions = await tx.query<{ task: string; summary: string | null; status: string; updated_at: string }>(
      `SELECT task, summary, status, updated_at FROM work.sessions
        WHERE project_id = $1 AND status IN ('completed', 'failed') ORDER BY updated_at DESC LIMIT 10`,
      [project.id],
    );
    history = [
      ...versions.map((row) => ({ title: `${row.title} v${row.version}`, detail: `${row.change_reason} at ${new Date(row.changed_at).toISOString()}` })),
      ...sessions.map((row) => ({ title: `Session: ${row.task || '(no task)'} [${row.status}]`, detail: row.summary ?? '' })),
    ];
  }

  const overview = levels.includes('L1')
    ? await getOverview(tx, owner, project, { minAgeSeconds: options.overviewMinAgeSeconds, budgetTokens: Math.min(800, Math.floor((request.budgetTokens ?? 2300) * 0.4)) })
    : undefined;
  const pkg = buildContext(memories, { ...request, levels, files, history, projectName: project.slug }, overview ? { overview, cacheHit: overview.cacheHit } : {});
  return { ...pkg, search: { hits: hits.length, semantic: hits.some((hit) => hit.semanticRank !== null) } };
}

/** Background job: embed memories that have none yet (new or edited). Owner connection. */
export async function embedPending(db: Queryable, embeddings: ServerEmbeddings, batchSize = 32): Promise<number> {
  if (embeddings.dimensions !== EMBEDDING_DIMENSIONS) return 0;
  const rows = await db.query<{ id: string; title: string; content: string }>(
    `SELECT id, title, content FROM memory.memories WHERE embedding IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT $1`,
    [batchSize],
  );
  if (rows.length === 0) return 0;
  const vectors = await embeddings.embedBatch(rows.map((row) => `${row.title}\n${row.content}`));
  for (let index = 0; index < rows.length; index++) {
    if (vectors[index]?.length !== EMBEDDING_DIMENSIONS) continue;
    await db.query('UPDATE memory.memories SET embedding = $2::vector WHERE id = $1', [rows[index].id, vectorLiteral(vectors[index])]);
  }
  return rows.length;
}

export async function recordMetric(
  tx: Queryable,
  event: { projectId?: string; sessionId?: string; userId?: string; name: string; value: number; labels?: Record<string, unknown> },
): Promise<void> {
  await tx.query(
    `INSERT INTO work.metrics_events (project_id, session_id, user_id, name, value, labels) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [event.projectId ?? null, event.sessionId ?? null, event.userId ?? null, event.name, event.value, JSON.stringify(event.labels ?? {})],
  );
}
