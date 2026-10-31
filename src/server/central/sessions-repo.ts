/**
 * Central session store: leases, checkpoints, handoff, resume and lease
 * expiry (docs/PMI/SESSION_CONTINUITY.md §3–§6).
 *
 * Ownership rule used by every write: the caller must be the session's user
 * and either hold the lease or find it free/expired while nobody else has
 * continued the session. A checkpoint that fails the rule is still stored
 * (`orphan`) so nothing a device produced offline is lost.
 */
import {
  RESUMABLE_STATUSES,
  LIVE_STATUSES,
  FINAL_STATUSES,
  buildHandoffBrief,
  resumeHints,
  statusAfterLeaseLoss,
  type CheckpointTrigger,
  type SessionState,
  type SessionStatus,
} from '../../domain/session.js';
import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.js';
import { HttpError, audit, type AuthUser, type ProjectRecord } from './identity.js';

export interface SessionRow {
  id: string;
  projectId: string;
  userId: string;
  deviceId: string;
  agent: string | null;
  modelProvider: string | null;
  model: string | null;
  status: SessionStatus;
  task: string;
  objective: string;
  state: SessionState;
  parentSessionId: string | null;
  continuedBy: string | null;
  leaseDevice: string | null;
  leaseExpiresAt: string | null;
  leaseLive: boolean;
  releasedAt: string | null;
  handoffTo: string | null;
  handoffReservedUntil: string | null;
  handoffBrief: string | null;
  lastCheckpointId: string | null;
  lastCheckpointSeq: number;
  gitBranch: string | null;
  gitHead: string | null;
  summary: string | null;
  userEmail: string;
  createdAt: string;
  updatedAt: string;
}

const SESSION_COLUMNS = `s.id, s.project_id AS "projectId", s.user_id AS "userId", s.device_id AS "deviceId", s.agent,
  s.model_provider AS "modelProvider", s.model, s.status, s.task, s.objective, s.state,
  s.parent_session_id AS "parentSessionId", s.continued_by AS "continuedBy", s.lease_device AS "leaseDevice",
  s.lease_expires_at AS "leaseExpiresAt", COALESCE(s.lease_expires_at > now(), false) AS "leaseLive",
  s.released_at AS "releasedAt",
  s.handoff_to AS "handoffTo", s.handoff_reserved_until AS "handoffReservedUntil", s.handoff_brief AS "handoffBrief",
  s.last_checkpoint_id AS "lastCheckpointId", s.last_checkpoint_seq AS "lastCheckpointSeq",
  s.git_branch AS "gitBranch", s.git_head AS "gitHead", s.summary,
  core.user_email(s.user_id) AS "userEmail",
  s.created_at AS "createdAt", s.updated_at AS "updatedAt"`;

export async function getSession(db: Queryable, id: string, forUpdate = false): Promise<SessionRow | undefined> {
  const [row] = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM work.sessions s WHERE s.id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return row;
}

function leaseInterval(ttlSeconds: number): string {
  return `${Math.max(1, Math.round(ttlSeconds))} seconds`;
}

/** Whether `device` of `user` may write to the session now. */
function ownsSession(session: SessionRow, user: AuthUser, deviceId: string): boolean {
  if (session.userId !== user.id) return false;
  if (FINAL_STATUSES.includes(session.status) || session.continuedBy || session.releasedAt) return false;
  return session.leaseDevice === deviceId || !session.leaseLive;
}

function assertOwner(session: SessionRow, user: AuthUser, deviceId: string): void {
  if (session.userId !== user.id) throw new HttpError(403, 'not_session_owner', 'only the user who runs this session can write to it; use resume');
  if (session.continuedBy) throw new HttpError(409, 'already_continued', `the session was continued in ${session.continuedBy}`, { continuedBy: session.continuedBy });
  if (FINAL_STATUSES.includes(session.status)) throw new HttpError(409, 'session_closed', `the session is ${session.status}`);
  if (session.releasedAt) throw new HttpError(409, 'session_handed_off', 'the session was handed off; resume it to continue', { releasedAt: session.releasedAt });
  if (session.leaseDevice !== deviceId && session.leaseLive) {
    throw new HttpError(409, 'lease_held', 'another device holds the lease for this session', { leaseExpiresAt: session.leaseExpiresAt });
  }
}

