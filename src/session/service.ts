/**
 * Client-side session continuity operations shared by the CLI, the MCP tools
 * and the daemon. Each operation writes the local store first and queues the
 * server call; `flushOutbox` delivers queued operations when the PMI server
 * is reachable, so starting, checkpointing and handing off work offline.
 */
import { createApiClient, PmiApiError, type PmiApiClient } from '../client/api.js';
import { readProjectLink, tokenFor, type ProjectLink } from '../client/config.js';
import {
  buildHandoffBrief,
  emptySessionState,
  statusAfterLeaseLoss,
  type CheckpointTrigger,
  type Problem,
  type Ref,
  type SessionState,
  type SessionStatus,
  type Step,
} from '../domain/session.js';
import { readWorkspace } from './git-state.js';
import { LocalSessionStore, newSessionId, type LocalCheckpoint, type LocalSession } from './local-store.js';

export interface SessionUpdate {
  task?: string;
  objective?: string;
  completed?: Array<string | { text: string; evidence?: string[] }>;
  pending?: string[];
  /** Replace the pending list instead of appending to it. */
  replacePending?: boolean;
  next?: string | null;
  progress?: string;
  percent?: number;
  problems?: Problem[];
  decisions?: Ref[];
  observations?: Ref[];
}

function stepId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Apply an agent/human update to a state document. Completing a step removes it from pending. */
export function applyUpdate(state: SessionState, update: SessionUpdate, now = new Date().toISOString()): SessionState {
  const next = { ...state };
  if (update.task !== undefined) next.task = update.task;
  if (update.objective !== undefined) next.objective = update.objective;
  if (update.completed?.length) {
    const done: Step[] = update.completed.map((item) => typeof item === 'string'
      ? { id: stepId(), text: item, at: now }
      : { id: stepId(), text: item.text, at: now, ...(item.evidence?.length ? { evidence: item.evidence } : {}) });
    const doneTexts = new Set(done.map((step) => step.text.trim().toLowerCase()));
    next.completedSteps = [...state.completedSteps, ...done];
    next.pendingSteps = state.pendingSteps.filter((step) => !doneTexts.has(step.text.trim().toLowerCase()));
  }
  if (update.pending) {
    const added = update.pending.map((text) => ({ id: stepId(), text, at: now }));
    next.pendingSteps = update.replacePending ? added : [...next.pendingSteps, ...added];
  }
  if (update.next !== undefined) next.nextAction = update.next;
  if (update.progress !== undefined || update.percent !== undefined) {
    next.progress = { ...state.progress, ...(update.progress !== undefined ? { summary: update.progress } : {}), ...(update.percent !== undefined ? { percent: update.percent } : {}) };
  }
  if (update.problems) next.problems = mergeBy(state.problems, update.problems, (problem) => problem.text);
  if (update.decisions) next.decisions = mergeBy(state.decisions, update.decisions, (ref) => ref.id);
  if (update.observations) next.observations = mergeBy(state.observations, update.observations, (ref) => ref.id);
  return next;
}

function mergeBy<T>(current: T[], incoming: T[], key: (item: T) => string): T[] {
  const map = new Map(current.map((item) => [key(item), item]));
  for (const item of incoming) map.set(key(item), item);
  return [...map.values()];
}

export interface StartInput {
  projectId: string;
  projectRoot: string | null;
  sessionId?: string;
  agent?: string | null;
  model?: string;
  modelProvider?: string;
  task?: string;
  objective?: string;
  agentPid?: number | null;
}

export function startSession(store: LocalSessionStore, input: StartInput): LocalSession {
  const sessionId = input.sessionId ?? newSessionId();
  const existing = store.get(sessionId);
  if (existing) return existing;
  const reading = input.projectRoot ? readWorkspace(input.projectRoot) : undefined;
  const state: SessionState = {
    ...emptySessionState({
      sessionId,
      projectId: input.projectId,
      deviceId: store.deviceId,
      agent: input.agent ?? null,
      model: input.model,
      modelProvider: input.modelProvider,
      task: input.task,
      objective: input.objective,
    }),
    status: 'in_progress',
    git: reading?.git ?? null,
  };
  const session = store.put({ state, workspaceRoot: input.projectRoot, agentPid: input.agentPid ?? null });
  // The working copy as it is now is the baseline; the daemon checkpoints changes from here.
  if (reading) store.db.prepare('UPDATE pmi_sessions SET last_fingerprint = ? WHERE id = ?').run(reading.fingerprint, sessionId);
  return store.get(session.id)!;
}

