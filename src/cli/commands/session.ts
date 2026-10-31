import { defineCommand } from 'citty';
import { startSession, endSession, getSessionContext, listSessions } from '../../memory/session.js';
import { AGENT_TYPE_ROLE_MAP, computeWatermark } from '../../team/team-store.js';
import { withFreshIndex } from '../../memory/freshness.js';
import { getAllObservations } from '../../memory/observations.js';
import { getObservationStore } from '../../store/obs-store.js';
import { filterReadableObservations } from '../../memory/visibility.js';
import { saveCliIdentity } from '../identity.js';
import { emitError, emitResult, getCliProjectContext, parsePositiveInt } from './operator-shared.js';
import { LIVE_STATUSES } from '../../domain/session.js';
import type { LocalSessionStore } from '../../session/local-store.js';

/** `a; b; c` → ['a', 'b', 'c'] for list-valued flags. */
function splitList(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.split(';').map((item) => item.trim()).filter(Boolean);
}

/** The session a command refers to: --sessionId, else this device's most recent live session in the project. */
function currentSessionId(store: LocalSessionStore, projectId: string, explicit: unknown): string {
  if (typeof explicit === 'string' && explicit) return explicit;
  const [live] = store.list({ projectId, statuses: LIVE_STATUSES, deviceOnly: true });
  if (!live) throw new Error('no active PMI session on this device for this project; pass --sessionId or run `pmi session start`');
  return live.id;
}

