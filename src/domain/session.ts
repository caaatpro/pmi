/**
 * PMI session continuity domain (docs/PMI/SESSION_CONTINUITY.md): the
 * SessionState document, its statuses and transitions, and the deterministic
 * Handoff Brief. Pure functions shared by the local client, the daemon, the
 * central server and the MCP tools.
 *
 * SessionState never holds hidden model reasoning or chat transcripts — only
 * what an agent or the daemon states explicitly about the work.
 */
import { redactCredentials } from '../memory/secret-filter.js';

export const SESSION_STATUSES = [
  'created',
  'in_progress',
  'checkpointed',
  'interrupted',
  'waiting_handoff',
  'resumable',
  'completed',
  'failed',
] as const;
export type SessionStatus = typeof SESSION_STATUSES[number];

export const CHECKPOINT_TRIGGERS = ['timer', 'fs_change', 'commit', 'decision', 'manual', 'compact', 'exit', 'handoff'] as const;
export type CheckpointTrigger = typeof CHECKPOINT_TRIGGERS[number];

/** Statuses another device or user may resume from. */
export const RESUMABLE_STATUSES: readonly SessionStatus[] = ['resumable', 'interrupted', 'waiting_handoff'];
/** Statuses in which a lease is held and the daemon keeps checkpointing. */
export const LIVE_STATUSES: readonly SessionStatus[] = ['created', 'in_progress', 'checkpointed'];
export const FINAL_STATUSES: readonly SessionStatus[] = ['completed', 'failed'];

export interface Step {
  id: string;
  text: string;
  at: string;
  evidence?: string[];
}

export interface Problem {
  text: string;
  status: 'open' | 'worked_around' | 'resolved';
  ref?: string;
}

export interface Ref {
  id: string;
  title: string;
}

export interface FileChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'U';
  oldPath?: string;
}

export interface GitState {
  branch: string | null;
  head: string | null;
  unpushedCommits: string[];
  dirty: boolean;
  modifiedFiles: FileChange[];
}

export interface SessionState {
  schema: 1;
  sessionId: string;
  projectId: string;
  userId: string | null;
  deviceId: string;
  agent: string | null;
  modelProvider?: string;
  model?: string;
  status: SessionStatus;
  task: string;
  objective: string;
  progress: { percent?: number; summary: string };
  completedSteps: Step[];
  pendingSteps: Step[];
  decisions: Ref[];
  observations: Ref[];
  problems: Problem[];
  nextAction: string | null;
  git: GitState | null;
  workspaceSnapshotId: string | null;
  lastCheckpoint: { id: string; seq: number; at: string; trigger: CheckpointTrigger } | null;
  parentSessionId: string | null;
  updatedAt: string;
}

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value);
}

export function isCheckpointTrigger(value: unknown): value is CheckpointTrigger {
  return typeof value === 'string' && (CHECKPOINT_TRIGGERS as readonly string[]).includes(value);
}

export function emptySessionState(init: {
  sessionId: string;
  projectId: string;
  deviceId: string;
  userId?: string | null;
  agent?: string | null;
  modelProvider?: string;
  model?: string;
  task?: string;
  objective?: string;
  parentSessionId?: string | null;
  now?: string;
}): SessionState {
  return {
    schema: 1,
    sessionId: init.sessionId,
    projectId: init.projectId,
    userId: init.userId ?? null,
    deviceId: init.deviceId,
    agent: init.agent ?? null,
    ...(init.modelProvider ? { modelProvider: init.modelProvider } : {}),
    ...(init.model ? { model: init.model } : {}),
    status: 'created',
    task: init.task ?? '',
    objective: init.objective ?? '',
    progress: { summary: '' },
    completedSteps: [],
    pendingSteps: [],
    decisions: [],
    observations: [],
    problems: [],
    nextAction: null,
    git: null,
    workspaceSnapshotId: null,
    lastCheckpoint: null,
    parentSessionId: init.parentSessionId ?? null,
    updatedAt: init.now ?? new Date().toISOString(),
  };
}

const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  created: ['in_progress', 'checkpointed', 'interrupted', 'waiting_handoff', 'resumable', 'completed', 'failed'],
  in_progress: ['checkpointed', 'interrupted', 'waiting_handoff', 'resumable', 'completed', 'failed'],
  checkpointed: ['in_progress', 'interrupted', 'waiting_handoff', 'resumable', 'completed', 'failed'],
  interrupted: ['resumable', 'in_progress', 'completed', 'failed'],
  waiting_handoff: ['resumable', 'in_progress', 'completed', 'failed'],
  resumable: ['in_progress', 'completed', 'failed'],
  completed: [],
  failed: [],
};

/** Allowed status changes (SESSION_CONTINUITY.md §3). Restating the current status is idempotent. */
export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Status after a lease ends without handoff: resumable when there is something to resume from. */
export function statusAfterLeaseLoss(hasCheckpoint: boolean): SessionStatus {
  return hasCheckpoint ? 'resumable' : 'interrupted';
}