/** Record progress without a checkpoint (cheap, frequent). */
export function updateSession(store: LocalSessionStore, sessionId: string, update: SessionUpdate): LocalSession {
  return store.update(sessionId, (state) => ({
    ...applyUpdate(state, update),
    status: state.status === 'checkpointed' || state.status === 'created' ? 'in_progress' : state.status,
  }));
}

/** Immutable checkpoint with the working copy as it is now. */
export function checkpointSession(
  store: LocalSessionStore,
  sessionId: string,
  trigger: CheckpointTrigger,
  update: SessionUpdate = {},
  options: { status?: SessionStatus } = {},
): LocalCheckpoint {
  const session = store.get(sessionId);
  if (!session) throw new Error(`[pmi] unknown session ${sessionId}`);
  const reading = session.workspaceRoot ? readWorkspace(session.workspaceRoot) : undefined;
  return store.checkpoint(sessionId, trigger, {
    mutate: (state) => ({ ...applyUpdate(state, update), ...(reading ? { git: reading.git } : {}) }),
    fingerprint: reading?.fingerprint ?? null,
    status: options.status,
  });
}

export interface HandoffResult {
  checkpoint: LocalCheckpoint;
  brief: string;
  session: LocalSession;
}

/**
 * Handoff (SESSION_CONTINUITY.md §5): checkpoint with trigger `handoff`,
 * deterministic brief, then the server marks it resumable and frees the
 * lease. Requires a next action, given now or recorded earlier, or inferred
 * from the first pending step.
 */
export function handoffSession(
  store: LocalSessionStore,
  sessionId: string,
  input: SessionUpdate & { to?: string } = {},
): HandoffResult {
  const checkpoint = checkpointSession(store, sessionId, 'handoff', input, { status: 'waiting_handoff' });
  const brief = buildHandoffBrief(checkpoint.state);
  const session = store.setStatus(sessionId, 'resumable', { kind: 'handoff', payload: { brief, ...(input.to ? { to: input.to } : {}) } });
  return { checkpoint, brief, session };
}

export function finishSession(store: LocalSessionStore, sessionId: string, input: { failed?: boolean; summary?: string } = {}): LocalSession {
  const status = input.failed ? 'failed' : 'completed';
  return store.setStatus(sessionId, status, { kind: 'finish', payload: { status, ...(input.summary ? { summary: input.summary } : {}) } });
}

/**
 * The agent is gone (process died or idle too long): take a final `exit`
 * checkpoint if the working copy changed since the last one, then free the
 * session so someone else can resume it.
 */
export function releaseSession(store: LocalSessionStore, sessionId: string): LocalSession {
  const session = store.get(sessionId);
  if (!session) throw new Error(`[pmi] unknown session ${sessionId}`);
  const reading = session.workspaceRoot ? readWorkspace(session.workspaceRoot) : undefined;
  if (reading && reading.fingerprint !== session.lastFingerprint) checkpointSession(store, sessionId, 'exit');
  const hasCheckpoint = (store.get(sessionId)?.checkpointSeq ?? 0) > 0;
  return store.setStatus(sessionId, statusAfterLeaseLoss(hasCheckpoint), { kind: 'release', payload: {} });
}

export interface ConnectedProject {
  link: ProjectLink;
  api: PmiApiClient;
}

/** Server connection for a working copy, or undefined in Local mode. */
export function connectedProject(projectRoot: string | null | undefined, env: NodeJS.ProcessEnv = process.env): ConnectedProject | undefined {
  if (!projectRoot) return undefined;
  const link = readProjectLink(projectRoot);
  if (!link) return undefined;
  const token = tokenFor(link.server, env);
  if (!token) return undefined;
  return { link, api: createApiClient(link.server, token, { timeoutMs: 15_000 }) };
}

