/**
 * Local session continuity store (SQLite, migration `pmi-2-session-continuity`).
 *
 * Every change is written here first: the session row, immutable checkpoints,
 * and an outbox of operations for the central server. Checkpoints are
 * append-only events and lease changes need the server's answer, so they do
 * not fit the row-diffing memory sync; the outbox delivers them in order once
 * the server is reachable.
 */
import { randomUUID } from 'node:crypto';

import {
  FINAL_STATUSES,
  boundState,
  canTransitionSession,
  type CheckpointTrigger,
  type SessionState,
  type SessionStatus,
} from '../domain/session.js';
import { getDatabase } from '../store/sqlite-db.js';
import { localDeviceId } from '../sync/store-port.js';

export interface LocalSession {
  id: string;
  projectId: string;
  status: SessionStatus;
  state: SessionState;
  workspaceRoot: string | null;
  deviceId: string;
  agentPid: number | null;
  lastActivityAt: string;
  lastFingerprint: string | null;
  pendingFingerprint: string | null;
  pendingSince: string | null;
  checkpointSeq: number;
  lastCheckpointAt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalCheckpoint {
  id: string;
  sessionId: string;
  seq: number;
  trigger: CheckpointTrigger;
  state: SessionState;
  createdAt: string;
}

export type OutboxKind = 'session.upsert' | 'snapshot' | 'checkpoint' | 'handoff' | 'finish' | 'release';

export interface OutboxOp {
  id: number;
  sessionId: string;
  kind: OutboxKind;
  payload: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

function rowToSession(row: any): LocalSession {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    state: JSON.parse(row.state_json),
    workspaceRoot: row.workspace_root ?? null,
    deviceId: row.device_id,
    agentPid: row.agent_pid ?? null,
    lastActivityAt: row.last_activity_at,
    lastFingerprint: row.last_fingerprint ?? null,
    pendingFingerprint: row.pending_fingerprint ?? null,
    pendingSince: row.pending_since ?? null,
    checkpointSeq: row.checkpoint_seq,
    lastCheckpointAt: row.last_checkpoint_at ?? null,
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function newSessionId(): string {
  return `ses_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export class LocalSessionStore {
  readonly db: any;
  readonly deviceId: string;

  constructor(readonly dataDir: string) {
    this.db = getDatabase(dataDir);
    this.deviceId = localDeviceId(this.db);
  }

  get(id: string): LocalSession | undefined {
    const row = this.db.prepare('SELECT * FROM pmi_sessions WHERE id = ?').get(id);
    return row ? rowToSession(row) : undefined;
  }

  list(filter: { projectId?: string; statuses?: readonly SessionStatus[]; deviceOnly?: boolean } = {}): LocalSession[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) { where.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.statuses?.length) { where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`); params.push(...filter.statuses); }
    if (filter.deviceOnly) { where.push('device_id = ?'); params.push(this.deviceId); }
    const sql = `SELECT * FROM pmi_sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`;
    return this.db.prepare(sql).all(...params).map(rowToSession);
  }