export const MAX_STATE_BYTES = 64 * 1024;
const MAX_LIST_ITEMS = 50;

/**
 * Keep a state document under MAX_STATE_BYTES: long step lists keep their
 * most recent entries and the dropped part is folded into the progress
 * summary, so nothing silently disappears.
 */
export function boundState(state: SessionState): SessionState {
  const bounded: SessionState = { ...state };
  const fold = (key: 'completedSteps' | 'pendingSteps' | 'observations' | 'decisions') => {
    const list = bounded[key] as unknown[];
    if (list.length <= MAX_LIST_ITEMS) return;
    const dropped = list.length - MAX_LIST_ITEMS;
    (bounded as unknown as Record<string, unknown>)[key] = key === 'pendingSteps' ? list.slice(0, MAX_LIST_ITEMS) : list.slice(-MAX_LIST_ITEMS);
    bounded.progress = { ...bounded.progress, summary: `${bounded.progress.summary}${bounded.progress.summary ? ' ' : ''}(+${dropped} earlier ${key} omitted)` };
  };
  fold('completedSteps');
  fold('pendingSteps');
  fold('observations');
  fold('decisions');
  if (bounded.git && bounded.git.modifiedFiles.length > 500) {
    bounded.git = { ...bounded.git, modifiedFiles: bounded.git.modifiedFiles.slice(0, 500) };
  }
  if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > MAX_STATE_BYTES) {
    throw new Error(`session state exceeds ${MAX_STATE_BYTES} bytes even after folding lists`);
  }
  return bounded;
}

export interface ResumeHints {
  filesToRead: string[];
  doNotRedo: string[];
  nextAction: string | null;
  nextActionInferred: boolean;
}

export function resumeHints(state: SessionState, decisionFiles: string[] = []): ResumeHints {
  const files = [
    ...(state.git?.modifiedFiles ?? []).filter((file) => file.status !== 'D').map((file) => file.path),
    ...decisionFiles,
  ];
  const nextAction = state.nextAction ?? state.pendingSteps[0]?.text ?? null;
  return {
    filesToRead: [...new Set(files)].slice(0, 10),
    doNotRedo: state.completedSteps.map((step) => step.text),
    nextAction,
    nextActionInferred: !state.nextAction && Boolean(nextAction),
  };
}

/**
 * The Handoff Brief (SESSION_CONTINUITY.md §5): a deterministic template, no
 * LLM involved, passed through the credential filter.
 */
export function buildHandoffBrief(state: SessionState, decisionFiles: string[] = []): string {
  const hints = resumeHints(state, decisionFiles);
  const git = state.git;
  const lines: string[] = [
    `# Handoff: ${state.task || '(no task recorded)'}`,
    `Objective: ${state.objective || '—'}`,
    `Status: ${state.status} · Agent: ${state.agent ?? '—'}${state.model ? ` (${state.model})` : ''}`,
    `Progress: ${state.progress.percent !== undefined ? `${state.progress.percent}% · ` : ''}${state.progress.summary || '—'}`,
    '',
    `## Done (${state.completedSteps.length})`,
    ...state.completedSteps.map((step) => `- ${step.text}${step.evidence?.length ? ` [${step.evidence.join(', ')}]` : ''}`),
    '',
    `## Next action${hints.nextActionInferred ? ' (inferred from the first pending step)' : ''}`,
    hints.nextAction ?? '—',
    '',
    `## Pending (${state.pendingSteps.length})`,
    ...state.pendingSteps.map((step) => `- ${step.text}`),
  ];
  if (state.decisions.length) lines.push('', '## Decisions', ...state.decisions.map((ref) => `- ${ref.title} (${ref.id})`));
  const open = state.problems.filter((problem) => problem.status !== 'resolved');
  if (open.length) lines.push('', '## Open problems', ...open.map((problem) => `- [${problem.status}] ${problem.text}`));
  if (git) {
    lines.push(
      '',
      '## Workspace',
      `Branch ${git.branch ?? '(detached)'} @ ${git.head?.slice(0, 12) ?? '—'}${git.dirty ? ', uncommitted changes' : ', clean'}`,
      ...git.modifiedFiles.slice(0, 30).map((file) => `- ${file.status} ${file.path}`),
      ...(git.unpushedCommits.length ? [`Unpushed commits: ${git.unpushedCommits.map((sha) => sha.slice(0, 12)).join(', ')}`] : []),
    );
    if (state.workspaceSnapshotId) lines.push(`Snapshot: ${state.workspaceSnapshotId}`);
  }
  if (hints.filesToRead.length) lines.push('', '## Files to read first', ...hints.filesToRead.map((file) => `- ${file}`));
  if (hints.doNotRedo.length) lines.push('', '## Do NOT redo', ...hints.doNotRedo.map((text) => `- ${text}`));
  return redactCredentials(lines.join('\n'));
}