export interface FlushReport {
  sent: number;
  rejected: Array<{ sessionId: string; kind: string; error: string }>;
  pending: number;
  offline: boolean;
}

/**
 * Deliver queued operations in order. Stops at the first network failure
 * (everything stays queued); a refusal by the server (4xx) is recorded on the
 * operation and the rest continue, so one conflict never blocks a device.
 */
export async function flushOutbox(store: LocalSessionStore, env: NodeJS.ProcessEnv = process.env): Promise<FlushReport> {
  const report: FlushReport = { sent: 0, rejected: [], pending: 0, offline: false };
  const blockedSessions = new Set<string>();
  for (const op of store.pendingOps()) {
    if (blockedSessions.has(op.sessionId)) continue;
    const session = store.get(op.sessionId);
    const connection = connectedProject(session?.workspaceRoot, env);
    if (!session || !connection) {
      blockedSessions.add(op.sessionId);
      continue;
    }
    const { api, link } = connection;
    const deviceId = store.deviceId;
    try {
      switch (op.kind) {
        case 'session.upsert':
          await api.post(`/v1/projects/${link.projectId}/sessions`, { device_id: deviceId, state: op.payload.state });
          break;
        case 'checkpoint':
          await api.post(`/v1/sessions/${encodeURIComponent(op.sessionId)}/checkpoints`, {
            device_id: deviceId,
            id: op.payload.id,
            seq: op.payload.seq,
            trigger: op.payload.trigger,
            state: op.payload.state,
            created_at: op.createdAt,
          });
          break;
        case 'handoff':
          await api.post(`/v1/sessions/${encodeURIComponent(op.sessionId)}/handoff`, { device_id: deviceId, ...op.payload });
          break;
        case 'finish':
          await api.post(`/v1/sessions/${encodeURIComponent(op.sessionId)}/finish`, { device_id: deviceId, ...op.payload });
          break;
        case 'release':
          await api.post(`/v1/sessions/${encodeURIComponent(op.sessionId)}/release`, { device_id: deviceId });
          break;
      }
      store.markOp(op.id, { state: 'sent' });
      report.sent++;
    } catch (error) {
      const apiError = error instanceof PmiApiError ? error : undefined;
      if (!apiError || apiError.offline || apiError.status >= 500) {
        store.markOp(op.id, { state: 'pending', error: (error as Error).message });
        report.offline = Boolean(apiError?.offline);
        // Keep order: nothing after a failed operation of this session goes out.
        blockedSessions.add(op.sessionId);
        if (apiError?.offline) break;
        continue;
      }
      store.markOp(op.id, { state: 'rejected', error: `${apiError.code}: ${apiError.message}` });
      report.rejected.push({ sessionId: op.sessionId, kind: op.kind, error: `${apiError.code}: ${apiError.message}` });
    }
  }
  report.pending = store.countPendingOps();
  return report;
}

/** Renew the server lease of a live session; failures are reported, not thrown. */
export async function heartbeatSession(store: LocalSessionStore, sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const session = store.get(sessionId);
  const connection = connectedProject(session?.workspaceRoot, env);
  if (!session || !connection) return false;
  try {
    await connection.api.post(`/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`, { device_id: store.deviceId });
    store.markHeartbeat(sessionId);
    return true;
  } catch {
    return false;
  }
}

export interface RemoteSessionSummary {
  id: string;
  status: SessionStatus;
  task: string;
  agent: string | null;
  model?: string | null;
  userEmail?: string;
  updatedAt: string;
  lastCheckpointSeq?: number;
  parentSessionId?: string | null;
  source: 'server' | 'local';
}

