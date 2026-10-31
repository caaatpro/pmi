/**
 * Helpers shared by the inherited Memorix MCP tools (split out of src/server.ts):
 * input coercion for clients that string-encode arrays, LLM timeout budgets and
 * the PMI session continuity glue called by memorix_session_start/end.
 */
import { createHash } from 'node:crypto';
import { parseFormationTimeoutMs } from '../../server/formation-timeout.js';
import type { FormationStage } from '../../memory/formation/types.js';

// ── Timeout budgets for LLM-heavy paths ──────────────────────────
export const FORMATION_TIMEOUT_MS = parseFormationTimeoutMs(process.env.MEMORIX_FORMATION_TIMEOUT_MS); // Formation pipeline (extract+resolve+evaluate)
export const COMPACT_ON_WRITE_TIMEOUT_MS = 12_000; // Legacy compact-on-write fallback path
export const COMPRESSION_TIMEOUT_MS = 5_000;  // Narrative compression

export function formatFormationStageDurations(stageDurationsMs: Partial<Record<FormationStage, number>>): string {
  const orderedStages: FormationStage[] = ['extract', 'resolve', 'evaluate'];
  const parts = orderedStages
    .filter(stage => stageDurationsMs[stage] !== undefined)
    .map(stage => `${stage}=${stageDurationsMs[stage]}ms`);
  return parts.join(', ');
}

/** Valid observation types for input validation */
export const OBSERVATION_TYPES: [string, ...string[]] = [
  'session-request',
  'gotcha',
  'problem-solution',
  'reasoning',
  'how-it-works',
  'what-changed',
  'discovery',
  'why-it-exists',
  'decision',
  'trade-off',
  'probe',
];

/**
 * Defensive parameter coercion for Claude Code CLI + non-Anthropic models (e.g. GLM).
 * Claude Code CLI has a known bug (#5504, #26027) where JSON objects/arrays
 * get serialized as strings. GLM models amplify this by producing string-encoded
 * arrays/numbers in tool calls. These helpers ensure Memorix works regardless.
 */
export function coerceNumberArray(val: unknown): number[] {
  if (Array.isArray(val)) return val.map(Number);
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch { /* not valid JSON */ }
  }
  return [];
}

export function coerceObservationRefs(val: unknown): Array<{ id: number; projectId?: string }> {
  if (Array.isArray(val)) {
    const refs: Array<{ id: number; projectId?: string }> = [];
    for (const item of val) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const id = Number(record['id']);
      if (!Number.isFinite(id) || id <= 0) continue;

      const projectId = typeof record['projectId'] === 'string' ? record['projectId'] : undefined;
      refs.push(projectId ? { id, projectId } : { id });
    }
    return refs;
  }
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return coerceObservationRefs(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

export function coerceNumber(val: unknown, fallback: number): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = Number(val);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

export function coerceStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* not valid JSON */ }
  }
  return [];
}

export function coerceObject<T>(val: unknown): T | null {
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) return val as T;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === 'object' && parsed !== null) return parsed as T;
    } catch { /* not valid JSON */ }
  }
  return null;
}

export function coerceObjectArray<T>(val: unknown): T[] {
  if (Array.isArray(val)) {
    return val.map(item => {
      if (typeof item === 'string') {
        try { return JSON.parse(item); } catch { return item; }
      }
      return item;
    });
  }
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not valid JSON */ }
  }
  return [];
}

export function createDeterministicInstanceId(projectId: string, agentType: string, agentName?: string): string {
  const digest = createHash('sha256')
    .update(projectId)
    .update('\n')
    .update(agentType)
    .update('\n')
    .update(agentName ?? '')
    .digest('hex')
    .slice(0, 24);
  return `auto-${digest}`;
}

/** Agent formats rules can be synced to and from. */
export const RULE_SOURCES: [string, ...string[]] = ['cursor', 'claude-code', 'codex', 'windsurf', 'antigravity', 'gemini-cli', 'copilot', 'kiro', 'opencode', 'trae'];

/** Agents workspace config and skills can be written for. */
export const AGENT_TARGETS: [string, ...string[]] = ['windsurf', 'cursor', 'claude-code', 'codex', 'copilot', 'antigravity', 'gemini-cli', 'openclaw', 'hermes', 'omp', 'kiro', 'opencode', 'trae'];

export const READ_ONLY_TASK_PATTERN = /\b(?:do not|don't|never)\s+(?:modify|edit|change|write)\b|\bread[- ]only\b|(?:不要|不准|勿|禁止).{0,6}(?:修改|编辑|写入)|只读/i;

/**
 * Give a new MCP session its PMI state. The agent's pid is this stdio server
 * process: when the agent exits, so does the server, and the daemon notices.
 */
export async function startPmiContinuity(
  dataDir: string,
  project: { id: string; rootPath: string },
  sessionId: string,
  input: { agent?: string; task?: string; objective?: string; model?: string; modelProvider?: string },
): Promise<{ lines: string[] }> {
  try {
    const { LocalSessionStore } = await import('../../session/local-store.js');
    const service = await import('../../session/service.js');
    const { ensureDaemon, currentCliPath } = await import('../../session/daemon.js');
    const store = new LocalSessionStore(dataDir);
    service.startSession(store, {
      projectId: project.id,
      projectRoot: project.rootPath,
      sessionId,
      agent: input.agent ?? null,
      task: input.task,
      objective: input.objective,
      model: input.model,
      modelProvider: input.modelProvider,
      agentPid: process.pid,
    });
    const lines: string[] = [];
    if (service.connectedProject(project.rootPath)) {
      await service.flushOutbox(store);
      const pid = ensureDaemon(dataDir, currentCliPath());
      if (pid) lines.push(`PMI: automatic checkpoints on (daemon pid ${pid}).`);
      const { sessions } = await service.listProjectSessions(store, { projectId: project.id, projectRoot: project.rootPath });
      const others = sessions.filter((item) => item.id !== sessionId);
      if (others.length) {
        lines.push('PMI: sessions waiting to be continued — call session_resume(id) to pick one up:');
        for (const item of others.slice(0, 5)) lines.push(`  - ${item.id} [${item.status}] ${item.task || '(no task)'} (${item.agent ?? '?'}${item.userEmail ? `, ${item.userEmail}` : ''})`);
      }
    }
    if (!input.task) lines.push('PMI: pass `task` to memorix_session_start, then use session_checkpoint / session_handoff so others can continue this work.');
    return { lines };
  } catch (error) {
    return { lines: [`PMI session state unavailable: ${(error as Error).message}`] };
  }
}

export async function finishPmiContinuity(dataDir: string, sessionId: string, summary?: string): Promise<void> {
  try {
    const { LocalSessionStore } = await import('../../session/local-store.js');
    const { LIVE_STATUSES } = await import('../../domain/session.js');
    const service = await import('../../session/service.js');
    const store = new LocalSessionStore(dataDir);
    const session = store.get(sessionId);
    if (!session || !LIVE_STATUSES.includes(session.status)) return;
    service.finishSession(store, sessionId, { summary });
    await service.flushOutbox(store);
  } catch {
    // Ending the Memorix session must not fail on PMI bookkeeping.
  }
}