  /** Create or replace a session row (start, resume) and queue its upsert for the server. */
  put(input: { state: SessionState; workspaceRoot: string | null; agentPid: number | null }, queue = true): LocalSession {
    const now = new Date().toISOString();
    const state = boundState({ ...input.state, deviceId: this.deviceId, updatedAt: now });
    const existing = this.get(state.sessionId);
    const write = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO pmi_sessions (id, project_id, status, state_json, workspace_root, device_id, agent_pid,
                                  last_activity_at, checkpoint_seq, created_at, updated_at)
        VALUES (@id, @project_id, @status, @state_json, @workspace_root, @device_id, @agent_pid, @now, @seq, @now, @now)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status, state_json = excluded.state_json, workspace_root = excluded.workspace_root,
          device_id = excluded.device_id, agent_pid = excluded.agent_pid, last_activity_at = excluded.last_activity_at,
          checkpoint_seq = MAX(pmi_sessions.checkpoint_seq, excluded.checkpoint_seq), updated_at = excluded.updated_at
      `).run({
        id: state.sessionId,
        project_id: state.projectId,
        status: state.status,
        state_json: JSON.stringify(state),
        workspace_root: input.workspaceRoot,
        device_id: this.deviceId,
        agent_pid: input.agentPid,
        now,
        seq: state.lastCheckpoint?.seq ?? existing?.checkpointSeq ?? 0,
      });
      if (queue) this.enqueue(state.sessionId, 'session.upsert', { state });
    });
    write();
    return this.get(state.sessionId)!;
  }

  /** Apply agent-provided changes to the state without creating a checkpoint. */
  update(id: string, mutate: (state: SessionState) => SessionState): LocalSession {
    const current = this.require(id);
    const now = new Date().toISOString();
    const next = boundState({ ...mutate(structuredClone(current.state)), updatedAt: now });
    this.assertTransition(current.status, next.status);
    this.db.prepare('UPDATE pmi_sessions SET status = ?, state_json = ?, last_activity_at = ?, updated_at = ? WHERE id = ?')
      .run(next.status, JSON.stringify(next), now, now, id);
    return this.require(id);
  }

  touch(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE pmi_sessions SET last_activity_at = ? WHERE id = ?').run(now, id);
  }

  setFingerprintTracking(id: string, fields: { pendingFingerprint: string | null; pendingSince: string | null }): void {
    this.db.prepare('UPDATE pmi_sessions SET pending_fingerprint = ?, pending_since = ? WHERE id = ?')
      .run(fields.pendingFingerprint, fields.pendingSince, id);
  }

  markHeartbeat(id: string): void {
    this.db.prepare('UPDATE pmi_sessions SET last_heartbeat_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  /**
   * Record an immutable checkpoint of the current state (optionally changed by
   * `mutate`), advance the session, and queue the checkpoint for the server.
   */
  checkpoint(
    id: string,
    trigger: CheckpointTrigger,
    options: { mutate?: (state: SessionState) => SessionState; fingerprint?: string | null; status?: SessionStatus } = {},
  ): LocalCheckpoint {
    const run = this.db.transaction(() => {
      const current = this.require(id);
      if (FINAL_STATUSES.includes(current.status)) throw new Error(`[pmi] session cannot move from ${current.status}: it is closed`);
      const now = new Date().toISOString();
      const seq = current.checkpointSeq + 1;
      const checkpointId = `${id}:${seq}`;
      const base = options.mutate ? options.mutate(structuredClone(current.state)) : structuredClone(current.state);
      const status = options.status ?? (base.status === 'created' || base.status === 'in_progress' ? 'checkpointed' : base.status);
      this.assertTransition(current.status, status);
      const state = boundState({ ...base, status, lastCheckpoint: { id: checkpointId, seq, at: now, trigger }, updatedAt: now });
      this.db.prepare(`INSERT INTO session_checkpoints (id, session_id, seq, trigger, state_json, fingerprint, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`).run(checkpointId, id, seq, trigger, JSON.stringify(state), options.fingerprint ?? null, now);
      this.db.prepare(`UPDATE pmi_sessions SET status = ?, state_json = ?, checkpoint_seq = ?, last_checkpoint_at = ?,
                              last_fingerprint = COALESCE(?, last_fingerprint), pending_fingerprint = NULL, pending_since = NULL,
                              updated_at = ? WHERE id = ?`)
        .run(status, JSON.stringify(state), seq, now, options.fingerprint ?? null, now, id);
      this.enqueue(id, 'checkpoint', { id: checkpointId, seq, trigger, state });
      return { id: checkpointId, sessionId: id, seq, trigger, state, createdAt: now };
    });
    return run();
  }

  checkpoints(id: string): LocalCheckpoint[] {
    return this.db.prepare('SELECT * FROM session_checkpoints WHERE session_id = ? ORDER BY seq').all(id).map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      trigger: row.trigger,
      state: JSON.parse(row.state_json),
      createdAt: row.created_at,
    }));
  }

  /** Move to a status without a checkpoint (finish, release) and queue the matching server operation. */
  setStatus(id: string, status: SessionStatus, op?: { kind: OutboxKind; payload: Record<string, unknown> }): LocalSession {
    const run = this.db.transaction(() => {
      const current = this.require(id);
      this.assertTransition(current.status, status);
      const now = new Date().toISOString();
      const state = { ...current.state, status, updatedAt: now };
      this.db.prepare('UPDATE pmi_sessions SET status = ?, state_json = ?, updated_at = ? WHERE id = ?').run(status, JSON.stringify(state), now, id);
      if (op) this.enqueue(id, op.kind, op.payload);
    });
    run();
    return this.require(id);
  }

  enqueue(sessionId: string, kind: OutboxKind, payload: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO session_outbox (session_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, kind, JSON.stringify(payload), new Date().toISOString());
  }

  pendingOps(limit = 200): OutboxOp[] {
    return this.db.prepare("SELECT * FROM session_outbox WHERE state = 'pending' ORDER BY id LIMIT ?").all(limit).map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
      attempts: row.attempts,
      lastError: row.last_error ?? null,
      createdAt: row.created_at,
    }));
  }

  countPendingOps(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM session_outbox WHERE state = 'pending'").get() as { n: number }).n;
  }

  markOp(id: number, result: { state: 'sent' | 'rejected' | 'pending'; error?: string }): void {
    this.db.prepare(`UPDATE session_outbox SET state = ?, attempts = attempts + 1, last_error = ?,
                     sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END WHERE id = ?`)
      .run(result.state, result.error ?? null, result.state, new Date().toISOString(), id);
  }

  rejectedOps(sessionId?: string): OutboxOp[] {
    const rows = sessionId
      ? this.db.prepare("SELECT * FROM session_outbox WHERE state = 'rejected' AND session_id = ? ORDER BY id").all(sessionId)
      : this.db.prepare("SELECT * FROM session_outbox WHERE state = 'rejected' ORDER BY id").all();
    return rows.map((row: any) => ({ id: row.id, sessionId: row.session_id, kind: row.kind, payload: JSON.parse(row.payload_json), attempts: row.attempts, lastError: row.last_error, createdAt: row.created_at }));
  }

  private require(id: string): LocalSession {
    const session = this.get(id);
    if (!session) throw new Error(`[pmi] unknown session ${id}`);
    return session;
  }

  private assertTransition(from: SessionStatus, to: SessionStatus): void {
    if (!canTransitionSession(from, to)) throw new Error(`[pmi] session cannot move from ${from} to ${to}`);
  }
}
