/**
 * Baton session continuity tools for the local MCP server (docs/baton/API.md §2):
 * session_checkpoint, session_handoff, session_list, session_resume,
 * session_finish. `baton_session_start` creates the session state.
 *
 * First tool module outside src/server.ts: it receives the few pieces of
 * connection state it needs through `SessionToolContext` instead of reading
 * server.ts closures, which is the pattern for splitting the rest.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { LIVE_STATUSES, type SessionState } from '../../domain/session.js';
import { LocalSessionStore } from '../../session/local-store.js';
import * as service from '../../session/service.js';

export interface SessionToolContext {
  dataDir: () => string;
  project: () => { id: string; rootPath: string };
  /** The session this MCP connection opened or resumed, if any. */
  connectionSessionId: () => string | undefined;
  setConnectionSessionId: (id: string | undefined) => void;
  /** Create the Baton session row for a resumed session so memory written next is attributed to it. */
  openBatonSession: (sessionId: string, agent?: string) => Promise<void>;
  /** Process whose death means the agent is gone (the stdio server lives as long as its agent). */
  agentPid: number;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: true };

function text(value: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: value }], ...(structured ? { structuredContent: structured } : {}) };
}

function failure(error: unknown): ToolResult {
  return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
}

const stepList = z.array(z.string().min(1).max(500)).max(50);
const updateShape = {
  sessionId: z.string().optional().describe('Session id; defaults to the session this connection started or resumed'),
  task: z.string().max(2000).optional(),
  objective: z.string().max(4000).optional(),
  completed: stepList.optional().describe('Steps finished since the last update (remove them from pending)'),
  pending: stepList.optional().describe('Steps still to do'),
  replacePending: z.boolean().optional().describe('Replace the pending list instead of appending'),
  next: z.string().max(1000).optional().describe('The single concrete next action'),
  progress: z.string().max(2000).optional().describe('One-paragraph progress summary'),
  percent: z.number().min(0).max(100).optional(),
  problems: z.array(z.object({ text: z.string().max(1000), status: z.enum(['open', 'worked_around', 'resolved']) })).max(30).optional(),
  decisions: z.array(z.object({ id: z.string(), title: z.string() })).max(30).optional().describe('Memories (architecture decisions) this session relies on'),
};

type UpdateArgs = { sessionId?: string } & service.SessionUpdate;