/** Status a client may report through upsert/checkpoint; lifecycle moves (handoff, finish, resume) have their own calls. */
function reportedStatus(state: SessionState): SessionStatus {
  return state.status === 'created' || state.status === 'checkpointed' || state.status === 'waiting_handoff' ? state.status : 'in_progress';
}

export async function upsertSession(
  tx: Queryable,
  project: ProjectRecord,
  user: AuthUser,
  deviceId: string,
  state: SessionState,
  ttlSeconds: number,
): Promise<SessionRow> {
  const [owner] = await tx.query<{ project_id: string | null }>('SELECT work.session_project($1) AS project_id', [state.sessionId]);
  if (owner?.project_id && owner.project_id !== project.id) throw new HttpError(409, 'session_id_taken', 'the session id belongs to another project');
  const existing = await getSession(tx, state.sessionId, true);
  const stored: SessionState = { ...state, userId: user.id, deviceId };
  if (!existing) {
    let parent: string | null = null;
    if (state.parentSessionId) {
      const parentRow = await getSession(tx, state.parentSessionId);
      parent = parentRow?.projectId === project.id ? parentRow.id : null;
    }
    await tx.query(
      `INSERT INTO work.sessions (id, project_id, user_id, device_id, agent, model_provider, model, status, task, objective, state,
                                  parent_session_id, lease_device, lease_user, lease_expires_at, git_branch, git_head)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $4, $3, now() + $13::interval, $14, $15)`,
      [state.sessionId, project.id, user.id, deviceId, state.agent, state.modelProvider ?? null, state.model ?? null,
        reportedStatus(state), state.task, state.objective, JSON.stringify(stored), parent, leaseInterval(ttlSeconds),
        state.git?.branch ?? null, state.git?.head ?? null],
    );
    await audit(tx, { action: 'session.start', actorUserId: user.id, orgId: project.orgId, projectId: project.id, deviceId, targetType: 'session', targetId: state.sessionId, detail: { agent: state.agent } });
  } else {
    assertOwner(existing, user, deviceId);
    await tx.query(
      `UPDATE work.sessions SET agent = $2, model_provider = $3, model = $4, task = $5, objective = $6, state = $7::jsonb,
              status = CASE WHEN status IN ('resumable','interrupted') THEN 'in_progress' ELSE $8 END,
              device_id = $9, lease_device = $9, lease_user = $10, lease_expires_at = now() + $11::interval,
              git_branch = $12, git_head = $13, updated_at = now()
        WHERE id = $1`,
      [state.sessionId, state.agent, state.modelProvider ?? null, state.model ?? null, state.task, state.objective,
        JSON.stringify(stored), reportedStatus(state), deviceId, user.id, leaseInterval(ttlSeconds), state.git?.branch ?? null, state.git?.head ?? null],
    );
  }
  return (await getSession(tx, state.sessionId))!;
}

export interface CheckpointInput {
  id: string;
  seq: number;
  trigger: CheckpointTrigger;
  state: SessionState;
  createdAt: string;
}