/** Sessions of the project: from the server when connected, otherwise this device's local ones. */
export async function listProjectSessions(
  store: LocalSessionStore,
  input: { projectId: string; projectRoot: string | null; resumableOnly?: boolean; all?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ sessions: RemoteSessionSummary[]; offline: boolean }> {
  const connection = connectedProject(input.projectRoot, env);
  if (connection) {
    try {
      const query = input.all ? '' : input.resumableOnly === false ? '' : '?resumable=true';
      const response = await connection.api.get<{ sessions: Array<RemoteSessionSummary & Record<string, unknown>> }>(
        `/v1/projects/${connection.link.projectId}/sessions${query}`,
      );
      return {
        sessions: response.sessions.map((session) => ({
          id: session.id, status: session.status, task: session.task, agent: session.agent, model: session.model,
          userEmail: session.userEmail, updatedAt: session.updatedAt, lastCheckpointSeq: session.lastCheckpointSeq,
          parentSessionId: session.parentSessionId, source: 'server' as const,
        })),
        offline: false,
      };
    } catch (error) {
      if (!(error instanceof PmiApiError && error.offline)) throw error;
    }
  }
  const statuses: SessionStatus[] | undefined = input.all ? undefined : ['resumable', 'interrupted', 'waiting_handoff'];
  return {
    sessions: store.list({ projectId: input.projectId, statuses }).map((session) => ({
      id: session.id, status: session.status, task: session.state.task, agent: session.state.agent, model: session.state.model,
      updatedAt: session.updatedAt, lastCheckpointSeq: session.checkpointSeq, parentSessionId: session.state.parentSessionId, source: 'local' as const,
    })),
    offline: Boolean(connection),
  };
}

export interface ResumePackage {
  session: { id: string; status: SessionStatus; state: SessionState; parentSessionId: string | null; userEmail: string };
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
  snapshot: null;
}

/**
 * Resume a session from the server and make it this device's live session.
 * Local-only sessions of this device can be resumed offline.
 */
export async function resumeSession(
  store: LocalSessionStore,
  input: { projectId: string; projectRoot: string | null; sessionId: string; agent?: string; model?: string; modelProvider?: string; force?: boolean; agentPid?: number | null },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ pkg: ResumePackage; local: LocalSession }> {
  const connection = connectedProject(input.projectRoot, env);
  if (!connection) {
    const local = store.get(input.sessionId);
    if (!local) throw new Error('[pmi] session not found locally and this working copy is not linked to a PMI server');
    const resumed = store.update(input.sessionId, (state) => ({ ...state, status: 'in_progress', ...(input.agent ? { agent: input.agent } : {}) }));
    const brief = buildHandoffBrief(local.state);
    const { resumeHints } = await import('../domain/session.js');
    const hints = resumeHints(local.state);
    return {
      local: resumed,
      pkg: {
        session: { id: resumed.id, status: resumed.status, state: resumed.state, parentSessionId: resumed.state.parentSessionId, userEmail: '' },
        resumedFrom: local.id, continuation: 'same_session', state: resumed.state, brief, decisions: [],
        ...hints, lastCheckpoint: local.state.lastCheckpoint, snapshot: null,
      },
    };
  }
  // Deliver anything this device still owes the server first, so the server resumes from the latest state.
  await flushOutbox(store, env);
  const pkg = await connection.api.post<ResumePackage>(`/v1/sessions/${encodeURIComponent(input.sessionId)}/resume`, {
    device_id: store.deviceId,
    new_session_id: newSessionId(),
    ...(input.force ? { force: true } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.modelProvider ? { model_provider: input.modelProvider } : {}),
  });
  const state: SessionState = { ...pkg.session.state, projectId: input.projectId, status: 'in_progress' };
  // The server already holds this state; store it locally without queueing it back.
  const local = store.put({ state, workspaceRoot: input.projectRoot, agentPid: input.agentPid ?? null }, false);
  const reading = input.projectRoot ? readWorkspace(input.projectRoot) : undefined;
  if (reading) store.db.prepare('UPDATE pmi_sessions SET last_fingerprint = ? WHERE id = ?').run(reading.fingerprint, local.id);
  if (pkg.resumedFrom !== local.id) {
    const previous = store.get(pkg.resumedFrom);
    if (previous && previous.status !== 'completed') store.setStatus(previous.id, 'completed');
  }
  return { pkg, local: store.get(local.id)! };
}
