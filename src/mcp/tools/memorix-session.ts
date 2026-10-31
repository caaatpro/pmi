/**
 * Memorix session lifecycle tools: memorix_session_start (binds the project and opens the
 * PMI session state), memorix_session_end, memorix_session_context,
 * memorix_compaction_checkpoint, memorix_continuity.
 *
 * Split out of src/server.ts without behaviour changes; connection state comes
 * from `ServerToolContext`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAllObservations } from '../../memory/observations.js';
import { withFreshIndex } from '../../memory/freshness.js';
import { getObservationStore } from '../../store/obs-store.js';
import { filterReadableObservations } from '../../memory/visibility.js';
import { homeProjectRootError, isHomeDirectory } from '../../project/launch-root.js';
import { registerAlias } from '../../project/aliases.js';
import { isLLMEnabled, getLLMConfig } from '../../llm/provider.js';
import type { Observation } from '../../types.js';
import type { ServerToolContext } from './server-context.js';
import { coerceNumber, createDeterministicInstanceId, finishPmiContinuity, startPmiContinuity } from './helpers.js';

export function registerMemorixSessionTools(server: McpServer, ctx: ServerToolContext): void {
  // ============================================================
  // Session Lifecycle Tools (inspired by Engram)
  // ============================================================

  /**
   * memorix_session_start — Start a new coding session
   *
   * Creates a session record and returns a compact continuation card.
   * This is the entry point for session-aware memory management.
   */
  server.registerTool(
    'memorix_session_start',
    {
      title: 'Start Session',
      description:
        'Start a new coding session. Returns a compact continuation card with the latest handoff and a few memory references. ' +
        'Call this at the beginning of a session to track activity; retrieve a referenced memory only when it is relevant. ' +
        'Any previous active session for this project will be auto-closed. ' +
        'By default this is lightweight: it binds the project, opens a session, and avoids dumping full history into the new context. ' +
        'Coordination identity is opt-in via `joinTeam: true` or a separate `team_manage` join call.\n\n' +
        'IMPORTANT for HTTP/control-plane mode: pass `projectRoot` with the absolute path to your ' +
        'workspace root (e.g., the directory open in your IDE). Memorix uses this to detect the git ' +
        'project and bind this session to the correct project context. Without it, project-scoped ' +
        'tools will be disabled.',
      inputSchema: {
        sessionId: z.string().optional().describe('Custom session ID (auto-generated if omitted)'),
        agent: z.string().optional().describe('Agent/IDE name (e.g., "cursor", "windsurf", "claude-code")'),
        agentType: z.string().optional().describe('Agent type used for optional coordination identity mapping (e.g., "windsurf", "cursor").'),
        instanceId: z.string().optional().describe('Stable instance ID for optional coordination identity across restarts. If omitted with joinTeam=true, Memorix derives a deterministic fallback from the project and agent identity.'),
        joinTeam: z.boolean().optional().describe('If true, also join orchestration coordination state for this session. Defaults to false.'),
        role: z.string().optional().describe('Explicit role override used only when joinTeam=true.'),
        projectRoot: z.string().optional().describe(
          'Absolute path to the workspace/project root directory (e.g., the folder open in your IDE). ' +
          'Memorix will detect the git project from this path and bind this session to it. ' +
          'Required for HTTP transport when multiple projects are open simultaneously or when rebinding an existing control-plane session.',
        ),
        task: z.string().max(2000).optional().describe('PMI: the task this session works on (enables handoff/resume by others)'),
        objective: z.string().max(4000).optional().describe('PMI: when the task counts as done'),
        model: z.string().max(100).optional().describe('PMI: model you run on, e.g. claude-opus or gpt-5'),
        modelProvider: z.string().max(100).optional().describe('PMI: model provider, e.g. anthropic or openai'),
      },
    },
    async ({ sessionId, agent, agentType, instanceId, joinTeam, role, projectRoot: explicitRoot, task, objective, model, modelProvider }) => {
      // Phase 4a: clear agent identity — must not bleed from prior session_start
      ctx.currentAgentId = undefined;

      // ── Explicit project binding via projectRoot ──────────────────────
      // If the caller provides projectRoot, attempt to switch/bind to that project
      // BEFORE checking whether the project is resolved. This is the primary
      // mechanism for HTTP/control-plane multi-project support.
      if (explicitRoot && typeof explicitRoot === 'string') {
        if (isHomeDirectory(explicitRoot)) {
          return {
            content: [{
              type: 'text' as const,
              text: homeProjectRootError(explicitRoot),
            }],
            isError: true as const,
          };
        }
        let bound = await ctx.switchProject(explicitRoot, 'explicit-project-root');
        // switchProject returns false for both "same project, no-op" and "no git repo".
        // Only scan subdirectories when explicitRoot is not itself a git repo; otherwise
        // a same-project no-op can be hijacked by the first nested/vendored repo.
        if (!bound) {
          const { detectProjectWithDiagnostics: diagnose } = await import('../../project/detector.js');
          const diag = diagnose(explicitRoot);
          if (diag.project) {
            if (ctx.projectResolved) {
              const { registerAlias: regAlias } = await import('../../project/aliases.js');
              const resolvedCanonical = await regAlias(diag.project);
              if (resolvedCanonical === ctx.project.id) {
                bound = true;
              }
            }
          } else {
            const { findGitInSubdirs } = await import('../../project/detector.js');
            const subGit = findGitInSubdirs(explicitRoot);
            if (subGit) {
              bound = await ctx.switchProject(subGit, 'explicit-project-root');
            }
          }
        }
        if (!bound) {
          // Explicit projectRoot was provided but no git repo found.
          // ALWAYS fail closed — never silently fall back to a previously bound project.
          const { detectProjectWithDiagnostics: diagnose } = await import('../../project/detector.js');
          const diag = diagnose(explicitRoot);
          const failureDetail = diag.failure
            ? `\nDiagnostic: [${diag.failure.reason}] ${diag.failure.detail}`
            : '';
          const hint = ctx.projectResolved
            ? `The session was previously bound to "${ctx.project.name}" (${ctx.project.id}), but the explicitly requested path has no git repo. Refusing to silently reuse the old binding.`
            : 'No project is currently bound to this session.';
          return {
            content: [{
              type: 'text' as const,
              text:
                `Cannot bind session to project.\n` +
                `No git repository found at "${explicitRoot}".${failureDetail}\n` +
                `${hint}\n\n` +
                'Ensure the path points to a directory containing a .git folder (or a subdirectory of one). ' +
                'Run "git init" in your project root if needed.',
            }],
            isError: true as const,
          };
        }
        // `switchProject` records the explicit binding in the transport-neutral
        // ProjectBindingController, so Roots can no longer override it.
      }

      const unresolved = ctx.requireResolvedProject('start a project session');
      if (unresolved) return unresolved;

      const { startSession } = await import('../../memory/session.js');

      const llmStatus = isLLMEnabled()
        ? `LLM enhanced mode: ${getLLMConfig()?.provider}/${getLLMConfig()?.model} (fact extraction + auto-dedup active)`
        : 'LLM mode: off (set MEMORIX_LLM_API_KEY to enable enhanced memory quality)';

      const shouldJoinTeam = !!joinTeam;
      // Phase 4a: Explicit team join only
      let registeredAgent: import('../../team/team-store.js').TeamAgentRow | null = null;
      let watermarkInfo = '';
      let rescueInfo = '';
      let teamJoinNotice = '';
      try {
        if (!ctx.teamFeaturesEnabled && shouldJoinTeam) {
          teamJoinNotice = 'Coordination join skipped: the current tool profile does not expose coordination tools.';
        } else if (shouldJoinTeam && typeof ctx.teamStore !== 'undefined' && (agent || agentType)) {
          // Auto-derive role from agentType using AGENT_TYPE_ROLE_MAP
          const { AGENT_TYPE_ROLE_MAP } = await import('../../team/team-store.js');
          const resolvedAgentType = agentType || agent || 'unknown';
          const resolvedRole = role || (resolvedAgentType ? AGENT_TYPE_ROLE_MAP[resolvedAgentType] : undefined) || 'engineer';
          const resolvedInstanceId = instanceId || createDeterministicInstanceId(
            ctx.project.id,
            resolvedAgentType,
            agent || agentType || undefined,
          );
          registeredAgent = ctx.teamStore.registerAgent({
            projectId: ctx.project.id,
            agentType: resolvedAgentType,
            instanceId: resolvedInstanceId,
            name: agent || agentType || undefined,
            role: resolvedRole,
          });

          // Set session-level agent identity for observation attribution
          ctx.currentAgentId = registeredAgent.agent_id;

          // Watermark: project-scoped count of new observations since last seen
          // withFreshIndex ensures cross-process writes are visible before counting
          const { computeWatermark } = await import('../../team/team-store.js');
          const lastSeen = registeredAgent.last_seen_obs_generation;
          const store = getObservationStore();
          const currentGen = store.getGeneration();
          const projectObs = await withFreshIndex(() => filterReadableObservations(
            getAllObservations().filter(
              o => o.projectId === ctx.project.id && (o.writeGeneration ?? 0) > lastSeen,
            ),
            ctx.getObservationReader(),
          ));
          const wm = computeWatermark(lastSeen, currentGen, projectObs.length);
          if (wm.newObservationCount > 0) {
            watermarkInfo = `[STATS] ${wm.newObservationCount} new observation(s) in this project since your last session.`;
          }

          // Update watermark to current global generation (high-water mark for next session)
          ctx.teamStore.updateWatermark(registeredAgent.agent_id, currentGen);

          // Agents without a heartbeat for 5 minutes are marked inactive
          const STALE_TTL_MS = 5 * 60 * 1000;
          const staleAgentIds = ctx.teamStore.detectAndMarkStale(ctx.project.id, STALE_TTL_MS);
          if (staleAgentIds.length > 0) {
            rescueInfo = `[STALE] ${staleAgentIds.length} inactive agent(s) marked as left.`;
          }
        } else if (shouldJoinTeam) {
          teamJoinNotice = 'Coordination join skipped: pass `agent` or `agentType` to create a coordination identity.';
        }
      } catch { /* team auto-registration is best-effort */ }

      const result = await startSession(ctx.projectDir, ctx.project.id, {
        sessionId,
        agent,
        reader: ctx.getObservationReader(),
      });
      ctx.connectionSessionId = result.session.id;
      const pmiStart = await startPmiContinuity(ctx.projectDir, ctx.project, result.session.id, { agent, task, objective, model, modelProvider });
      const bindingReceipt = ctx.projectBinding.receipt({
        dataDir: ctx.projectDir,
        transport: ctx.bindingTransport,
        gitRemote: ctx.project.gitRemote,
        handle: ctx.bindingHandle,
      });

      const lines = [
        `[OK] Session started: ${result.session.id}`,
        `Project: ${ctx.project.name} (${ctx.project.id})`,
        `Binding: ${bindingReceipt.state} via ${bindingReceipt.source}`,
        result.session.agent ? `Agent: ${result.session.agent}` : '',
        registeredAgent ? `Agent ID: ${registeredAgent.agent_id} (instance: ${registeredAgent.instance_id})` : '',
        !registeredAgent ? 'Coordination identity: not joined (memory/session context only)' : '',
        llmStatus,
        teamJoinNotice,
        registeredAgent ? watermarkInfo : '',
        registeredAgent ? rescueInfo : '',
        ...pmiStart.lines,
        '',
        '[TIP] Tips: Use `memorix_resolve` to mark completed tasks. Use `progress` param in `memorix_store` for task tracking. Use `topicKey` to prevent duplicate memories.',
        '',
      ];

      // Inject coding conventions (permanent project knowledge; former
      // mini-skills became coding_convention memories in migration pmi-5).
      // Filter out demo/test/system-self entries so they don't pollute unrelated projects.
      try {
        const CONVENTION_NOISE = [
          /\bdemo\b/i, /展示/i, /全能力/i, /\[test\]/i, /\[测试\]/i, /测试/i,
          /验证/i, /兼容/i, /compat/i, /memmcp/i, /memorix-demo/i, /sandbox/i,
          /playground/i, /benchmark/i, /handoff/i, /交接/i, /for_memmcp/i,
        ];
        const conventions = filterReadableObservations(
          await getObservationStore().loadByProject(ctx.project.id, { status: 'active' }),
          ctx.getObservationReader(),
        ).filter((obs) => obs.category === 'coding_convention'
          && !CONVENTION_NOISE.some((p) => p.test(`${obs.title}\n${obs.entityName}\n${obs.narrative}`)));
        if (conventions.length > 0) {
          lines.push('---', '', formatConventionsForInjection(conventions));
        }
      } catch { /* conventions are optional context — skip */ }

      if (result.previousContext) {
        lines.push('---', '[TASK] **Continuation card:**', '', result.previousContext);
      } else {
        lines.push('No previous session context found. This appears to be a fresh project.');
      }

      // Inject team context if any agents are active (Phase 4a: SQLite-backed)
      try {
        if (registeredAgent && ctx.teamFeaturesEnabled && typeof ctx.teamStore !== 'undefined') {
          const activeAgents = ctx.teamStore.listAgents(ctx.project.id, { status: 'active' });
          if (activeAgents.length > 0) {
            lines.push('', '---', '[TEAM] **Active agents:**');
            for (const a of activeAgents) {
              lines.push(`- [CHANGE] ${a.name}${a.role ? ` (${a.role})` : ''}`);
            }
          }
        }
      } catch { /* team context injection is optional */ }

      const card = lines.filter(Boolean).join('\n');
      return {
        content: [{ type: 'text' as const, text: card }],
        // Clients that surface only structuredContent (e.g. Claude Code) must
        // still see the session card, not just the binding receipt.
        structuredContent: { card, binding: bindingReceipt },
      };
    },
  );

  /**
   * memorix_session_end — End the current coding session
   *
   * Marks the session as completed with a structured summary.
   */
  server.registerTool(
    'memorix_session_end',
    {
      title: 'End Session',
      description:
        'End a coding session with a structured summary. This summary will be injected into the next session ' +
        'so the next agent can resume work seamlessly.\n\n' +
        'Recommended summary format:\n' +
        '## Goal\n[What we were working on]\n\n' +
        '## Discoveries\n- [Technical findings, gotchas, learnings]\n\n' +
        '## Accomplished\n- [OK] [Completed tasks]\n- [PENDING] [Pending for next session]\n\n' +
        '## Relevant Files\n- path/to/file — [what changed]',
      inputSchema: {
        sessionId: z.string().describe('Session ID to close (from memorix_session_start)'),
        summary: z.string().optional().describe('Structured session summary (Goal/Discoveries/Accomplished/Files format)'),
      },
    },
    async ({ sessionId, summary }) => {
      const { endSession } = await import('../../memory/session.js');
      const session = await endSession(ctx.projectDir, sessionId, summary);
      if (session && ctx.connectionSessionId === sessionId) ctx.connectionSessionId = undefined;
      await finishPmiContinuity(ctx.projectDir, sessionId, summary);

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: `Session "${sessionId}" not found.` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `[OK] Session "${sessionId}" completed.\nDuration: ${session.startedAt} → ${session.endedAt}\n${summary ? 'Summary saved for next session context injection.' : 'No summary provided — consider adding one for better cross-session context.'}`,
        }],
      };
    },
  );

  /**
   * memorix_session_context — Get context from previous sessions
   *
   * Use this for compaction recovery or to manually retrieve session history.
   */
  server.registerTool(
    'memorix_session_context',
    {
      title: 'Session Context',
      description:
        'Get context from previous coding sessions. Use this after compaction to recover lost context, ' +
        'or to manually review session history. Returns previous session summaries and key observations.',
      inputSchema: {
        limit: z.number().optional().describe('Number of recent sessions to include (default: 3)'),
      },
    },
    async ({ limit }) => {
      const safeLimit = limit != null ? coerceNumber(limit, 3) : 3;
      const { getSessionContext, listSessions } = await import('../../memory/session.js');
      const context = await getSessionContext(ctx.projectDir, ctx.project.id, safeLimit, ctx.getObservationReader());
      const sessions = await listSessions(ctx.projectDir, ctx.project.id);

      const activeSessions = sessions.filter(s => s.status === 'active');
      const completedSessions = sessions.filter(s => s.status === 'completed');

      const header = [
        `## Session Stats`,
        `- Active: ${activeSessions.length}`,
        `- Completed: ${completedSessions.length}`,
        `- Total: ${sessions.length}`,
        '',
      ];

      if (!context) {
        return {
          content: [{ type: 'text' as const, text: header.join('\n') + '\nNo previous session context available.' }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: header.join('\n') + context }],
      };
    },
  );

  /**
   * memorix_compaction_checkpoint — Advanced inspection of native host
   * compaction checkpoints. Automatic recovery does not need this tool; it is
   * deliberately full-profile only so normal MCP startup stays compact.
   */
  server.registerTool(
    'memorix_compaction_checkpoint',
    {
      title: 'Compact Continuity Checkpoints',
      description:
        'Inspect, preview, or archive bounded checkpoints recorded around a host-native context compaction. ' +
        'Use only to debug or explicitly review compaction continuity. These are lifecycle records, not durable memories or transcript backups. ' +
        'CLI equivalent: memorix checkpoint list|show|context|archive.',
      inputSchema: {
        action: z.enum(['list', 'show', 'context', 'archive']).default('list'),
        id: z.string().optional().describe('Checkpoint ID for show, context, or archive'),
        sessionId: z.string().optional().describe('Optional host session ID filter'),
        agent: z.string().optional().describe('Optional host agent filter'),
        task: z.string().optional().describe('Current task for a bounded context preview'),
        maxTokens: z.number().optional().describe('Maximum tokens for action=context (default: 420)'),
        limit: z.number().optional().describe('Maximum records for action=list (default: 20)'),
        includeArchived: z.boolean().optional().default(false).describe('Include archived records in action=list'),
      },
    },
    async ({ action, id, sessionId, agent, task, maxTokens, limit, includeArchived }) => {
      const unresolved = ctx.requireResolvedProject('inspect compact continuity checkpoints');
      if (unresolved) return unresolved;

      const [{ CompactionCheckpointStore }, { buildCompactionWorkset }] = await Promise.all([
        import('../../store/compaction-checkpoint-store.js'),
        import('../../memory/compaction.js'),
      ]);
      const store = new CompactionCheckpointStore(ctx.projectDir);
      const assertCheckpoint = (checkpointId: string) => {
        const checkpoint = store.get(checkpointId);
        if (!checkpoint || checkpoint.projectId !== ctx.project.id) return null;
        return checkpoint;
      };

      if (action === 'list') {
        const checkpoints = store.list({
          projectId: ctx.project.id,
          sessionId: sessionId?.trim() || undefined,
          agent: agent?.trim() || undefined,
          includeArchived: Boolean(includeArchived),
          limit: limit != null ? Math.max(1, Math.min(100, coerceNumber(limit, 20))) : 20,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ projectId: ctx.project.id, checkpoints }, null, 2) }],
        };
      }

      if (!id?.trim()) {
        return {
          content: [{ type: 'text' as const, text: 'id is required for this checkpoint action.' }],
          isError: true,
        };
      }
      const checkpoint = assertCheckpoint(id.trim());
      if (!checkpoint) {
        return {
          content: [{ type: 'text' as const, text: `Checkpoint "${id.trim()}" was not found for the current project.` }],
          isError: true,
        };
      }

      if (action === 'show') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ projectId: ctx.project.id, checkpoint }, null, 2) }],
        };
      }
      if (action === 'context') {
        const workset = buildCompactionWorkset(checkpoint, {
          task: task?.trim(),
          maxTokens: maxTokens != null ? coerceNumber(maxTokens, 420) : 420,
        });
        return {
          content: [{ type: 'text' as const, text: workset.text }],
        };
      }

      const archived = store.archive(checkpoint.id);
      if (!archived) {
        return {
          content: [{ type: 'text' as const, text: `Checkpoint "${checkpoint.id}" is already archived.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: `Archived compact checkpoint ${archived.id}.` }],
      };
    },
  );

  server.registerTool(
    'memorix_continuity',
    {
      title: 'Task Continuity Ledger',
      description:
        'Maintain a bounded, append-only continuity ledger for a coding task. ' +
        'Use start for requirements, record for decisions/verification/risks, ' +
        'show or list to inspect, and close for the final outcome. Pass the returned taskId ' +
        'to memorix_project_context so the current brief includes this ledger.',
      inputSchema: {
        action: z.enum(['start', 'record', 'show', 'list', 'close']).describe('Continuity operation'),
        taskId: z.string().max(120).optional().describe('Continuity task id'),
        task: z.string().max(1_000).optional().describe('Task description for start'),
        requirements: z.array(z.string().max(2_000)).max(8).optional().describe('Requirements for start'),
        kind: z.enum(['requirement', 'decision', 'verification', 'risk']).optional().describe('Entry kind for record'),
        content: z.string().max(2_000).optional().describe('Requirement, decision, verification, risk, or outcome text'),
        verificationStatus: z.enum(['pending', 'passed', 'failed', 'skipped']).optional(),
        verificationId: z.string().max(120).optional().describe('Stable verification obligation id; reuse it to move pending to passed/failed'),
        idempotencyKey: z.string().max(200).optional().describe('Stable retry key; repeating the same operation returns the original event'),
        status: z.enum(['completed', 'blocked', 'abandoned']).optional().describe('Outcome status for close'),
        sourceRef: z.string().max(500).optional().describe('Evidence or source reference'),
        evidenceRefs: z.array(z.string().max(500)).max(8).optional(),
        actor: z.string().max(200).optional(),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
    },
    async ({ action, taskId, task, requirements, kind, content, verificationStatus, verificationId, idempotencyKey, status, sourceRef, evidenceRefs, actor, limit }) => {
      const unresolved = ctx.requireResolvedProject('manage task continuity for the current project');
      if (unresolved) return unresolved;
      const { TaskContinuityStore } = await import('../../knowledge/task-continuity.js');
      const continuity = new TaskContinuityStore();
      await continuity.init(ctx.projectDir);
      const effectiveActor = actor ?? ctx.currentAgentId;
      try {
        if (action === 'start') {
          if (!task?.trim()) return { content: [{ type: 'text' as const, text: 'task is required for continuity start.' }], isError: true };
          const result = continuity.start({
            projectId: ctx.project.id,
            task,
            ...(taskId ? { taskId } : {}),
            requirements,
            ...(effectiveActor ? { actor: effectiveActor } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify({ projectId: ctx.project.id, ...result }, null, 2) }] };
        }
        if (action === 'list') {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ projectId: ctx.project.id, ledgers: continuity.list(ctx.project.id, limit), }, null, 2) }] };
        }
        if (!taskId?.trim()) return { content: [{ type: 'text' as const, text: 'taskId is required for this continuity action.' }], isError: true };
        if (action === 'show') {
          const ledger = continuity.get(ctx.project.id, taskId);
          if (!ledger) return { content: [{ type: 'text' as const, text: 'Task continuity ledger not found.' }], isError: true };
          return { content: [{ type: 'text' as const, text: JSON.stringify({ projectId: ctx.project.id, ledger }, null, 2) }] };
        }
        if (action === 'record') {
          if (!kind || !content?.trim()) {
            return { content: [{ type: 'text' as const, text: 'record requires kind and content.' }], isError: true };
          }
          const result = continuity.record({
            projectId: ctx.project.id,
            taskId,
            kind,
            content,
            ...(verificationStatus ? { verificationStatus } : {}),
            ...(sourceRef ? { sourceRef } : {}),
            ...(evidenceRefs ? { evidenceRefs } : {}),
            ...(effectiveActor ? { actor: effectiveActor } : {}),
            ...(verificationId ? { verificationId } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify({ projectId: ctx.project.id, ...result }, null, 2) }] };
        }
        if (!status || !content?.trim()) {
          return { content: [{ type: 'text' as const, text: 'close requires status and content.' }], isError: true };
        }
        const result = continuity.close({
          projectId: ctx.project.id,
          taskId,
          status,
          content,
          ...(sourceRef ? { sourceRef } : {}),
          ...(evidenceRefs ? { evidenceRefs } : {}),
          ...(effectiveActor ? { actor: effectiveActor } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ projectId: ctx.project.id, ...result }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );
}

const MAX_INJECTED_CONVENTIONS = 20;

/** Markdown block of the project's coding conventions for the session card. */
function formatConventionsForInjection(conventions: Observation[]): string {
  const shown = conventions.slice(0, MAX_INJECTED_CONVENTIONS);
  const lines = [`## [SESSION] Project Coding Conventions (${conventions.length} active)`, ''];
  for (const obs of shown) {
    lines.push(`### ${obs.title}`);
    if (obs.narrative) lines.push(obs.narrative);
    for (const fact of obs.facts) lines.push(`- ${fact}`);
    lines.push('');
  }
  if (conventions.length > shown.length) {
    lines.push(`+${conventions.length - shown.length} more: memory_search with category coding_convention.`, '');
  }
  return lines.join('\n');
}