export async function addCheckpoint(
  tx: Queryable,
  session: SessionRow,
  user: AuthUser,
  deviceId: string,
  input: CheckpointInput,
  ttlSeconds: number,
): Promise<{ outcome: 'applied' | 'duplicate' | 'out_of_order' | 'orphan' }> {
  const [existing] = await tx.query<{ id: string }>('SELECT id FROM work.checkpoints WHERE id = $1 OR (session_id = $2 AND seq = $3)', [input.id, session.id, input.seq]);
  if (existing) return { outcome: 'duplicate' };
  if (session.userId !== user.id) throw new HttpError(403, 'not_session_owner', 'only the user who runs this session can checkpoint it');
  const owns = ownsSession(session, user, deviceId);
  const state: SessionState = { ...input.state, userId: user.id, deviceId };
  await tx.query(
    `INSERT INTO work.checkpoints (id, session_id, seq, trigger, state, created_by_user, device_id, orphan, created_at, snapshot_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
    [input.id, session.id, input.seq, input.trigger, JSON.stringify(state), user.id, deviceId, !owns, input.createdAt, state.workspaceSnapshotId ?? null],
  );
  if (!owns) return { outcome: 'orphan' };
  if (input.seq <= session.lastCheckpointSeq) return { outcome: 'out_of_order' };
  await tx.query(
    `UPDATE work.sessions SET state = $2::jsonb, status = $3, last_checkpoint_id = $4, last_checkpoint_seq = $5,
            task = $6, objective = $7, git_branch = $8, git_head = $9, device_id = $10, lease_device = $10, lease_user = $11,
            lease_expires_at = now() + $12::interval, updated_at = now()
      WHERE id = $1`,
    [session.id, JSON.stringify(state), reportedStatus(state), input.id, input.seq, state.task, state.objective,
      state.git?.branch ?? null, state.git?.head ?? null, deviceId, user.id, leaseInterval(ttlSeconds)],
  );
  return { outcome: 'applied' };
}

export async function heartbeat(tx: Queryable, session: SessionRow, user: AuthUser, deviceId: string, ttlSeconds: number): Promise<string> {
  assertOwner(session, user, deviceId);
  if (!LIVE_STATUSES.includes(session.status) && !RESUMABLE_STATUSES.includes(session.status)) {
    throw new HttpError(409, 'session_closed', `the session is ${session.status}`);
  }
  const [row] = await tx.query<{ expires: string }>(
    `UPDATE work.sessions SET lease_device = $2, lease_user = $3, lease_expires_at = now() + $4::interval,
            status = CASE WHEN status IN ('resumable','interrupted') THEN 'in_progress' ELSE status END, updated_at = now()
      WHERE id = $1 RETURNING lease_expires_at AS expires`,
    [session.id, deviceId, user.id, leaseInterval(ttlSeconds)],
  );
  return row.expires;
}

export async function handoffSession(
  tx: Queryable,
  project: ProjectRecord,
  session: SessionRow,
  user: AuthUser,
  deviceId: string,
  input: { brief: string; toUserId?: string; reserveHours: number },
): Promise<SessionRow> {
  assertOwner(session, user, deviceId);
  if (!session.lastCheckpointId) throw new HttpError(412, 'checkpoint_required', 'push the handoff checkpoint before handing off');
  await tx.query(
    `UPDATE work.sessions SET status = 'resumable', handoff_brief = $2, handoff_to = $3,
            handoff_reserved_until = CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() + $4::interval END,
            lease_device = NULL, lease_user = NULL, lease_expires_at = NULL, released_at = now(), updated_at = now()
      WHERE id = $1`,
    [session.id, input.brief, input.toUserId ?? null, `${input.reserveHours} hours`],
  );
  await audit(tx, { action: 'session.handoff', actorUserId: user.id, orgId: project.orgId, projectId: project.id, deviceId, targetType: 'session', targetId: session.id, detail: input.toUserId ? { to: input.toUserId } : {} });
  return (await getSession(tx, session.id))!;
}

export async function finishSession(
  tx: Queryable,
  project: ProjectRecord,
  session: SessionRow,
  user: AuthUser,
  deviceId: string,
  input: { status: 'completed' | 'failed'; summary?: string },
): Promise<SessionRow> {
  if (FINAL_STATUSES.includes(session.status)) return session;
  assertOwner(session, user, deviceId);
  await tx.query(
    `UPDATE work.sessions SET status = $2, summary = $3, state = jsonb_set(state, '{status}', to_jsonb($2::text)),
            lease_device = NULL, lease_user = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1`,
    [session.id, input.status, input.summary ?? null],
  );
  await audit(tx, { action: `session.${input.status === 'completed' ? 'finish' : 'fail'}`, actorUserId: user.id, orgId: project.orgId, projectId: project.id, deviceId, targetType: 'session', targetId: session.id });
  return (await getSession(tx, session.id))!;
}

/** The device gives the session up without a handoff (agent gone, daemon idle timeout). */
export async function releaseSession(tx: Queryable, session: SessionRow, user: AuthUser, deviceId: string): Promise<SessionRow> {
  if (!LIVE_STATUSES.includes(session.status)) return session;
  assertOwner(session, user, deviceId);
  const status = statusAfterLeaseLoss(Boolean(session.lastCheckpointId));
  await tx.query(
    `UPDATE work.sessions SET status = $2, state = jsonb_set(state, '{status}', to_jsonb($2::text)),
            lease_device = NULL, lease_user = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1`,
    [session.id, status],
  );
  return (await getSession(tx, session.id))!;
}

/**
 * System job: sessions whose lease ran out become `resumable` (or
 * `interrupted` without any checkpoint). Runs on the owner connection.
 */
export async function expireLeases(db: Queryable): Promise<string[]> {
  const rows = await db.query<{ id: string; project_id: string; status: string }>(
    `UPDATE work.sessions
        SET status = CASE WHEN last_checkpoint_id IS NOT NULL THEN 'resumable' ELSE 'interrupted' END,
            state = jsonb_set(state, '{status}', to_jsonb(CASE WHEN last_checkpoint_id IS NOT NULL THEN 'resumable' ELSE 'interrupted' END)),
            lease_device = NULL, lease_user = NULL, updated_at = now()
      WHERE status IN ('created','in_progress','checkpointed') AND lease_expires_at IS NOT NULL AND lease_expires_at <= now()
      RETURNING id, project_id, status`,
  );
  for (const row of rows) {
    await audit(db, { action: 'session.lease_expired', projectId: row.project_id, targetType: 'session', targetId: row.id, detail: { status: row.status } });
  }
  return rows.map((row) => row.id);
}

export async function listSessions(
  db: Queryable,
  projectId: string,
  filter: { statuses?: SessionStatus[]; limit: number },
): Promise<SessionRow[]> {
  const params: unknown[] = [projectId];
  let where = 's.project_id = $1';
  if (filter.statuses?.length) {
    params.push(filter.statuses);
    where += ` AND s.status = ANY ($${params.length}::text[])`;
  }
  params.push(filter.limit);
  return db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM work.sessions s WHERE ${where} ORDER BY s.updated_at DESC LIMIT $${params.length}`,
    params,
  );
}