export function registerSessionTools(server: McpServer, ctx: SessionToolContext): void {
  const store = () => new LocalSessionStore(ctx.dataDir());
  const resolveId = (local: LocalSessionStore, explicit?: string): string => {
    const id = explicit ?? ctx.connectionSessionId();
    if (id) return id;
    const [live] = local.list({ projectId: ctx.project().id, statuses: LIVE_STATUSES, deviceOnly: true });
    if (!live) throw new Error('No active session: call baton_session_start or session_resume first.');
    return live.id;
  };
  const updateFrom = (args: UpdateArgs): service.SessionUpdate => {
    const { sessionId: _sessionId, ...update } = args;
    return update;
  };

  server.registerTool('session_checkpoint', {
    title: 'Session Checkpoint',
    description:
      'Save the state of the current task so anyone can continue it if this session stops: what is done, what is pending, ' +
      'the next action and open problems. The working copy (branch, HEAD, changed files) is recorded automatically. ' +
      'Call it after finishing a meaningful step; file changes are also checkpointed by the Baton daemon without you.',
    inputSchema: updateShape,
  }, async (args) => {
    try {
      const local = store();
      const sessionId = resolveId(local, args.sessionId);
      const checkpoint = service.checkpointSession(local, sessionId, 'manual', updateFrom(args));
      const flush = await service.flushOutbox(local);
      return text(
        `Checkpoint ${checkpoint.seq} saved for ${sessionId}${flush.offline ? ' (Baton server unreachable — queued)' : ''}.`,
        { sessionId, checkpoint: { id: checkpoint.id, seq: checkpoint.seq }, queued: flush.pending },
      );
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('session_handoff', {
    title: 'Session Handoff',
    description:
      'Hand the current task to another developer, agent or model: saves a final checkpoint, builds a handoff brief ' +
      '(done, next action, pending, decisions, problems, workspace, files to read, what not to redo) and releases the session ' +
      'so it can be resumed with session_resume. Provide `next` unless a next action or pending step is already recorded.',
    inputSchema: { ...updateShape, to: z.string().email().optional().describe('Reserve the session for this user for 24h') },
  }, async (args) => {
    try {
      const local = store();
      const sessionId = resolveId(local, args.sessionId);
      const current = local.get(sessionId);
      if (!args.next && !current?.state.nextAction && !current?.state.pendingSteps.length && !args.pending?.length) {
        throw new Error('A handoff needs a next action: pass `next` (one concrete action).');
      }
      const { to, ...rest } = args;
      const result = service.handoffSession(local, sessionId, { ...updateFrom(rest), ...(to ? { to } : {}) });
      const flush = await service.flushOutbox(local);
      if (ctx.connectionSessionId() === sessionId) ctx.setConnectionSessionId(undefined);
      const rejected = flush.rejected.filter((item) => item.sessionId === sessionId);
      const status = rejected.length
        ? `The Baton server refused the handoff: ${rejected.map((item) => item.error).join('; ')}`
        : flush.offline ? 'Saved locally; delivered on the next successful sync.' : `Handed off. Resume elsewhere with session_resume("${sessionId}").`;
      return text(`${result.brief}\n\n${status}`, { sessionId, brief: result.brief, delivered: !flush.offline && !rejected.length });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('session_list', {
    title: 'Session List',
    description: 'List sessions of this project that can be resumed (handed off, interrupted or stopped without handoff). Pass all=true for every session.',
    inputSchema: { all: z.boolean().optional() },
  }, async ({ all }) => {
    try {
      const project = ctx.project();
      const { sessions, offline } = await service.listProjectSessions(store(), { projectId: project.id, projectRoot: project.rootPath, all });
      const lines = sessions.map((session) => `- ${session.id} [${session.status}] ${session.task || '(no task)'} — ${session.agent ?? '?'}${session.userEmail ? `, ${session.userEmail}` : ''}, ${session.updatedAt}`);
      return text(
        [sessions.length ? lines.join('\n') : 'No resumable sessions.', ...(offline ? ['(Baton server unreachable: this device only)'] : [])].join('\n'),
        { sessions, offline },
      );
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('session_resume', {
    title: 'Session Resume',
    description:
      'Continue a session someone else (or you, elsewhere) started: returns the Resume Package — handoff brief, decisions, ' +
      'files to read first, completed steps not to redo and the next action — and makes it this connection\'s session. ' +
      'Uncommitted work from the session is restored into a NEW git worktree by default (your current files are never touched); ' +
      'continue the work in the returned `workspace` path. restore="none" skips it.',
    inputSchema: {
      sessionId: z.string().min(1),
      restore: z.enum(['worktree', 'none']).optional().describe('worktree (default): restore uncommitted work into a new worktree; none: state only'),
      agent: z.string().max(100).optional().describe('Your agent name, e.g. codex'),
      model: z.string().max(100).optional(),
      modelProvider: z.string().max(100).optional(),
    },
  }, async ({ sessionId, agent, model, modelProvider, restore: restoreMode }) => {
    try {
      const project = ctx.project();
      const local = store();
      const { pkg, local: resumed, restore, restoreError } = await service.resumeSession(local, {
        projectId: project.id, projectRoot: project.rootPath, sessionId, agent, model, modelProvider, agentPid: ctx.agentPid,
        restore: restoreMode === 'none' ? { mode: 'none' } : { mode: 'worktree' },
      });
      await ctx.openBatonSession(resumed.id, agent ?? resumed.state.agent ?? undefined);
      ctx.setConnectionSessionId(resumed.id);
      const state: SessionState = pkg.state;
      const lines = [
        pkg.continuation === 'child_session' ? `You continue ${pkg.resumedFrom} as session ${resumed.id}.` : `Resumed session ${resumed.id}.`,
        '',
        pkg.brief,
        ...(pkg.decisions.length ? ['', '## Decision details', ...pkg.decisions.map((d) => `- ${d.title} [${d.confidence}] (${d.id}): ${d.summary}`)] : []),
        '',
        restore
          ? `Uncommitted work restored into ${restore.target} (branch ${restore.branch ?? 'detached'}, ${restore.written.length} file(s)${restore.conflicts.length ? `, ${restore.conflicts.length} conflict(s)` : ''}). Work there.`
          : restoreError
            ? `Uncommitted work NOT restored: ${restoreError}`
            : pkg.snapshot ? 'Uncommitted work not restored (restore="none").' : 'No uncommitted work: everything is in git on the recorded branch.',
      ];
      return text(lines.join('\n'), {
        sessionId: resumed.id,
        resumedFrom: pkg.resumedFrom,
        continuation: pkg.continuation,
        task: state.task,
        objective: state.objective,
        nextAction: pkg.nextAction,
        completedSteps: state.completedSteps.map((step) => step.text),
        pendingSteps: state.pendingSteps.map((step) => step.text),
        filesToRead: pkg.filesToRead,
        decisions: pkg.decisions,
        git: state.git,
        workspace: restore?.target ?? null,
        restore: restore ? { target: restore.target, branch: restore.branch, written: restore.written.length, conflicts: restore.conflicts, verified: restore.verified } : null,
        restoreError: restoreError ?? null,
      });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('session_finish', {
    title: 'Session Finish',
    description: 'Mark the current task completed (or failed) and release the session.',
    inputSchema: {
      sessionId: z.string().optional(),
      failed: z.boolean().optional(),
      summary: z.string().max(8000).optional(),
    },
  }, async ({ sessionId: explicit, failed, summary }) => {
    try {
      const local = store();
      const sessionId = resolveId(local, explicit);
      const finished = service.finishSession(local, sessionId, { failed, summary });
      await service.flushOutbox(local);
      if (ctx.connectionSessionId() === sessionId) ctx.setConnectionSessionId(undefined);
      return text(`Session ${sessionId} ${finished.status}.`, { sessionId, status: finished.status });
    } catch (error) {
      return failure(error);
    }
  });
}