export default defineCommand({
  meta: {
    name: 'session',
    description: 'Manage coding sessions from the CLI operator surface',
  },
  args: {
    agent: { type: 'string', description: 'Agent/client name (for example codex or windsurf)' },
    agentType: { type: 'string', description: 'Stable agent type used for role mapping' },
    instanceId: { type: 'string', description: 'Stable instance identity across restarts' },
    projectRoot: { type: 'string', description: 'Absolute project root used to bind the session context' },
    joinTeam: { type: 'boolean', description: 'Explicitly join orchestration coordination state for this session' },
    use: { type: 'boolean', description: 'Make the joined coordination identity active for later CLI commands' },
    role: { type: 'string', description: 'Explicit role override used only when --joinTeam is set' },
    sessionId: { type: 'string', description: 'Custom session ID (optional)' },
    summary: { type: 'string', description: 'Structured session summary for session end' },
    limit: { type: 'string', description: 'How many recent sessions to include' },
    task: { type: 'string', description: 'PMI: what this session is doing' },
    objective: { type: 'string', description: 'PMI: when the task counts as done' },
    model: { type: 'string', description: 'PMI: model used by the agent (e.g. gpt-5, claude-opus)' },
    modelProvider: { type: 'string', description: 'PMI: model provider (e.g. openai, anthropic)' },
    done: { type: 'string', description: 'PMI: completed steps, separated by ";"' },
    pending: { type: 'string', description: 'PMI: pending steps, separated by ";"' },
    next: { type: 'string', description: 'PMI: the single next action' },
    progress: { type: 'string', description: 'PMI: progress summary' },
    percent: { type: 'string', description: 'PMI: progress percent' },
    problem: { type: 'string', description: 'PMI: open problems, separated by ";"' },
    to: { type: 'string', description: 'PMI handoff: reserve the session for this user (email)' },
    failed: { type: 'boolean', description: 'PMI finish: mark the session failed' },
    force: { type: 'boolean', description: 'PMI resume: take over a live session (maintainer)' },
    all: { type: 'boolean', description: 'PMI list: every status, not only resumable ones' },
    worktree: { type: 'string', description: 'PMI resume: restore the working copy into this new worktree path' },
    'in-place': { type: 'boolean', description: 'PMI resume: restore into this working copy (clean, same HEAD only)' },
    'no-restore': { type: 'boolean', description: 'PMI resume: take over the session without restoring files' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON output' },
  },
  run: async ({ args }) => {
    const action = (args._ as string[])?.[0] || '';
    const asJson = !!args.json;

    try {
      const { project, dataDir, teamStore, reader } = await getCliProjectContext({
        projectRoot: args.projectRoot as string | undefined,
      });

      switch (action) {
        case 'start': {
          if (args.use && !args.joinTeam) {
            emitError('use requires --joinTeam when starting a session.', asJson);
            return;
          }
          if (args.use && !args.agent && !args.agentType) {
            emitError('use requires --agent or --agentType so Memorix can activate a coordination identity.', asJson);
            return;
          }
          const shouldJoinTeam = !!args.joinTeam;
          let agentRecord: ReturnType<typeof teamStore.registerAgent> | null = null;
          let teamJoinNotice: string | null = null;
          const agentType = (args.agentType as string | undefined) || (args.agent as string | undefined);
          if (shouldJoinTeam && (args.agent || agentType)) {
            const resolvedType = agentType || 'unknown';
            const resolvedRole =
              (args.role as string | undefined) ||
              AGENT_TYPE_ROLE_MAP[resolvedType] ||
              'engineer';
            agentRecord = teamStore.registerAgent({
              projectId: project.id,
              agentType: resolvedType,
              instanceId: args.instanceId as string | undefined,
              name: (args.agent as string | undefined) || agentType,
              role: resolvedRole,
            });
          } else if (shouldJoinTeam) {
            teamJoinNotice = 'Coordination join skipped: provide --agent or --agentType to create a coordination identity.';
          }

          const contextReader = agentRecord
            ? {
                projectId: project.id,
                agentId: agentRecord.agent_id,
                isTeamMember: agentRecord.status === 'active',
              }
            : reader;
          const result = await startSession(dataDir, project.id, {
            sessionId: args.sessionId as string | undefined,
            agent: args.agent as string | undefined,
            reader: contextReader,
          });
          const pmiSession = await startPmiSession(dataDir, project, result.session.id, args);

          let identityActivated = false;
          if (args.use && agentRecord) {
            await saveCliIdentity(dataDir, {
              agentId: agentRecord.agent_id,
              projectId: project.id,
              activatedAt: new Date().toISOString(),
            });
            identityActivated = true;
          }

          let watermark = computeWatermark(0, 0, 0);
          let rescuedAgentIds: string[] = [];

          if (agentRecord) {
            const lastSeen = agentRecord.last_seen_obs_generation;
            const store = getObservationStore();
            const currentGen = store.getGeneration();
            const projectObs = await withFreshIndex(() =>
              filterReadableObservations(
                getAllObservations().filter(
                  (obs) => obs.projectId === project.id && (obs.writeGeneration ?? 0) > lastSeen,
                ),
                { projectId: project.id, agentId: agentRecord.agent_id, isTeamMember: agentRecord.status === 'active' },
              ),
            );
            watermark = computeWatermark(lastSeen, currentGen, projectObs.length);
            teamStore.updateWatermark(agentRecord.agent_id, currentGen);
            rescuedAgentIds = teamStore.detectAndMarkStale(project.id, 5 * 60 * 1000);
          }

          const payload = {
            project,
            session: result.session,
            pmi: pmiSession,
            agent: agentRecord
              ? {
                  agentId: agentRecord.agent_id,
                  instanceId: agentRecord.instance_id,
                  name: agentRecord.name,
                  agentType: agentRecord.agent_type,
                  role: agentRecord.role,
                }
              : null,
            teamJoin: {
              requested: shouldJoinTeam,
              joined: !!agentRecord,
              notice: teamJoinNotice,
            },
            identityActivated,
            watermark,
            rescue: {
              staleAgents: rescuedAgentIds,
            },
            previousContext: result.previousContext,
          };

          const textLines = [
            shouldJoinTeam && agentRecord
              ? `Session started with coordination identity: ${result.session.id}`
              : `Lightweight session started: ${result.session.id}`,
            `Project: ${project.name} (${project.id})`,
            agentRecord
              ? `Agent: ${agentRecord.name} [${agentRecord.agent_type}] as ${agentRecord.role} (${agentRecord.agent_id})`
              : '',
            identityActivated ? 'CLI identity activated for follow-up memory and coordination commands.' : '',
            !agentRecord ? 'Coordination identity: not joined (memory/session context only)' : '',
            teamJoinNotice ?? '',
            agentRecord && watermark.newObservationCount > 0
              ? `${watermark.newObservationCount} new observation(s) since your last session`
              : '',
            agentRecord && rescuedAgentIds.length > 0
              ? `Marked ${rescuedAgentIds.length} inactive agent(s) as left`
              : '',
            pmiSession.resumable.length
              ? `Resumable sessions in this project: ${pmiSession.resumable.map((item) => `${item.id} (${item.task || 'no task'})`).join(', ')} — continue one with: pmi session resume <id>`
              : '',
            pmiSession.daemonPid ? `PMI daemon: checkpoints run automatically (pid ${pmiSession.daemonPid})` : '',
            '',
            result.previousContext || 'No previous session context found.',
          ].filter(Boolean);

          emitResult(payload, textLines.join('\n'), asJson);
          return;
        }

        case 'checkpoint':
        case 'handoff':
        case 'list':
        case 'resume':
        case 'finish':
        case 'show': {
          const { LocalSessionStore } = await import('../../session/local-store.js');
          const service = await import('../../session/service.js');
          const store = new LocalSessionStore(dataDir);
          const update = {
            ...(args.task ? { task: String(args.task) } : {}),
            ...(args.objective ? { objective: String(args.objective) } : {}),
            ...(splitList(args.done) ? { completed: splitList(args.done)! } : {}),
            ...(splitList(args.pending) ? { pending: splitList(args.pending)! } : {}),
            ...(args.next ? { next: String(args.next) } : {}),
            ...(args.progress ? { progress: String(args.progress) } : {}),
            ...(args.percent ? { percent: Number(args.percent) } : {}),
            ...(splitList(args.problem) ? { problems: splitList(args.problem)!.map((text) => ({ text, status: 'open' as const })) } : {}),
          };

          if (action === 'list') {
            const { sessions, offline } = await service.listProjectSessions(store, {
              projectId: project.id, projectRoot: project.rootPath, all: Boolean(args.all),
            });
            const lines = sessions.length
              ? sessions.map((session) => `${session.id}  ${session.status.padEnd(15)} ${session.agent ?? '-'}${session.model ? `/${session.model}` : ''}  ${session.userEmail ?? ''}  ${session.task || '(no task)'}  · checkpoints ${session.lastCheckpointSeq ?? 0} · ${session.updatedAt}`)
              : [args.all ? 'No sessions.' : 'No resumable sessions.'];
            if (offline) lines.push('', 'Server unreachable: showing this device\'s sessions only.');
            emitResult({ project: project.id, offline, sessions }, lines.join('\n'), asJson);
            return;
          }

          if (action === 'resume') {
            const sessionId = (args._ as string[])[1] ?? (args.sessionId as string | undefined);
            if (!sessionId) {
              emitError('usage: pmi session resume <session-id> [--agent codex --model gpt-5] [--force]', asJson);
              return;
            }
            const { pkg, local, restore, restoreError } = await service.resumeSession(store, {
              projectId: project.id,
              projectRoot: project.rootPath,
              sessionId,
              agent: args.agent as string | undefined,
              model: args.model as string | undefined,
              modelProvider: args.modelProvider as string | undefined,
              force: Boolean(args.force),
              restore: args['no-restore']
                ? { mode: 'none' }
                : args['in-place'] ? { mode: 'in-place' } : { mode: 'worktree', ...(args.worktree ? { worktreePath: String(args.worktree) } : {}) },
            });
            const { renderRestore } = await import('./workspace.js');
            await startSession(dataDir, project.id, { sessionId: local.id, agent: (args.agent as string | undefined) ?? local.state.agent ?? undefined, reader });
            const { ensureDaemon, currentCliPath } = await import('../../session/daemon.js');
            if (service.connectedProject(project.rootPath)) ensureDaemon(dataDir, currentCliPath());
            const text = [
              pkg.continuation === 'child_session'
                ? `Continuing ${pkg.resumedFrom} as your session ${local.id}`
                : `Resumed session ${local.id}`,
              '',
              pkg.brief,
              ...(pkg.decisions.length ? ['', '## Decision details', ...pkg.decisions.map((d) => `- ${d.title} [${d.confidence}]: ${d.summary}`)] : []),
              '',
              restore
                ? `${renderRestore(restore)}\nContinue in: ${restore.target}`
                : restoreError
                  ? `Working copy NOT restored: ${restoreError}\nRetry with: pmi workspace restore ${pkg.snapshot?.id} [--worktree <path>]`
                  : pkg.snapshot
                    ? `Working copy not restored (--no-restore). Restore later with: pmi workspace restore ${pkg.snapshot.id}`
                    : 'No uncommitted work to restore: the session\'s changes are in git (check out the branch above).',
            ].join('\n');
            emitResult({ project: project.id, sessionId: local.id, ...pkg, restore: restore ?? null, restoreError: restoreError ?? null }, text, asJson);
            if (restoreError || (restore && !restore.verified)) process.exitCode = 2;
            return;
          }

          const sessionId = currentSessionId(store, project.id, args.sessionId);

          if (action === 'show') {
            const local = store.get(sessionId);
            if (!local) {
              emitError(`session ${sessionId} is not on this device`, asJson);
              return;
            }
            const { buildHandoffBrief } = await import('../../domain/session.js');
            emitResult({ session: local, checkpoints: store.checkpoints(sessionId).map(({ state: _s, ...rest }) => rest), outbox: store.countPendingOps() }, buildHandoffBrief(local.state), asJson);
            return;
          }

          if (action === 'checkpoint') {
            const checkpoint = service.checkpointSession(store, sessionId, 'manual', update);
            const flush = await service.flushOutbox(store);
            emitResult(
              { sessionId, checkpoint: { id: checkpoint.id, seq: checkpoint.seq }, flush },
              `Checkpoint ${checkpoint.seq} saved for ${sessionId}${flush.offline ? ' (server unreachable, queued)' : ''}`,
              asJson,
            );
            if (flush.offline) process.exitCode = 3;
            return;
          }

          if (action === 'handoff') {
            const local = store.get(sessionId);
            if (!update.next && !local?.state.nextAction && !local?.state.pendingSteps.length) {
              emitError('a handoff needs a next action: pass --next "..." (or record pending steps first)', asJson);
              return;
            }
            const result = service.handoffSession(store, sessionId, { ...update, ...(args.to ? { to: String(args.to) } : {}) });
            await endSession(dataDir, sessionId, result.brief);
            const flush = await service.flushOutbox(store);
            const delivered = !flush.offline && !flush.rejected.some((item) => item.sessionId === sessionId);
            emitResult(
              { sessionId, checkpoint: { id: result.checkpoint.id, seq: result.checkpoint.seq }, brief: result.brief, delivered, flush },
              [result.brief, '', delivered
                ? `Handed off ${sessionId}. Continue elsewhere with: pmi session resume ${sessionId}`
                : flush.offline
                  ? 'Saved locally; the handoff completes on the next successful sync (server unreachable).'
                  : `The server refused the handoff: ${flush.rejected.map((item) => item.error).join('; ')}`].join('\n'),
              asJson,
            );
            if (flush.offline) process.exitCode = 3;
            else if (!delivered) process.exitCode = 2;
            return;
          }

          // finish
          const finished = service.finishSession(store, sessionId, { failed: Boolean(args.failed), summary: args.summary as string | undefined });
          await endSession(dataDir, sessionId, args.summary as string | undefined);
          const flush = await service.flushOutbox(store);
          emitResult({ sessionId, status: finished.status, flush }, `Session ${sessionId} ${finished.status}.`, asJson);
          if (flush.offline) process.exitCode = 3;
          return;
        }
        case 'end': {
          const sessionId = args.sessionId as string | undefined;
          if (!sessionId) {
            emitError('sessionId is required for "memorix session end"', asJson);
            return;
          }
          const session = await endSession(dataDir, sessionId, args.summary as string | undefined);
          const { LocalSessionStore } = await import('../../session/local-store.js');
          const pmiStore = new LocalSessionStore(dataDir);
          const live = pmiStore.get(sessionId);
          if (live && LIVE_STATUSES.includes(live.status)) {
            const service = await import('../../session/service.js');
            service.finishSession(pmiStore, sessionId, { summary: args.summary as string | undefined });
            await service.flushOutbox(pmiStore);
          }
          if (!session) {
            emitError(`Session "${sessionId}" not found`, asJson);
            return;
          }
          emitResult(
            { project, session },
            `Session completed: ${session.id}`,
            asJson,
          );
          return;
        }

        case 'context': {
          const limit = parsePositiveInt(args.limit as string | undefined, 3);
          const [context, sessions] = await Promise.all([
            getSessionContext(dataDir, project.id, limit, reader),
            listSessions(dataDir, project.id),
          ]);
          const active = sessions.filter((session) => session.status === 'active').length;
          const completed = sessions.filter((session) => session.status === 'completed').length;
          emitResult(
            {
              project,
              stats: { active, completed, total: sessions.length },
              context,
            },
            [`Session stats: ${active} active / ${completed} completed`, '', context || 'No prior session context.'].join('\n'),
            asJson,
          );
          return;
        }

        default:
          console.log('Memorix Session Commands');
          console.log('');
          console.log('Usage:');
          console.log('  memorix session start [--agent codex --agentType codex --instanceId abc] [--projectRoot <path>] [--joinTeam --use]');
          console.log('  memorix session end --sessionId <id> [--summary "..."]');
          console.log('  memorix session context [--limit 3]');
          console.log('');
          console.log('PMI session continuity:');
          console.log('  pmi session start --agent codex [--model gpt-5] [--task "..."] [--objective "..."]');
          console.log('  pmi session checkpoint [--done "a; b"] [--pending "c"] [--next "..."] [--progress "..."]');
          console.log('  pmi session handoff [--next "..."] [--to user@example.com]');
          console.log('  pmi session list [--all]');
          console.log('  pmi session resume <session-id> [--agent codex --model gpt-5] [--worktree <path> | --in-place | --no-restore] [--force]');
          console.log('  pmi session finish [--failed] [--summary "..."]');
          console.log('  pmi session show [--sessionId <id>]');
          console.log('');
          console.log('Options:');
          console.log('  --json              Emit JSON output');
          console.log('  --joinTeam          Explicitly join orchestration coordination state');
          console.log('  --role <role>       Override default role when joining the team');
      }
    } catch (error) {
      emitError(error instanceof Error ? error.message : String(error), asJson);
    }
  },
});

/**
 * Give a Memorix session its PMI continuity state, start the daemon in
 * Connected mode, and report sessions waiting to be resumed.
 */
async function startPmiSession(
  dataDir: string,
  project: { id: string; rootPath: string },
  sessionId: string,
  args: Record<string, unknown>,
): Promise<{ sessionId: string; status: string; daemonPid?: number; resumable: Array<{ id: string; task: string }>; queued: boolean }> {
  const { LocalSessionStore } = await import('../../session/local-store.js');
  const service = await import('../../session/service.js');
  const { ensureDaemon, currentCliPath } = await import('../../session/daemon.js');
  const store = new LocalSessionStore(dataDir);
  const session = service.startSession(store, {
    projectId: project.id,
    projectRoot: project.rootPath,
    sessionId,
    agent: (args.agent as string | undefined) ?? null,
    model: args.model as string | undefined,
    modelProvider: args.modelProvider as string | undefined,
    task: args.task as string | undefined,
    objective: args.objective as string | undefined,
    agentPid: null,
  });
  const connected = service.connectedProject(project.rootPath);
  const flush = connected ? await service.flushOutbox(store) : undefined;
  const daemonPid = connected ? ensureDaemon(dataDir, currentCliPath()) : undefined;
  let resumable: Array<{ id: string; task: string }> = [];
  try {
    resumable = (await service.listProjectSessions(store, { projectId: project.id, projectRoot: project.rootPath }))
      .sessions.filter((item) => item.id !== session.id).map((item) => ({ id: item.id, task: item.task }));
  } catch { /* the list is a hint; starting must not fail on it */ }
  return { sessionId: session.id, status: session.status, ...(daemonPid ? { daemonPid } : {}), resumable, queued: Boolean(flush?.offline) };
}