export async function listCheckpoints(db: Queryable, sessionId: string): Promise<Array<{ id: string; seq: number; trigger: string; orphan: boolean; createdAt: string }>> {
  return db.query(
    `SELECT id, seq, trigger, orphan, created_at AS "createdAt" FROM work.checkpoints WHERE session_id = $1 ORDER BY seq`,
    [sessionId],
  );
}

export interface ResumePackage {
  session: SessionRow;
  resumedFrom: string;
  continuation: 'same_session' | 'child_session';
  state: SessionState;
  brief: string;
  decisions: Array<{ id: string; title: string; summary: string; confidence: string }>;
  filesToRead: string[];
  doNotRedo: string[];
  nextAction: string | null;
  nextActionInferred: boolean;
  lastCheckpoint: SessionState['lastCheckpoint'];
  /** The working copy at the last checkpoint, when one was uploaded; restore it with `pmi workspace restore`. */
  snapshot: ResumeSnapshot | null;
}

export interface ResumeSnapshot {
  id: string;
  manifestSha256: string;
  baseCommit: string;
  branch: string | null;
  fileCount: number;
  totalBytes: number;
  pinned: boolean;
  createdAt: string;
}

/**
 * Take over a session. The same user continues the same session; another
 * user gets a child session (parent_session_id) carrying the state, and the
 * parent is closed as continued — authorship of each part stays clear.
 */
