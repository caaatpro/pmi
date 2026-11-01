/**
 * Memory retrieval tools inherited from Baton (progressive disclosure): baton_search,
 * baton_search_reasoning, baton_timeline, baton_detail, baton_graph_context,
 * baton_evidence, baton_feedback.
 *
 * Split out of src/server.ts without behaviour changes; connection state comes
 * from `ServerToolContext`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withFreshIndex } from '../../memory/freshness.js';
import { getObservationStore } from '../../store/obs-store.js';
import { filterReadableObservations } from '../../memory/visibility.js';
import { compactSearch, compactTimeline, compactDetail } from '../../compact/engine.js';
import { formatEntryRef } from '../../compact/index-format.js';
import { buildGraphContextPacket, formatGraphContextPrompt } from '../../memory/graph-context.js';
import { EvidenceCardStore } from '../../store/evidence-store.js';
import { MemoryFeedbackStore } from '../../memory/feedback.js';
import type { ObservationType } from '../../types.js';
import { withTimeout } from '../../timeout.js';
import { getSurfacedIds, recordSurfacedIds } from '../../search/surfaced-registry.js';
import type { ServerToolContext } from './server-context.js';
import { OBSERVATION_TYPES, coerceNumber, coerceNumberArray, coerceObservationRefs, coerceStringArray } from './helpers.js';

export function registerRetrievalTools(server: McpServer, ctx: ServerToolContext): void {
  /**
   * baton_search — Layer 1: Compact index search
   *
   * Returns a lightweight table of matching observations.
   * ~50-100 tokens per result. Agent scans this to decide what to fetch.
   */
  server.registerTool(
    'baton_search',
    {
      title: 'Search Memory',
      description:
        'Search project memory. Returns a compact index (~50-100 tokens/result). ' +
        'Do not use as a follow-up to a complete baton_project_context brief unless a specific fact is still missing or the user asks for deeper history; provide purpose when intentionally expanding. ' +
        'Use baton_detail to fetch full content for specific IDs. ' +
        'Use baton_timeline to see chronological context. ' +
        'Searches across all observations stored from any IDE session — enabling cross-session and cross-agent context retrieval.',
      inputSchema: {
        query: z.string().describe('Search query (natural language or keywords)'),
        limit: z.number().optional().describe('Max results (default: 20)'),
        type: z.enum(OBSERVATION_TYPES).optional().describe('Filter by observation type'),
        maxTokens: z.number().optional().describe('Token budget — trim results to fit (0 = unlimited)'),
        scope: z.enum(['project', 'global']).optional().default('project').describe(
          'Search scope: "project" (default) only searches current project, "global" searches all projects',
        ),
        since: z.string().optional().describe('Only return observations created after this date (ISO 8601 or natural like "2025-01-15")'),
        until: z.string().optional().describe('Only return observations created before this date (ISO 8601 or natural like "2025-02-01")'),
        status: z.enum(['active', 'resolved', 'archived', 'all']).optional().default('active').describe(
          'Filter by memory status. "active" (default) shows current memories, "all" includes resolved/archived.',
        ),
        source: z.enum(['agent', 'git', 'manual']).optional().describe(
          'Filter by memory source. "git" returns only commit-derived ground truth memories. Omit for all sources.',
        ),
        quality: z.enum(['fast', 'balanced', 'thorough']).optional().default('balanced').describe(
          'Retrieval profile: fast stays local, balanced uses configured embeddings, thorough explicitly permits optional LLM refinement.',
        ),
        purpose: z.string().optional().describe(
          'Why this must expand beyond the latest Autopilot brief. Name the missing fact or the user\'s explicit request.',
        ),
        force: z.boolean().optional().describe(
          'Use only when the user explicitly asks to read a record already represented in the latest Autopilot brief.',
        ),
      },
    },
    async ({ query, limit, type, maxTokens, scope, since, until, status, source, quality, purpose, force }) => {
      if (scope !== 'global') {
        const unresolved = ctx.requireResolvedProject('search the current project');
        if (unresolved) return unresolved;
      }
      if (scope !== 'global') {
        const boundary = ctx.requireExplicitAutopilotExpansion('baton_search', purpose);
        if (boundary) return boundary;
      }

      // Session dedup scope: prefer the active session id, fall back to the
      // bound project. Best-effort bookkeeping — losing it only costs one
      // redundant result row, never data.
      let surfacedKey = `project:${ctx.project.id}`;
      try {
        const activeSessionId = await ctx.resolveConnectionSessionId();
        if (activeSessionId) surfacedKey = `session:${activeSessionId}`;
      } catch { /* fall back to the project key */ }

      return withFreshIndex(async () => {

      const safeLimit = limit != null ? coerceNumber(limit, 20) : undefined;
      const safeMaxTokens = maxTokens != null ? coerceNumber(maxTokens, 0) : undefined;

      // Tool-level timeout: abort if search takes longer than 30 seconds
      const TIMEOUT_MS = 30000;
      const searchPromise = compactSearch({
        query,
        limit: safeLimit,
        type: type as ObservationType | undefined,
        maxTokens: safeMaxTokens,
        since,
        until,
        // Default to project-scoped search to prevent cross-project pollution.
        // Use scope: 'global' to explicitly search all projects.
        projectId: scope === 'global' ? undefined : ctx.project.id,
        status: (status as 'active' | 'resolved' | 'archived' | 'all') ?? 'active',
        source: source as 'agent' | 'git' | 'manual' | undefined,
        quality: quality as 'fast' | 'balanced' | 'thorough',
        reader: ctx.getObservationReader(scope === 'global' ? 'global' : 'project'),
        surfacedIds: getSurfacedIds(surfacedKey),
      });

      let result;
      try {
        result = await withTimeout(searchPromise, TIMEOUT_MS, 'Search');
      } catch (error) {
        if (error instanceof Error && /\btimeout\b|timed out/i.test(error.message)) {
          // Timeout: return empty result with error message
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: Search timeout after ${TIMEOUT_MS}ms. Try a simpler query or check if the service is responsive.`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }

      // These rows were just shown to the model — remember them so later
      // searches in the same session demote instead of re-showing.
      recordSurfacedIds(surfacedKey, result.entries.map(entry => entry.id));

      const activeBoundary = ctx.getActiveAutopilotRetrievalBoundary();
      if (
        scope !== 'global'
        && activeBoundary
        && !force
        && result.entries.length > 0
        && result.entries.every(entry => activeBoundary.coveredObservationIds.has(entry.id))
      ) {
        const duplicate = ctx.blockCoveredAutopilotEvidence('baton_search', result.entries.map(entry => entry.id), force);
        if (duplicate) return duplicate;
      }

      // Append retrieval diagnostics only; do not mix workspace-sync guidance into memory results.
      let text = result.formatted;
      text += `\n\n_Search mode: ${result.receipt.mode}_`;

      return {
        content: [
          {
            type: 'text' as const,
            text,
          },
        ],
        // Clients that surface only structuredContent (e.g. Claude Code) must
        // still see the results, not just the retrieval diagnostics.
        structuredContent: {
          results: result.entries.map(entry => ({
            ref: formatEntryRef(entry),
            title: entry.title,
            type: entry.type,
            time: entry.time,
            tokens: entry.tokens,
          })),
          retrieval: result.receipt,
        },
      };
      }, { loadCorpus: false }); // withFreshIndex
    },
  );

  /**
   * baton_search_reasoning — Search reasoning patterns
   *
   * Find past reasoning traces to understand WHY decisions were made.
   * Useful when revisiting code and needing to understand the thought
   * process behind the current implementation.
   */
  server.registerTool(
    'baton_search_reasoning',
    {
      title: 'Search Reasoning Patterns',
      description:
        'Search past reasoning traces to understand WHY decisions were made. ' +
        'Returns reasoning memories that explain the thought process behind technical choices. ' +
        'Use this when revisiting code, questioning a design decision, or looking for precedent ' +
        'on how similar problems were solved before.',
      inputSchema: {
        query: z.string().describe('Search query — describe what reasoning you want to find (e.g., "why did we choose PostgreSQL", "auth approach rationale")'),
        limit: z.number().optional().describe('Max results (default: 10)'),
        scope: z.enum(['project', 'global']).optional().default('project').describe('Search scope'),
      },
    },
    async ({ query, limit, scope }) => {
      if (scope !== 'global') {
        const unresolved = ctx.requireResolvedProject('search reasoning in the current project');
        if (unresolved) return unresolved;
      }
      const safeLimit = limit != null ? coerceNumber(limit, 10) : 10;
      const result = await withFreshIndex(() => compactSearch({
        query,
        limit: safeLimit,
        type: 'reasoning' as ObservationType,
        projectId: scope === 'global' ? undefined : ctx.project.id,
        status: 'active',
        reader: ctx.getObservationReader(scope === 'global' ? 'global' : 'project'),
      }));

      if (result.entries.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No reasoning traces found. Use baton_store_reasoning to record decision rationale.' }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: `[REASONING] Reasoning Traces:\n${result.formatted}` }],
      };
    },
  );

  /**
   * baton_timeline — Deep retrieval: provenance-aware chronological expansion
   *
   * Natural follow-up after session L1 routing hints (hook traces) or L3
   * evidence pointers (git memory). Distinguishes explicit memory evolution,
   * hook activity traces, and git-backed facts via Src column when available.
   */
  server.registerTool(
    'baton_timeline',
    {
      title: 'Memory Timeline',
      description:
        'Deep retrieval: expand chronological context around a specific observation — ' +
        'distinguishes explicit memory evolution, hook activity traces, and git-backed facts. ' +
        'Natural follow-up after session L1 routing hints (hook traces) or L3 evidence pointers (git memory).',
      inputSchema: {
        anchorId: z.number().describe('Observation ID to center the timeline on'),
        depthBefore: z.number().optional().describe('Number of observations before (default: 3)'),
        depthAfter: z.number().optional().describe('Number of observations after (default: 3)'),
      },
    },
    async ({ anchorId, depthBefore, depthAfter }) => {
      const safeAnchor = coerceNumber(anchorId, 0);
      const safeBefore = depthBefore != null ? coerceNumber(depthBefore, 3) : undefined;
      const safeAfter = depthAfter != null ? coerceNumber(depthAfter, 3) : undefined;
      const result = await compactTimeline(
        safeAnchor,
        ctx.project.id,
        safeBefore,
        safeAfter,
        ctx.getObservationReader(),
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: result.formatted,
          },
        ],
      };
    },
  );

  /**
   * baton_detail — Layer 3: Provenance-aware full observation details
   *
   * Opens explicit memories, hook traces, or git evidence depending on source.
   * Output includes a provenance header identifying the evidence kind, value
   * category (core / ephemeral), and cross-references to related items.
   */
  server.registerTool(
    'baton_detail',
    {
      title: 'Memory Details',
      description:
        'Fetch full observation, mini-skill, or curated durable-memory details — includes source kind (explicit memory / hook trace / git evidence), ' +
        'value category, and cross-references (~500-1000 tokens each). ' +
        'Do not re-fetch content already covered by a complete baton_project_context brief unless a specific fact is still missing or the user asks for deeper history; provide purpose when intentionally expanding. ' +
        'Always use baton_search first to find relevant IDs, then fetch only what you need. ' +
        'Accepts typed refs from search results (e.g. "obs:42", "skill:3") and durable refs from a project brief (e.g. "durable:<uuid>") via the typedRefs field, ' +
        'or legacy numeric ids / object refs for backward compatibility.',
      inputSchema: {
        ids: z.array(z.number()).optional().describe('Observation IDs to fetch (legacy, from baton_search results)'),
        refs: z.array(
          z.object({
            id: z.number().describe('Observation ID'),
            projectId: z.string().optional().describe('Project ID for global-search disambiguation'),
          }),
        ).optional().describe('Explicit observation refs. Prefer this for global search results.'),
        typedRefs: z.array(z.string()).optional().describe('Typed memory refs from search results or a project brief, e.g. "obs:42", "skill:3", "durable:<uuid>", "obs:42@org/proj"'),
        purpose: z.string().optional().describe(
          'Why this must expand beyond the latest Autopilot brief. Name the missing fact or the user\'s explicit request.',
        ),
        force: z.boolean().optional().describe(
          'Use only when the user explicitly asks to read a record already represented in the latest Autopilot brief.',
        ),
      },
    },
    async ({ ids, refs, typedRefs, purpose, force }) => {
      // Defensive coercion: Claude Code CLI + GLM may send "[16]" instead of [16]
      const safeIds = coerceNumberArray(ids);
      const safeRefs = coerceObservationRefs(refs);
      const safeTypedRefs = coerceStringArray(typedRefs);
      const durableIds = safeTypedRefs.flatMap((ref) => {
        const match = /^durable:([0-9a-f-]{36})$/i.exec(ref.trim());
        return match ? [match[1]] : [];
      });
      const observationTypedRefs = safeTypedRefs.filter(ref => !/^durable:/i.test(ref.trim()));
      const hasCrossProjectRef = safeRefs.some((ref) => ref.projectId && ref.projectId !== ctx.project.id)
        || observationTypedRefs.some((ref) => ref.includes('@') && !ref.endsWith(`@${ctx.project.id}`));
      if (!hasCrossProjectRef) {
        const boundary = ctx.requireExplicitAutopilotExpansion('baton_detail', purpose);
        if (boundary) return boundary;
        const requestedObservationIds = [
          ...safeIds,
          ...safeRefs.map(ref => ref.id),
          ...observationTypedRefs.flatMap((ref) => {
            const match = /^obs:(\d+)(?:@.+)?$/i.exec(ref.trim());
            return match ? [Number(match[1])] : [];
          }),
        ];
        const duplicate = ctx.blockCoveredAutopilotEvidence('baton_detail', requestedObservationIds, force);
        if (duplicate) return duplicate;
      }

      const formatted: string[] = [];
      try {
        if (durableIds.length > 0) {
          const [{ getLongTermMemoryDetail }, { resolveLocalMemoryOwner }] = await Promise.all([
            import('../../memory/long-term.js'),
            import('../../memory/owner.js'),
          ]);
          const owner = await resolveLocalMemoryOwner(ctx.projectDir, { create: false });
          const observationReader = ctx.getObservationReader();
          const durableReader = {
            projectId: ctx.project.id,
            ...(owner ? { ownerId: owner.id } : {}),
            ...(observationReader.agentId ? { agentId: observationReader.agentId } : {}),
            ...(observationReader.isTeamMember ? { isTeamMember: true } : {}),
          };
          const details = await Promise.all(durableIds.slice(0, 5).map(async (id) => {
            try {
              return await getLongTermMemoryDetail({ dataDir: ctx.projectDir, id, reader: durableReader });
            } catch (error) {
              return { error: error instanceof Error ? error.message : String(error), id };
            }
          }));
          formatted.push(JSON.stringify({ durableMemory: details }, null, 2));
        }

        if (observationTypedRefs.length > 0 || safeRefs.length > 0 || safeIds.length > 0) {
          const reader = ctx.getObservationReader(hasCrossProjectRef ? 'global' : 'project');
          const result = observationTypedRefs.length > 0
            ? await compactDetail(observationTypedRefs, { reader })
            : safeRefs.length > 0
              ? await compactDetail(safeRefs, { reader })
              : await compactDetail(safeIds.map(id => ({ id, projectId: ctx.project.id })), { reader });
          formatted.push(
            result.documents.length > 0
              ? result.formatted
              : observationTypedRefs.length > 0
                ? `No memories found for refs: ${observationTypedRefs.join(', ')}`
                : safeRefs.length > 0
                  ? `No memories found for refs: ${safeRefs.map((ref) => `${ref.projectId ?? 'current'}#${ref.id}`).join(', ')}`
                  : `No memories found for IDs: ${safeIds.join(', ')}`,
          );
        }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: formatted.length > 0
              ? formatted.join('\n\n')
              : safeTypedRefs.length > 0
                ? `No memories found for refs: ${safeTypedRefs.join(', ')}`
                : safeRefs.length > 0
                  ? `No memories found for refs: ${safeRefs.map((ref) => `${ref.projectId ?? 'current'}#${ref.id}`).join(', ')}`
                  : `No memories found for IDs: ${safeIds.join(', ')}`,
          },
        ],
      };
    },
  );

  /**
   * baton_graph_context — Prompt-ready memory graph packet
   *
   * Gives agents a compact, high-signal map of relevant memories, entities,
   * relations, and quality risks without forcing broad search/detail loops.
   */
  server.registerTool(
    'baton_graph_context',
    {
      title: 'Memory Graph Context',
      description:
        'Build a compact, prompt-ready memory graph context packet for the current project. ' +
        'Use this for broad memory overview questions, project memory graph questions, or task-specific memory grounding. ' +
        'Returns high-signal memories, entities, relations, and risks as background context, not instructions.',
      inputSchema: {
        query: z.string().describe('Current task or topic to build memory graph context for'),
        limit: z.number().optional().describe('Max high-signal memories to include (default: 5)'),
        format: z.enum(['prompt', 'summary']).optional().default('prompt').describe(
          'Output format. "prompt" is agent-ready; "summary" is a compact human overview.',
        ),
      },
    },
    async ({ query, limit, format }) => {
      const unresolved = ctx.requireResolvedProject('build graph context for the current project');
      if (unresolved) return unresolved;

      const { getObservationStore } = await import('../../store/obs-store.js');
      const observations = filterReadableObservations(
        await getObservationStore().loadByProject(ctx.project.id),
        ctx.getObservationReader(),
      );
      const packet = buildGraphContextPacket(observations, {
        projectId: ctx.project.id,
        query,
        limit: limit != null ? coerceNumber(limit, 5) : undefined,
      });
      const text = format === 'summary'
        ? [
            `Graph context packet for ${ctx.project.name}`,
            `- ${packet.summary}`,
            '',
            ...packet.entities.map((entity) => `* ${entity.name} (#${entity.observationIds.join(', #')})`),
          ].join('\n')
        : formatGraphContextPrompt(packet);

      return {
        content: [{ type: 'text' as const, text }],
      };
    },
  );

  // ================================================================
  // Orchestration Coordination Tools (Multi-Agent) - SQLite-backed
  // ================================================================

  server.registerTool(
    'baton_evidence',
    {
      title: 'Evidence Cards',
      description:
        'Inspect the bounded, project-scoped provenance cards behind Baton context. ' +
        'Use list for a compact index, get/events for one source, sync to repair the projection, ' +
        'and stale when known source files changed. Cards expose sourceRef, locator, capturedHash, and freshness.',
      inputSchema: {
        action: z.enum(['list', 'get', 'sync', 'stale', 'events']).describe('Evidence operation'),
        candidateKind: z.enum(['observation', 'code', 'git', 'test', 'document', 'workflow', 'graph']).optional().default('observation'),
        candidateId: z.string().optional().describe('Candidate id, usually an observation id'),
        query: z.string().optional().describe('Optional title/source query for list'),
        paths: z.array(z.string()).max(200).optional().describe('Changed source paths for stale'),
        reason: z.string().max(500).optional().describe('Why evidence became stale'),
        limit: z.number().int().positive().max(100).optional().default(20),
      },
    },
    async ({ action, candidateKind, candidateId, query, paths, reason, limit }) => {
      const unresolved = ctx.requireResolvedProject('inspect evidence cards for the current project');
      if (unresolved) return unresolved;
      const cards = new EvidenceCardStore();
      await cards.init(ctx.projectDir);
      if (action === 'sync') {
        const observations = await getObservationStore().loadByProject(ctx.project.id);
        const synced = cards.syncObservations(observations);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ projectId: ctx.project.id, synced: synced.length, cards: synced.slice(0, limit ?? 20) }, null, 2) }] };
      }
      if (action === 'stale') {
        const changed = cards.markStaleForPaths(ctx.project.id, paths ?? [], reason ?? 'source file changed');
        return { content: [{ type: 'text' as const, text: JSON.stringify({ projectId: ctx.project.id, staleMarked: changed, paths: paths ?? [] }, null, 2) }] };
      }
      if (action === 'get') {
        if (!candidateId?.trim()) return { content: [{ type: 'text' as const, text: 'candidateId is required for evidence get.' }], isError: true };
        const card = cards.get(ctx.project.id, candidateKind ?? 'observation', candidateId.trim());
        if (!card) return { content: [{ type: 'text' as const, text: 'Evidence card not found.' }], isError: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify({ card, events: cards.listEvents(card.id), projectId: ctx.project.id }, null, 2) }] };
      }
      if (action === 'events') {
        if (!candidateId?.trim()) return { content: [{ type: 'text' as const, text: 'candidateId is required for evidence events.' }], isError: true };
        const card = cards.get(ctx.project.id, candidateKind ?? 'observation', candidateId.trim());
        if (!card) return { content: [{ type: 'text' as const, text: 'Evidence card not found.' }], isError: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(cards.listEvents(card.id, limit), null, 2) }] };
      }
      const needle = query?.trim().toLowerCase();
      const listed = cards.list(ctx.project.id, { limit: Math.max(limit ?? 20, 100) })
        .filter((card) => !needle || [card.title, card.summary, card.sourceRef, card.locator ?? ''].join(' ').toLowerCase().includes(needle))
        .slice(0, limit ?? 20);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ projectId: ctx.project.id, cards: listed }, null, 2) }] };
    },
  );

  server.registerTool(
    'baton_feedback',
    {
      title: 'Memory Feedback',
      description:
        'Record or inspect auditable memory outcomes. Positive verification/use strengthens recall; correction, conflict, source change, or weaken lowers it. ' +
        'Use revoke with targetEventId to undo one prior signal without deleting audit history.',
      inputSchema: {
        action: z.enum(['record', 'show', 'audit']).describe('Feedback operation'),
        candidateKind: z.enum(['observation', 'claim', 'durable-memory', 'workflow']).optional().default('observation'),
        candidateId: z.string().describe('Memory or knowledge candidate id'),
        signal: z.enum(['user-correction', 'verification-success', 'verification-failure', 'code-change', 'used', 'not-used', 'code-conflict', 'strengthen', 'weaken', 'revoke']).optional(),
        sourceRef: z.string().max(500).optional().describe('Source of this feedback, such as test:run-42 or user:chat'),
        actor: z.string().max(200).optional(),
        note: z.string().max(2_000).optional(),
        targetEventId: z.string().optional().describe('Existing event id when action=record and signal=revoke'),
        limit: z.number().int().positive().max(200).optional().default(100),
      },
    },
    async ({ action, candidateKind, candidateId, signal, sourceRef, actor, note, targetEventId, limit }) => {
      const unresolved = ctx.requireResolvedProject('record memory feedback for the current project');
      if (unresolved) return unresolved;
      const feedback = new MemoryFeedbackStore();
      await feedback.init(ctx.projectDir);
      const kind = candidateKind ?? 'observation';
      if (action === 'show') {
        return { content: [{ type: 'text' as const, text: JSON.stringify(feedback.getState(ctx.project.id, kind, candidateId), null, 2) }] };
      }
      if (action === 'audit') {
        return { content: [{ type: 'text' as const, text: JSON.stringify(feedback.audit(ctx.project.id, kind, candidateId, limit), null, 2) }] };
      }
      if (!signal || !sourceRef?.trim()) {
        return { content: [{ type: 'text' as const, text: 'record requires signal and sourceRef.' }], isError: true };
      }
      try {
        const result = feedback.record({
          projectId: ctx.project.id,
          candidateKind: kind,
          candidateId,
          signal,
          sourceRef,
          ...(actor || ctx.currentAgentId ? { actor: actor ?? ctx.currentAgentId } : {}),
          ...(note ? { note } : {}),
          ...(targetEventId ? { targetEventId } : {}),
        });
        if (kind === 'observation') {
          const cards = new EvidenceCardStore();
          await cards.init(ctx.projectDir);
          const card = cards.get(ctx.project.id, 'observation', candidateId);
          if (card) {
            const verification = signal === 'verification-success' || signal === 'strengthen' ? 'verified' : signal === 'user-correction' || signal === 'code-conflict' || signal === 'weaken' ? 'conflicted' : card.verification;
            cards.recordEvent(ctx.project.id, card.id, `feedback:${signal}`, note);
            if (verification !== card.verification) {
              // Keep the card projection in sync with the feedback state while
              // retaining the append-only feedback audit as the source of truth.
              cards.setVerification(ctx.project.id, card.id, verification);
            }
          }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );
}
