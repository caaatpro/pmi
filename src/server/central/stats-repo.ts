/**
 * Read models for the web UI (docs/baton/WEB_UI.md): per-project counts of
 * knowledge, sessions, conflicts and git analysis, and the project audit log.
 * Counts run inside `db.asUser()`, so row-level security decides what is
 * counted; the audit log is read by the owner after `authorize()`, since the
 * application role may only append to it.
 */
import type { Queryable } from './db.js';

export interface ProjectStats {
  memories: {
    total: number;
    byCategory: Record<string, number>;
    byConfidence: Record<string, number>;
    byStatus: Record<string, number>;
    /** Knowledge a commit may have outdated (status needs_review). */
    needsReview: number;
    /** Agent-written knowledge no person has confirmed yet. */
    unconfirmed: number;
    lastUpdatedAt: string | null;
  };
  sessions: { total: number; byStatus: Record<string, number> };
  openConflicts: number;
  git: Array<{ branch: string; lastAnalyzedCommit: string; lastFullReconcileAt: string | null; updatedAt: string }>;
}

const UNCONFIRMED: ReadonlySet<string> = new Set(['observed', 'inferred', 'proposed']);

export async function projectStats(tx: Queryable, projectId: string): Promise<ProjectStats> {
  const memoryRows = await tx.query<{ category: string; confidence: string; status: string; n: number; last: string | null }>(
    `SELECT category::text, confidence::text, status::text, count(*)::int AS n, max(updated_at) AS last
       FROM memory.memories WHERE project_id = $1 AND deleted_at IS NULL
      GROUP BY 1, 2, 3`,
    [projectId],
  );
  const memories: ProjectStats['memories'] = { total: 0, byCategory: {}, byConfidence: {}, byStatus: {}, needsReview: 0, unconfirmed: 0, lastUpdatedAt: null };
  const bump = (into: Record<string, number>, key: string, n: number) => { into[key] = (into[key] ?? 0) + n; };
  for (const row of memoryRows) {
    memories.total += row.n;
    bump(memories.byCategory, row.category, row.n);
    bump(memories.byConfidence, row.confidence, row.n);
    bump(memories.byStatus, row.status, row.n);
    if (row.status === 'needs_review') memories.needsReview += row.n;
    if (UNCONFIRMED.has(row.confidence) && row.status !== 'archived') memories.unconfirmed += row.n;
    const last = row.last ? new Date(row.last).toISOString() : null;
    if (last && (!memories.lastUpdatedAt || last > memories.lastUpdatedAt)) memories.lastUpdatedAt = last;
  }

  const sessionRows = await tx.query<{ status: string; n: number }>(
    'SELECT status::text, count(*)::int AS n FROM work.sessions WHERE project_id = $1 GROUP BY 1',
    [projectId],
  );
  const sessions = { total: 0, byStatus: {} as Record<string, number> };
  for (const row of sessionRows) {
    sessions.total += row.n;
    sessions.byStatus[row.status] = row.n;
  }

  const [conflicts] = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM memory.conflicts WHERE project_id = $1 AND state = 'open'",
    [projectId],
  );
  const git = await tx.query<ProjectStats['git'][number]>(
    `SELECT branch, last_analyzed_commit AS "lastAnalyzedCommit", last_full_reconcile_at AS "lastFullReconcileAt", updated_at AS "updatedAt"
       FROM work.git_cursors WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 20`,
    [projectId],
  );
  return { memories, sessions, openConflicts: conflicts?.n ?? 0, git };
}

export interface AuditEntry {
  id: number;
  at: string;
  action: string;
  actorEmail: string | null;
  actorDeviceId: string | null;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown>;
}

/** Newest first; `before` is the id of the oldest entry already shown. */
export async function listAudit(owner: Queryable, projectId: string, options: { limit: number; before?: number }): Promise<AuditEntry[]> {
  const rows = await owner.query<AuditEntry & { id: string }>(
    `SELECT a.id, a.at, a.action, u.email::text AS "actorEmail", a.actor_device_id AS "actorDeviceId",
            a.target_type AS "targetType", a.target_id AS "targetId", a.detail
       FROM core.audit_log a LEFT JOIN core.users u ON u.id = a.actor_user_id
      WHERE a.project_id = $1 AND ($2::bigint IS NULL OR a.id < $2)
      ORDER BY a.id DESC LIMIT $3`,
    [projectId, options.before ?? null, options.limit],
  );
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}