export async function resumeSession(
  tx: Queryable,
  project: ProjectRecord & { role: string },
  user: AuthUser,
  deviceId: string,
  sessionId: string,
  input: { force?: boolean; newSessionId?: string; agent?: string; model?: string; modelProvider?: string },
  ttlSeconds: number,
): Promise<ResumePackage> {
  const session = await getSession(tx, sessionId, true);
  if (!session || session.projectId !== project.id) throw new HttpError(404, 'session_not_found', 'session not found');
  if (FINAL_STATUSES.includes(session.status)) {
    throw new HttpError(409, session.continuedBy ? 'already_continued' : 'session_closed',
      session.continuedBy ? `the session was continued in ${session.continuedBy}` : `the session is ${session.status}`,
      session.continuedBy ? { continuedBy: session.continuedBy } : undefined);
  }
  const forced = Boolean(input.force);
  if (session.leaseLive && session.leaseDevice !== deviceId && !forced) {
    throw new HttpError(409, 'lease_held', 'the session is still active on another device; ask its owner to hand off, wait for the lease to expire, or use --force as maintainer', { leaseExpiresAt: session.leaseExpiresAt });
  }
  if (session.handoffTo && session.handoffTo !== user.id && session.handoffReservedUntil && new Date(session.handoffReservedUntil) > new Date() && !forced) {
    throw new HttpError(409, 'reserved', 'the session was handed off to another user', { reservedUntil: session.handoffReservedUntil });
  }

  const sameUser = session.userId === user.id;
  let resumed: SessionRow;
  if (sameUser) {
    const state: SessionState = { ...session.state, status: 'in_progress', deviceId, ...(input.agent ? { agent: input.agent } : {}), ...(input.model ? { model: input.model } : {}), ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}), updatedAt: new Date().toISOString() };
    await tx.query(
      `UPDATE work.sessions SET status = 'in_progress', state = $2::jsonb, device_id = $3, agent = $4,
              lease_device = $3, lease_user = $5, lease_expires_at = now() + $6::interval,
              handoff_to = NULL, handoff_reserved_until = NULL, released_at = NULL, updated_at = now()
        WHERE id = $1`,
      [session.id, JSON.stringify(state), deviceId, state.agent, user.id, leaseInterval(ttlSeconds)],
    );
    resumed = (await getSession(tx, session.id))!;
  } else {
    const childId = input.newSessionId ?? `ses_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const [taken] = await tx.query<{ project_id: string | null }>('SELECT work.session_project($1) AS project_id', [childId]);
    if (taken?.project_id) throw new HttpError(409, 'session_id_taken', 'choose another session id');
    const now = new Date().toISOString();
    const state: SessionState = {
      ...session.state,
      sessionId: childId,
      userId: user.id,
      deviceId,
      agent: input.agent ?? session.state.agent,
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
      status: 'in_progress',
      parentSessionId: session.id,
      lastCheckpoint: null,
      updatedAt: now,
    };
    await tx.query(
      `INSERT INTO work.sessions (id, project_id, user_id, device_id, agent, model_provider, model, status, task, objective, state,
                                  parent_session_id, lease_device, lease_user, lease_expires_at, git_branch, git_head)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_progress', $8, $9, $10::jsonb, $11, $4, $3, now() + $12::interval, $13, $14)`,
      [childId, project.id, user.id, deviceId, state.agent, state.modelProvider ?? null, state.model ?? null, state.task, state.objective,
        JSON.stringify(state), session.id, leaseInterval(ttlSeconds), session.gitBranch, session.gitHead],
    );
    await tx.query(
      `UPDATE work.sessions SET status = 'completed', continued_by = $2, state = jsonb_set(state, '{status}', '"completed"'),
              summary = COALESCE(summary, $3), lease_device = NULL, lease_user = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1`,
      [session.id, childId, `Continued by ${user.email} in ${childId}`],
    );
    resumed = (await getSession(tx, childId))!;
  }
  await audit(tx, {
    action: forced && session.leaseLive ? 'session.resume_forced' : 'session.resume',
    actorUserId: user.id,
    orgId: project.orgId,
    projectId: project.id,
    deviceId,
    targetType: 'session',
    targetId: session.id,
    detail: { continuation: sameUser ? 'same_session' : 'child_session', resumedAs: resumed.id },
  });

  const chain = [session.id, ...(session.parentSessionId ? [session.parentSessionId] : [])];
  const decisionIds = session.state.decisions.map((ref) => ref.id);
  const decisions = await tx.query<{ id: string; title: string; content: string; confidence: string; related_files: string[] }>(
    `SELECT id, title, content, confidence, related_files FROM memory.memories
      WHERE project_id = $1 AND deleted_at IS NULL
        AND (id = ANY ($2::text[]) OR (session_id = ANY ($3::text[]) AND category = 'architecture_decision'))
      ORDER BY updated_at DESC LIMIT 20`,
    [project.id, decisionIds, chain],
  );
  const decisionFiles = decisions.flatMap((decision) => decision.related_files ?? []);
  const snapshotId = session.state.workspaceSnapshotId;
  const [snapshot] = snapshotId
    ? await tx.query<ResumeSnapshot>(
      `SELECT id, manifest_sha256 AS "manifestSha256", base_commit AS "baseCommit", branch, file_count AS "fileCount",
              total_bytes::float8 AS "totalBytes", pinned, created_at AS "createdAt"
         FROM work.snapshots WHERE id = $1 AND project_id = $2`,
      [snapshotId, project.id],
    )
    : [];
  const hints = resumeHints(session.state, decisionFiles);
  return {
    session: resumed,
    resumedFrom: session.id,
    continuation: sameUser ? 'same_session' : 'child_session',
    state: resumed.state,
    brief: buildHandoffBrief(session.state, decisionFiles),
    decisions: decisions.map((decision) => ({ id: decision.id, title: decision.title, summary: decision.content.slice(0, 280), confidence: decision.confidence })),
    filesToRead: hints.filesToRead,
    doNotRedo: hints.doNotRedo,
    nextAction: hints.nextAction,
    nextActionInferred: hints.nextActionInferred,
    lastCheckpoint: session.state.lastCheckpoint,
    snapshot: snapshot ?? null,
  };
}
