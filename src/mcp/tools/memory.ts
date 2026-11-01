/**
 * Memory write tools inherited from Baton: baton_store, baton_suggest_topic_key,
 * baton_resolve, baton_store_reasoning, baton_deduplicate, baton_consolidate.
 *
 * Split out of src/server.ts without behaviour changes; connection state comes
 * from `ServerToolContext`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { storeObservation, getObservation, getAllObservations } from '../../memory/observations.js';
import { withFreshIndex } from '../../memory/freshness.js';
import { getObservationStore } from '../../store/obs-store.js';
import { checkProjectAttribution } from '../../memory/attribution-guard.js';
import { createAutoRelations } from '../../memory/auto-relations.js';
import { extractEntities } from '../../memory/entity-extractor.js';
import { canManageObservation, canReadObservation, filterReadableObservations } from '../../memory/visibility.js';
import { compactSearch, compactDetail } from '../../compact/engine.js';
import type { ObservationType } from '../../types.js';
import { isLLMEnabled } from '../../llm/provider.js';
import { compactOnWrite } from '../../llm/memory-manager.js';
import { applyDeduplicationPlan, planMemoryDeduplication } from '../../memory/deduplication.js';
import type { ExistingMemory } from '../../llm/memory-manager.js';
import { runFormation } from '../../memory/formation/index.js';
import type { FormationConfig, SearchHit, FormedMemory, FormationStage, FormationStageEvent } from '../../memory/formation/types.js';
import { withTimeout, withTimeoutSignal } from '../../timeout.js';
import type { ServerToolContext } from './server-context.js';
import { COMPACT_ON_WRITE_TIMEOUT_MS, COMPRESSION_TIMEOUT_MS, FORMATION_TIMEOUT_MS, OBSERVATION_TYPES, coerceNumber, coerceStringArray, formatFormationStageDurations } from './helpers.js';

export function registerMemoryTools(server: McpServer, ctx: ServerToolContext): void {
  // ================================================================
  // Baton Extended Tools (3-layer Progressive Disclosure)
  // ================================================================

  /**
   * baton_store — Store a new observation
   *
   * Primary write API. Agents call this to persist knowledge.
   * Auto-assigns ID, counts tokens, indexes for search.
   */
  server.registerTool(
    'baton_store',
    {
      title: 'Store Memory',
      description:
        'Store a new observation/memory. Automatically indexed for search. ' +
        'Use type to classify: gotcha ([GOTCHA] critical pitfall), decision ([DECISION] architecture choice), ' +
        'problem-solution ([FIX] bug fix), how-it-works ([INFO] explanation), what-changed ([CHANGE] change), ' +
        'discovery ([DISCOVERY] insight), why-it-exists ([WHY] rationale), trade-off ([TRADEOFF] compromise), ' +
         'session-request ([SESSION] original goal). ' +
         'Project visibility is the default. Personal or team visibility requires an explicitly joined coordination identity. ' +
         'Set longTerm only when the caller explicitly wants an additional source-backed long-term candidate; it is never injected until an operator records a review through the CLI. ' +
         'For a read-only task, do not store unless the user explicitly asks to save a record.',
      inputSchema: {
        entityName: z.string().describe('The entity this observation belongs to (e.g., "auth-module", "port-config")'),
        type: z.enum(OBSERVATION_TYPES).describe('Observation type for classification'),
        title: z.string().describe('Short descriptive title (~5-10 words)'),
        narrative: z.string().describe('Full description of the observation'),
        facts: z.array(z.string()).optional().describe('Structured facts (e.g., "Default timeout: 60s")'),
        filesModified: z.array(z.string()).optional().describe('Files involved'),
        concepts: z.array(z.string()).optional().describe('Related concepts/keywords'),
        topicKey: z.string().optional().describe(
          'Optional topic identifier for upserts (e.g., "architecture/auth-model"). ' +
          'If an observation with the same topicKey already exists in this project, it will be UPDATED instead of creating a new one. ' +
          'Use baton_suggest_topic_key to generate a stable key. Good for evolving decisions, architecture docs, etc.',
        ),
        progress: z.object({
          feature: z.string().describe('Feature or task name'),
          status: z.enum(['in-progress', 'completed', 'blocked']).describe('Current status'),
          completion: z.number().optional().describe('Completion percentage 0-100'),
        }).optional().describe('Progress tracking for task/feature observations'),
        relatedCommits: z.array(z.string()).optional().describe('Git commit hashes this memory relates to (links ground truth ↔ reasoning)'),
        relatedEntities: z.array(z.string()).optional().describe('Other entity names this memory cross-references'),
        visibility: z.enum(['personal', 'project', 'team']).optional().describe(
          'Retrieval scope. Project is the normal shared default; personal/team require baton_session_start with joinTeam=true.',
        ),
        longTerm: z.object({
          kind: z.enum(['episodic', 'semantic', 'procedural']).describe('Cognitive kind for an additional long-term candidate.'),
          scope: z.enum(['project', 'user', 'team']).optional().default('project').describe('Long-term scope. User capture is private source evidence and needs a bound agent identity.'),
          tags: z.array(z.string()).optional().describe('Small set of retrieval tags for the candidate.'),
          applicability: z.string().optional().describe('When this durable fact or procedure applies.'),
        }).optional().describe('Optional explicit request to create a source-backed long-term candidate alongside this observation. Candidates are not automatically injected.'),
        overrideReadOnly: z.boolean().optional().describe(
          'Use only when the user explicitly asks to save memory during a read-only or no-modification task.',
        ),
        attachments: z.array(z.object({
          modality: z.enum(['image', 'audio', 'video', 'document']),
          url: z.string().describe(
            'Public HTTPS provenance reference without query parameters or fragments. ' +
            'Baton does not fetch this URL: attachment metadata is persisted and BM25-searchable, while observation vectors remain text-only.',
          ),
          mimeType: z.string().optional(),
          name: z.string().optional(),
        })).optional().describe('Safe public provenance references. They are stored as metadata for lexical retrieval; raw inline media is never stored.'),
      },
    },
    async ({ entityName: rawEntityName, type: rawType, title: rawTitle, narrative, facts, filesModified, concepts, topicKey, progress, relatedCommits, relatedEntities, visibility, longTerm, overrideReadOnly, attachments }) => {
      const unresolved = ctx.requireResolvedProject('store memory in the current project');
      if (unresolved) return unresolved;
      const readOnlyBoundary = ctx.blockReadOnlyAutopilotWrite(overrideReadOnly);
      if (readOnlyBoundary) return readOnlyBoundary;
      // Keep visibility undefined for an ordinary upsert. storeObservation then
      // preserves an existing targeted/personal record instead of silently
      // widening it to project scope. A long-term scope is explicit and must
      // still set the source observation's corresponding visibility.
      const requestedVisibility = (
        longTerm?.scope === 'user'
          ? 'personal'
          : longTerm?.scope === 'team'
            ? 'team'
            : visibility
      ) as 'personal' | 'project' | 'team' | undefined;
      const effectiveVisibility = requestedVisibility ?? 'project';
      const reader = ctx.getObservationReader();
      if (effectiveVisibility !== 'project' && !ctx.currentAgentId) {
        return {
          content: [{ type: 'text' as const, text: 'Personal or team memory requires baton_session_start with joinTeam=true so Baton can bind an owner.' }],
          isError: true as const,
        };
      }
      if (effectiveVisibility === 'team' && !reader.isTeamMember) {
        return {
          content: [{ type: 'text' as const, text: 'Team memory requires an active coordination membership in the current project.' }],
          isError: true as const,
        };
      }
      if (longTerm?.scope === 'team' && !reader.isTeamMember) {
        return {
          content: [{ type: 'text' as const, text: 'Team long-term memory requires an active coordination membership in the current project.' }],
          isError: true as const,
        };
      }
      try {
      return await withFreshIndex(async () => {

      // Mutable copies — Formation Pipeline may improve these
      let entityName = rawEntityName;
      let type = rawType;
      let title = rawTitle;
      // Defensive coercion: Claude Code CLI + GLM may send string-encoded arrays
      let safeFacts = facts ? coerceStringArray(facts) : undefined;
      const safeFiles = filesModified ? coerceStringArray(filesModified) : undefined;
      const safeConcepts = concepts ? coerceStringArray(concepts) : undefined;

      // ── Determine decision maker based on Formation mode ─────────────
      // Priority: env var override > config.json > default (active)
      // - shadow: Formation observes only, old compact decides
      // - active: Formation decides storage behavior (new/merge/evolve/discard) [default]
      // - fallback: old compact decides (safe rollback)
      let formationMode: 'shadow' | 'active' | 'fallback' = 'active';
      if (process.env.BATON_FORMATION_MODE) {
        formationMode = process.env.BATON_FORMATION_MODE as typeof formationMode;
      } else {
        try {
          const { getBehaviorConfig } = await import('../../config/behavior.js');
          formationMode = getBehaviorConfig({ projectRoot: ctx.project.rootPath }).formationMode;
        } catch { /* default to active */ }
      }
      const useFormation = formationMode === 'active';

      // ── Formation Pipeline (active mode: decides storage) ─────────────
      let formationResult: FormedMemory | null = null;
      let formationNote = '';
      if (useFormation && !topicKey && !progress && !longTerm) {
        let currentFormationStage: FormationStage | 'setup' = 'setup';
        const completedFormationStages: Partial<Record<FormationStage, number>> = {};
        const formationStartTime = Date.now();
        const onFormationStageEvent = (event: FormationStageEvent): void => {
          if (event.status === 'start') {
            currentFormationStage = event.stage;
            return;
          }
          currentFormationStage = event.stage;
          if (event.stageDurationMs !== undefined) {
            completedFormationStages[event.stage] = event.stageDurationMs;
    }
  };

        try {
          const formationConfig: FormationConfig = {
            mode: 'active',
            useLLM: isLLMEnabled(),
            minValueScore: 0.3,
            searchMemories: async (q: string, limit: number, pid: string, signal?: AbortSignal): Promise<SearchHit[]> => {
              const result = await compactSearch({ query: q, limit, projectId: pid, status: 'active', reader, signal });
              if (result.entries.length === 0) return [];
              const details = await compactDetail(result.entries.map(e => e.id), { reader });
              return details.documents.map((d, i) => ({
                id: Number(d.id.replace('obs-', '')),
                observationId: d.observationId,
                title: d.title,
                narrative: d.narrative,
                facts: d.facts,
                entityName: d.entityName,
                type: d.type,
                score: result.entries[i]?.score ?? 0,
              }));
            },
            getObservation: (id: number) => {
              const o = getObservation(id);
              if (!o || o.projectId !== ctx.project.id || !canReadObservation(o, reader)) return null;
              return {
                id: o.id,
                entityName: o.entityName,
                type: o.type,
                title: o.title,
                narrative: o.narrative,
                facts: o.facts,
                topicKey: o.topicKey,
              };
            },
            getEntityNames: () => ctx.graphManager.getEntityNames(),
            onStageEvent: onFormationStageEvent,
          };

          formationResult = await withTimeoutSignal(async (signal) => {
            formationConfig.signal = signal;
            return runFormation({
              entityName,
              type: type as ObservationType,
              title,
              narrative,
              facts: safeFacts,
              projectId: ctx.project.id,
              source: 'explicit',
            }, formationConfig);
          },
            FORMATION_TIMEOUT_MS,
            'Formation pipeline',
          );

          const modeIcon = '[FAST]';
          formationNote = `\n${modeIcon} Formation[active]: ${formationResult.evaluation.category} (${formationResult.evaluation.score.toFixed(2)}) | ${formationResult.resolution.action} | ${formationResult.pipeline.durationMs}ms`;
          if (formationResult.extraction.extractedFacts.length > 0) {
            formationNote += ` | +${formationResult.extraction.extractedFacts.length} facts`;
          }
          if (formationResult.extraction.titleImproved) formationNote += ' | title↑';
          if (formationResult.extraction.entityResolved) formationNote += ` | entity→${formationResult.entityName}`;
          if (formationResult.extraction.typeCorrected) formationNote += ` | type→${formationResult.type}`;
        } catch (formationErr) {
          // Formation timeout or failure → fall through to store without enrichment
          const isTimeout = formationErr instanceof Error && formationErr.message.includes('timed out');
          const elapsedMs = Date.now() - formationStartTime;
          const stageSummary = formatFormationStageDurations(completedFormationStages);
          console.error(
            `[baton] Formation ${isTimeout ? 'timed out' : 'failed'} in baton_store after ${elapsedMs}ms/${FORMATION_TIMEOUT_MS}ms at stage ${currentFormationStage}${stageSummary ? ` | completed: ${stageSummary}` : ''}`,
          );
          if (!isTimeout && formationErr instanceof Error) {
            console.error(`[baton] Formation error: ${formationErr.message}`);
          }
          formationNote = `\n[WARN] Formation ${isTimeout ? 'timed out' : 'failed'} — storing base observation without enrichment`;
        }
      }

      // ── Apply Formation decision (active mode only) ───────────────────
      if (useFormation && formationResult && formationResult.resolution.action !== 'new') {
        const { action, targetId, reason } = formationResult.resolution;

        if (action === 'merge' && targetId) {
          // Merge into existing observation
          const targetObs = getObservation(targetId);
          if (targetObs && targetObs.projectId === ctx.project.id && canReadObservation(targetObs, reader)) {
            await storeObservation({
              entityName: targetObs.entityName,
              type: targetObs.type,
              title: formationResult.title,
              narrative: formationResult.narrative,
              facts: formationResult.facts,
              filesModified: safeFiles,
              concepts: safeConcepts,
              projectId: ctx.project.id,
              topicKey: targetObs.topicKey,
              progress: progress as import('../../types.js').ProgressInfo | undefined,
              sourceDetail: 'explicit',
              createdByAgentId: ctx.currentAgentId,
              visibility,
              visibilityReader: reader,
            });
            return {
              content: [{
                type: 'text' as const,
                text: `[UPDATED] Formation MERGE: merged into #${targetId} (${reason})${formationNote}`,
              }],
            };
          }
        } else if (action === 'evolve' && targetId) {
          // Evolve existing observation
          const targetObs = getObservation(targetId);
          if (targetObs && targetObs.projectId === ctx.project.id && canReadObservation(targetObs, reader)) {
            await storeObservation({
              entityName: targetObs.entityName,
              type: targetObs.type,
              title: formationResult.title,
              narrative: formationResult.narrative,
              facts: formationResult.facts,
              filesModified: safeFiles,
              concepts: safeConcepts,
              projectId: ctx.project.id,
              topicKey: targetObs.topicKey,
              progress: progress as import('../../types.js').ProgressInfo | undefined,
              sourceDetail: 'explicit',
              createdByAgentId: ctx.currentAgentId,
              visibility,
              visibilityReader: reader,
            });
            return {
              content: [{
                type: 'text' as const,
                text: `[UPDATED] Formation EVOLVE: evolved #${targetId} (${reason})${formationNote}`,
              }],
            };
          }
        } else if (action === 'discard') {
          // Skip storing entirely
          return {
            content: [{
              type: 'text' as const,
              text: `[SKIP] Formation DISCARD: ${reason}${formationNote}`,
            }],
          };
        }
      }

      // ── Compact on Write (fallback mode or Formation said 'new') ───────
      // Search for similar existing memories BEFORE storing.
      // If compact says UPDATE → merge into existing; NONE → skip storing.
      // This keeps memory count low and prevents duplication (Mem0-style).
      let compactAction = '';
      let compactMerged = false;
      if (!useFormation && !topicKey && !progress && !longTerm) {
        try {
          const searchResult = await compactSearch({
            query: `${title} ${narrative.substring(0, 200)}`,
            limit: 5,
            projectId: ctx.project.id,
            status: 'active',
            reader,
          });
          const similarEntries = searchResult.entries.map(e => e);
          if (similarEntries.length > 0) {
            // Fetch full details for comparison
            const similarIds = similarEntries.map(e => e.id);
            const details = await compactDetail(similarIds, { reader });
            const existingMemories: ExistingMemory[] = details.documents.map((d, i) => ({
              id: d.observationId,
              title: d.title,
              narrative: d.narrative,
              facts: d.facts,
              score: similarEntries[i]?.score ?? 0,
            }));

            const decision = await withTimeout(
              compactOnWrite(
                { title, narrative, facts: safeFacts ?? [] },
                existingMemories,
              ),
              COMPACT_ON_WRITE_TIMEOUT_MS,
              'Compact-on-write',
            );

            if (decision.action === 'UPDATE' && decision.targetId) {
              // Merge into existing memory (Mem0-style UPDATE)
              const targetObs = getObservation(decision.targetId);
              if (targetObs && targetObs.projectId === ctx.project.id && canReadObservation(targetObs, reader)) {
                await storeObservation({
                  entityName: targetObs.entityName,
                  type: targetObs.type,
                  title: decision.mergedNarrative ? title : targetObs.title,
                  narrative: decision.mergedNarrative ?? narrative,
                  facts: decision.mergedFacts ?? safeFacts,
                  filesModified: safeFiles,
                  concepts: safeConcepts,
                  projectId: ctx.project.id,
                  topicKey: targetObs.topicKey,
                  progress: progress as import('../../types.js').ProgressInfo | undefined,
                  sourceDetail: 'explicit',
                  createdByAgentId: ctx.currentAgentId,
                  visibility,
                  visibilityReader: reader,
                });
                compactAction = `[UPDATED] Compact UPDATE: merged into #${decision.targetId} (${decision.reason})`;
                compactMerged = true;

                // Return early — we updated existing, no new observation needed
                return {
                  content: [{
                    type: 'text' as const,
                    text: `${compactAction}\nMode: ${decision.usedLLM ? 'LLM' : 'heuristic'}`,
                  }],
                };
              }
            } else if (decision.action === 'NONE') {
              // Memory is redundant — skip storing entirely
              return {
                content: [{
                  type: 'text' as const,
                  text: `[SKIP] Compact SKIP: ${decision.reason}\nExisting memory #${decision.targetId} already covers this.\nMode: ${decision.usedLLM ? 'LLM' : 'heuristic'}`,
                }],
              };
            } else if (decision.action === 'DELETE' && decision.targetId) {
              // Old memory is outdated — resolve it, then ADD the new one
              const { resolveObservations } = await import('../../memory/observations.js');
              await resolveObservations([decision.targetId], 'resolved');
              compactAction = ` | Compact: resolved outdated #${decision.targetId}`;
            }
            // decision.action === 'ADD' or DELETE fallthrough → proceed to store normally
            if (decision.enrichedFacts && decision.enrichedFacts.length > 0) {
              // LLM extracted additional facts — merge them in
              const currentFacts = safeFacts ?? [];
              const newFacts = decision.enrichedFacts.filter((f: string) => !currentFacts.includes(f));
              if (newFacts.length > 0) {
                compactAction += ` | +${newFacts.length} LLM-extracted facts`;
              }
            }
          }
        } catch { /* compact is best-effort */ }
      }

      // ── Apply Formation enrichments for 'new' action ─────────────────
      // When Formation decided 'new', merge LLM-extracted facts into the store.
      if (formationResult && formationResult.resolution.action === 'new') {
        const llmFacts = formationResult.extraction.extractedFacts;
        if (llmFacts.length > 0) {
          const currentFacts = safeFacts ?? [];
          const currentLower = new Set(currentFacts.map(f => f.toLowerCase().trim()));
          const newFacts = llmFacts.filter(f => !currentLower.has(f.toLowerCase().trim()));
          if (newFacts.length > 0) {
            safeFacts = [...currentFacts, ...newFacts];
          }
        }
        if (formationResult.extraction.titleImproved && formationResult.title) {
          title = formationResult.title;
        }
        if (formationResult.extraction.typeCorrected && formationResult.type) {
          type = formationResult.type;
        }
        if (formationResult.extraction.entityResolved && formationResult.entityName) {
          entityName = formationResult.entityName;
        }
      }

      // ── Standard store flow ─────────────────────────────────────────
      // Ensure entity exists in knowledge graph
      await ctx.graphManager.createEntities([
        { name: entityName, entityType: 'auto', observations: [] },
      ]);

      // Auto-associate sessionId from active session
      let sessionId: string | undefined;
      try {
        sessionId = await ctx.resolveConnectionSessionId();
      } catch { /* session module not critical */ }

      // ── LLM Narrative Compression (premium quality) ─────────────────
      // Compress verbose narratives into concise core knowledge before storing.
      // Reduces token consumption ~60% while preserving all technical facts.
      let finalNarrative = narrative;
      let compressionNote = '';
      try {
        const { compressNarrative } = await import('../../llm/quality.js');
        const { compressed, saved, usedLLM } = await withTimeout(
          compressNarrative(narrative, safeFacts, type),
          COMPRESSION_TIMEOUT_MS,
          'Narrative compression',
        );
        if (usedLLM && saved > 0) {
          finalNarrative = compressed;
          compressionNote = ` | compressed -${saved} tokens`;
        }
      } catch { /* compression is best-effort (timeout or LLM failure) */ }

      // ── Attribution guard (passive, non-blocking) ─────────────────
      // Warns when entityName is unknown in this project but well-established
      // in a different project — signals a potential wrong-bucket write.
      let attributionWarning = '';
      try {
        const attrCheck = await checkProjectAttribution(
          entityName,
          ctx.project.id,
          filterReadableObservations(getAllObservations(), reader),
        );
        if (attrCheck.suspicious) {
          attributionWarning = `\n[WARN] Attribution notice: entity "${entityName}" has 0 observations in ` +
            `"${ctx.project.id}" but ${attrCheck.count} in "${attrCheck.knownIn}" ` +
            `(confidence: ${attrCheck.confidence}). Verify the correct project is bound before storing.`;
        }
      } catch { /* guard is best-effort — never blocks the write */ }

      // Store the observation (may upsert if topicKey matches existing)
      const { observation: obs, upserted } = await storeObservation({
        entityName,
        type: type as ObservationType,
        title,
        narrative: finalNarrative,
        facts: safeFacts,
        filesModified: safeFiles,
        concepts: safeConcepts,
        projectId: ctx.project.id,
        topicKey,
        sessionId,
        progress: progress as import('../../types.js').ProgressInfo | undefined,
        relatedCommits,
        relatedEntities,
        attachments,
        sourceDetail: 'explicit',
        valueCategory: formationResult?.evaluation.category,
        createdByAgentId: ctx.currentAgentId,
        visibility: requestedVisibility,
        visibilityReader: reader,
      });

      let longTermNote = '';
      if (longTerm) {
        try {
          const { promoteObservationToLongTermMemory, maybeAutoQualifyLongTermMemory } = await import('../../memory/long-term.js');
          const promoted = await promoteObservationToLongTermMemory({
            dataDir: ctx.projectDir,
            observation: obs,
            scope: longTerm.scope,
            kind: longTerm.kind,
            tags: longTerm.tags,
            applicability: longTerm.applicability,
            reader: {
              projectId: ctx.project.id,
              ...(reader.agentId ? { agentId: reader.agentId } : {}),
              ...(reader.isTeamMember ? { isTeamMember: true } : {}),
            },
          });
          // An explicit store call carries its own source evidence: qualify
          // on the spot instead of waiting for a manual CLI review.
          const autoQualified = await maybeAutoQualifyLongTermMemory({
            dataDir: ctx.projectDir,
            id: promoted.memory.id,
            sourceDetail: 'explicit',
          });
          if (autoQualified) {
            // A fresh explicit record retires stale same-title records on the
            // durable rule leg instead of waiting for the next session start.
            try {
              const { enqueueLongTermMaintenance } = await import('../../runtime/lifecycle.js');
              enqueueLongTermMaintenance({
                dataDir: ctx.projectDir,
                projectId: ctx.project.id,
                source: 'long-term:' + promoted.memory.id,
              });
            } catch { /* maintenance is optional; the record already qualified */ }
          }
          longTermNote = autoQualified
            ? `\nLong-term memory: ${promoted.memory.id} (${promoted.memory.kind}/${promoted.memory.scope}, auto-qualified) and now enters briefs as durable context. Audit with \`baton memory long-term list\`.`
            : `\nLong-term candidate: ${promoted.memory.id} (${promoted.memory.kind}/${promoted.memory.scope}). Review it with the CLI before it is delivered automatically.`;
        } catch (longTermError) {
          longTermNote = `\n[WARN] Observation stored, but long-term candidate was not created: ${longTermError instanceof Error ? longTermError.message : 'unknown error'}`;
        }
      }

      // Add a reference to the entity's observations
      await ctx.graphManager.addObservations([
        { entityName, contents: [`[#${obs.id}] ${title}`] },
      ]);

      // Implicit memory: auto-create relations from entity extraction
      const extracted = extractEntities([title, narrative, ...(safeFacts ?? [])].join(' '));
      const autoRelCount = await createAutoRelations(obs, extracted, ctx.graphManager);

      // Build enrichment summary
      const enrichmentParts: string[] = [];
      const autoFiles = obs.filesModified.filter((f: string) => !(safeFiles ?? []).includes(f));
      const autoConcepts = obs.concepts.filter((c: string) => !(safeConcepts ?? []).includes(c));
      if (autoFiles.length > 0) enrichmentParts.push(`+${autoFiles.length} files extracted`);
      if (autoConcepts.length > 0) enrichmentParts.push(`+${autoConcepts.length} concepts enriched`);
      if (autoRelCount > 0) enrichmentParts.push(`+${autoRelCount} relations auto-created`);
      if (obs.hasCausalLanguage) enrichmentParts.push('causal language detected');
      if (upserted) enrichmentParts.push(`topic upserted (rev ${obs.revisionCount ?? 1})`);
      const enrichment = enrichmentParts.length > 0 ? `\nAuto-enriched: ${enrichmentParts.join(', ')}` : '';

      const action = upserted ? '[UPDATED] Updated' : '[OK] Stored';

      // ── Formation Pipeline (shadow/fallback mode: observe only) ─────
      // Fire-and-forget: runs after storage to collect metrics.
      // Never blocks the MCP response — purely for A/B comparison data.
      if (!useFormation && !topicKey && !progress && !longTerm) {
        const shadowFormation = async () => {
          let oldCompactDecision: { action: string, targetId?: number, reason?: string, durationMs?: number } | null = null;
          try {
            const compactStart = Date.now();
            const searchResult = await compactSearch({
              query: `${title} ${narrative.substring(0, 200)}`,
            limit: 5,
            projectId: ctx.project.id,
            status: 'active',
            reader,
            });
            const similarEntries = searchResult.entries.map(e => e);
            if (similarEntries.length > 0) {
              const similarIds = similarEntries.map(e => e.id);
              const details = await compactDetail(similarIds, { reader });
              const existingMemories: ExistingMemory[] = details.documents.map((d, i) => ({
                id: d.observationId,
                title: d.title,
                narrative: d.narrative,
                facts: d.facts,
                score: similarEntries[i]?.score ?? 0,
              }));
              const decision = await compactOnWrite(
                { title, narrative, facts: safeFacts ?? [] },
                existingMemories,
              );
              oldCompactDecision = {
                action: decision.action,
                targetId: decision.targetId,
                reason: decision.reason,
                durationMs: Date.now() - compactStart,
              };
            }
          } catch { /* best-effort */ }

          const formationConfig: FormationConfig = {
            mode: formationMode,
            useLLM: isLLMEnabled(),
            minValueScore: 0.3,
            searchMemories: async (q: string, limit: number, pid: string, signal?: AbortSignal): Promise<SearchHit[]> => {
              const result = await compactSearch({ query: q, limit, projectId: pid, status: 'active', reader, signal });
              if (result.entries.length === 0) return [];
              const details = await compactDetail(result.entries.map(e => e.id), { reader });
              return details.documents.map((d, i) => ({
                id: Number(d.id.replace('obs-', '')),
                observationId: d.observationId,
                title: d.title,
                narrative: d.narrative,
                facts: d.facts,
                entityName: d.entityName,
                type: d.type,
                score: result.entries[i]?.score ?? 0,
              }));
            },
            getObservation: (id: number) => {
              const o = getObservation(id);
              if (!o || o.projectId !== ctx.project.id || !canReadObservation(o, reader)) return null;
              return { id: o.id, entityName: o.entityName, type: o.type, title: o.title, narrative: o.narrative, facts: o.facts, topicKey: o.topicKey };
            },
            getEntityNames: () => ctx.graphManager.getEntityNames(),
          };

          const formed = await withTimeoutSignal(async (signal) => {
            formationConfig.signal = signal;
            return runFormation({ entityName, type: type as ObservationType, title, narrative, facts: safeFacts, projectId: ctx.project.id, source: 'explicit', topicKey }, formationConfig);
          },
            FORMATION_TIMEOUT_MS,
            'Shadow formation',
          );

          const { recordBeforeAfterMetrics } = await import('../../memory/formation/index.js');
          if (oldCompactDecision) {
            recordBeforeAfterMetrics({
              formationAction: formed.resolution.action,
              formationTargetId: formed.resolution.targetId,
              oldCompactAction: oldCompactDecision.action as 'ADD' | 'UPDATE' | 'NONE' | 'DELETE',
              oldCompactTargetId: oldCompactDecision.targetId,
              oldCompactReason: oldCompactDecision.reason,
              formationValueScore: formed.evaluation.score,
              formationValueCategory: formed.evaluation.category,
              formationDurationMs: formed.pipeline.durationMs,
              compactDurationMs: oldCompactDecision.durationMs,
            });
          }
        };
        // Fire-and-forget — do not await
        shadowFormation().catch(() => {});
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `${action} observation #${obs.id} "${title}" (~${obs.tokens} tokens)\nEntity: ${entityName} | Type: ${type} | Project: ${ctx.project.id}${obs.topicKey ? ` | Topic: ${obs.topicKey}` : ''}${compactAction}${compressionNote}${enrichment}${formationNote}${attributionWarning}${longTermNote}`,
          },
        ],
      };
      }); // withFreshIndex
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: error instanceof Error ? error.message : 'Failed to store memory.',
          }],
          isError: true as const,
        };
      }
    },
  );

  /**
   * baton_suggest_topic_key — Suggest a stable topic key for upserts
   *
   * Use before baton_store when you want evolving topics to upsert
   * into a single observation instead of creating duplicates.
   */
  server.registerTool(
    'baton_suggest_topic_key',
    {
      title: 'Suggest Topic Key',
      description:
        'Suggest a stable topic_key for memory upserts. Use this before baton_store when you want evolving topics ' +
        '(like architecture decisions, config docs) to update a single observation over time instead of creating duplicates. ' +
        'Returns a key like "architecture/auth-model" or "bug/timeout-in-api-gateway".',
      inputSchema: {
        type: z.string().describe('Observation type (e.g., decision, architecture, bugfix, discovery)'),
        title: z.string().describe('Observation title — used to generate the stable key'),
      },
    },
    async ({ type: obsType, title }) => {
      const { suggestTopicKey } = await import('../../memory/observations.js');
      const key = suggestTopicKey(obsType, title);

      if (!key) {
        return {
          content: [{ type: 'text' as const, text: 'Could not suggest topic_key from the given input. Provide a more descriptive title.' }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Suggested topic_key: \`${key}\`\n\nUse this as the \`topicKey\` parameter in \`baton_store\` to enable upsert behavior.` }],
      };
    },
  );

  /**
   * baton_resolve — Mark memories as resolved/completed
   *
   * Prevents resolved memories from polluting future searches.
   * Default search only returns 'active' memories.
   */
  server.registerTool(
    'baton_resolve',
    {
      title: 'Resolve Memories',
      description:
        'Mark observations as resolved (completed/no longer active). ' +
        'Resolved memories are hidden from default search but can still be found with status="all". ' +
        'Use this to mark completed tasks, fixed bugs, or outdated information so they don\'t pollute future context.',
      inputSchema: {
        ids: z.array(z.number()).describe('Observation IDs to mark as resolved'),
        status: z.enum(['resolved', 'archived']).optional().default('resolved').describe(
          'Target status: "resolved" (default, completed/done) or "archived" (permanently hidden)',
        ),
      },
    },
    async ({ ids, status }) => {
      const { resolveObservations, getObservation } = await import('../../memory/observations.js');
      const safeIds = (Array.isArray(ids) ? ids : [ids]).map(id => coerceNumber(id, 0)).filter(id => id > 0);
      const reader = ctx.getObservationReader();
      const authorizedIds = safeIds.filter((id) => {
        const observation = getObservation(id, ctx.project.id);
        return observation ? canManageObservation(observation, reader) : false;
      });
      const result = await resolveObservations(authorizedIds, (status as 'resolved' | 'archived') ?? 'resolved');
      const deniedCount = safeIds.length - authorizedIds.length;

      const parts: string[] = [];
      if (result.resolved.length > 0) {
        parts.push(`[OK] Resolved ${result.resolved.length} observation(s): #${result.resolved.join(', #')}`);
      }
      if (result.notFound.length > 0) {
        parts.push(`[WARN] Not found: #${result.notFound.join(', #')}`);
      }
      if (deniedCount > 0) {
        parts.push(`[WARN] Skipped ${deniedCount} observation(s) outside this session's write scope.`);
      }
      parts.push('\nResolved memories are hidden from default search. Use status="all" to include them.');
      parts.push('[STATS] Run `baton_retention` with `action: "report"` to check remaining cleanup status.');

      return {
        content: [{ type: 'text' as const, text: parts.join('\n') }],
      };
    },
  );

  /**
   * baton_store_reasoning — System 2 Reasoning Memory
   *
   * Store WHY a decision was made, what alternatives were considered,
   * and what the expected outcome is. This is the "reasoning trace" —
   * not just what changed, but the thought process behind it.
   *
   * Inspired by Cipher's dual-memory (Knowledge + Reflection).
   */
  server.registerTool(
    'baton_store_reasoning',
    {
      title: 'Store Reasoning Trace',
      description:
        'Store a reasoning trace — WHY you chose this approach, what alternatives you considered, ' +
        'and what outcome you expect. This creates a searchable record of your decision-making process. ' +
        'Use this when making non-trivial technical decisions, choosing between approaches, or ' +
        'solving complex problems. Unlike regular memories that record WHAT happened, reasoning ' +
        'memories record HOW you thought about it.',
      inputSchema: {
        entityName: z.string().describe('The entity this reasoning applies to (e.g., "auth-module", "database-schema")'),
        decision: z.string().describe('What was decided or chosen'),
        alternatives: z.array(z.string()).optional().describe('Other options that were considered'),
        rationale: z.string().describe('Why this approach was chosen over alternatives'),
        constraints: z.array(z.string()).optional().describe('Constraints that influenced the decision (time, perf, compat, etc.)'),
        expectedOutcome: z.string().optional().describe('What outcome is expected from this decision'),
        risks: z.array(z.string()).optional().describe('Known risks or potential downsides'),
        concepts: z.array(z.string()).optional().describe('Related technical concepts'),
        filesModified: z.array(z.string()).optional().describe('Files related to this reasoning'),
        relatedCommits: z.array(z.string()).optional().describe('Git commit hashes this reasoning explains (links ground truth ↔ reasoning)'),
        relatedEntities: z.array(z.string()).optional().describe('Other entity names this reasoning relates to (cross-references)'),
      },
    },
    async ({ entityName, decision, alternatives, rationale, constraints, expectedOutcome, risks, concepts, filesModified, relatedCommits, relatedEntities }) => {
      const unresolved = ctx.requireResolvedProject('store reasoning in the current project');
      if (unresolved) return unresolved;
      const reader = ctx.getObservationReader();
      return withFreshIndex(async () => {

      // Build structured narrative from reasoning fields
      const narrativeParts: string[] = [rationale];
      if (alternatives && alternatives.length > 0) {
        narrativeParts.push(`Alternatives considered: ${alternatives.join('; ')}`);
      }
      if (constraints && constraints.length > 0) {
        narrativeParts.push(`Constraints: ${constraints.join('; ')}`);
      }
      if (expectedOutcome) {
        narrativeParts.push(`Expected outcome: ${expectedOutcome}`);
      }
      const narrative = narrativeParts.join('. ');

      // Build facts from structured fields
      const facts: string[] = [`Decision: ${decision}`];
      if (alternatives) alternatives.forEach(a => facts.push(`Alternative considered: ${a}`));
      if (constraints) constraints.forEach(c => facts.push(`Constraint: ${c}`));
      if (risks) risks.forEach(r => facts.push(`Risk: ${r}`));
      if (expectedOutcome) facts.push(`Expected outcome: ${expectedOutcome}`);

      await ctx.graphManager.createEntities([
        { name: entityName, entityType: 'auto', observations: [] },
      ]);

      // ── Attribution guard (passive, non-blocking) ─────────────────
      let reasoningAttributionWarning = '';
      try {
        const attrCheck = await checkProjectAttribution(
          entityName,
          ctx.project.id,
          filterReadableObservations(getAllObservations(), reader),
        );
        if (attrCheck.suspicious) {
          reasoningAttributionWarning = `\n[WARN] Attribution notice: entity "${entityName}" has 0 observations in ` +
            `"${ctx.project.id}" but ${attrCheck.count} in "${attrCheck.knownIn}" ` +
            `(confidence: ${attrCheck.confidence}). Verify the correct project is bound before storing.`;
        }
      } catch { /* guard is best-effort — never blocks the write */ }

      const { observation: obs } = await storeObservation({
        entityName,
        type: 'reasoning' as ObservationType,
        title: decision.length > 80 ? decision.substring(0, 77) + '...' : decision,
        narrative,
        facts,
        concepts: concepts ?? [],
        filesModified: filesModified ?? [],
        projectId: ctx.project.id,
        source: 'agent',
        relatedCommits,
        relatedEntities,
        sourceDetail: 'explicit',
        createdByAgentId: ctx.currentAgentId,
        visibility: 'project',
      });

      await ctx.graphManager.addObservations([
        { entityName, contents: [`[#${obs.id}] [REASONING] ${decision}`] },
      ]);

      return {
        content: [{
          type: 'text' as const,
          text: `[REASONING] Reasoning trace stored #${obs.id}: "${decision}"\nEntity: ${entityName} | ${facts.length} facts | ${obs.tokens} tokens${reasoningAttributionWarning}`,
        }],
      };
      }); // withFreshIndex
    },
  );

  /**
   * baton_deduplicate — LLM-powered batch deduplication
   *
   * Scans active memories for duplicates/contradictions and auto-resolves them.
   * Requires LLM to be configured (BATON_LLM_API_KEY or OPENAI_API_KEY).
   */
  server.registerTool(
    'baton_deduplicate',
    {
      title: 'Deduplicate Memories',
      description:
        'Scan active memories for duplicates, contradictions, and outdated information using LLM analysis. ' +
        'Automatically resolves redundant memories. Requires LLM to be configured ' +
        '(set BATON_LLM_API_KEY or OPENAI_API_KEY environment variable). ' +
        'Without LLM, falls back to basic similarity-based consolidation.',
      inputSchema: {
        query: z.string().optional().describe('Optional query to scope dedup to a topic (default: scan all)'),
        dryRun: z.boolean().optional().default(false).describe('Preview only — show what would be resolved without making changes'),
      },
    },
    async ({ query, dryRun }) => {
      const { getAllObservations, resolveObservations } = await import('../../memory/observations.js');
      const reader = ctx.getObservationReader();
      const allObs = await withFreshIndex(() => filterReadableObservations(
        getAllObservations().filter(o => (o.status ?? 'active') === 'active' && o.projectId === ctx.project.id),
        reader,
      ).filter((observation) => canManageObservation(observation, reader)));

      if (allObs.length < 2) {
        return { content: [{ type: 'text' as const, text: 'Not enough active memories to deduplicate.' }] };
      }

      if (!isLLMEnabled()) {
        return {
          content: [{
            type: 'text' as const,
            text: '[WARN] LLM not configured. Set BATON_LLM_API_KEY or OPENAI_API_KEY to enable intelligent dedup.\n\n' +
              'Tip: Use baton_consolidate for basic similarity-based merging without LLM.',
          }],
        };
      }

      // If query provided, search for relevant memories; otherwise take latest 20
      let candidates: typeof allObs;
      if (query) {
        const searchResult = await compactSearch({ query, limit: 20, projectId: ctx.project.id, status: 'active', reader });
        const idSet = new Set(searchResult.entries.map(e => e.id));
        candidates = allObs.filter(o => idSet.has(o.id));
      } else {
        candidates = allObs.slice(-20);
      }

      if (candidates.length < 2) {
        return { content: [{ type: 'text' as const, text: 'Not enough memories in scope to deduplicate.' }] };
      }

      const manageableCandidates = candidates.filter((observation) => canManageObservation(observation, reader));
      const plan = await planMemoryDeduplication(manageableCandidates);
      const actionLines = plan.actions.map((item) =>
        `Resolve #${item.resolveId} "${item.resolveTitle}"; keep #${item.keepId} "${item.keepTitle}" (${item.reason})${item.usedLLM ? ' [LLM]' : ' [heuristic]'}`,
      );

      if (actionLines.length === 0) {
        return { content: [{ type: 'text' as const, text: `[OK] Scanned ${plan.scanned} memories across ${plan.entities} entities — no duplicates found.` }] };
      }

      if (dryRun) {
        return {
          content: [{
            type: 'text' as const,
            text: `[SEARCH] DRY RUN — ${actionLines.length} action(s) found:\n\n${actionLines.join('\n')}\n\nRun with dryRun=false to apply.`,
          }],
        };
      }

      const result = await applyDeduplicationPlan(getObservationStore(), ctx.project.id, plan.resolveIds, reader);

      return {
        content: [{
          type: 'text' as const,
          text: `[CLEANUP] Deduplicated: resolved ${result.resolved.length} memory(ies)\n\n${actionLines.join('\n')}`,
        }],
      };
    },
  );

  // ============================================================
  // Memory Consolidation
  // ============================================================

  /**
   * baton_consolidate — Merge similar observations to reduce bloat
   */
  server.registerTool(
    'baton_consolidate',
    {
      title: 'Consolidate Memories',
      description:
        'Find and merge similar observations to reduce memory bloat. ' +
        'Uses text similarity to cluster related observations by entity+type, then merges them into single consolidated records. ' +
        'Use action="preview" to see candidates without changing data, action="execute" to merge.\n\n' +
        'Example: 10 similar gotchas about Windows paths → 1 consolidated gotcha with all facts preserved.',
      inputSchema: {
        action: z.enum(['preview', 'execute']).describe('preview = dry run showing candidates, execute = actually merge'),
        threshold: z.number().optional().describe('Similarity threshold 0.0-1.0 (default: 0.45). Lower = more aggressive merging'),
      },
    },
    async ({ action, threshold }) => {
      const safeThreshold = threshold != null ? coerceNumber(threshold, 0.45) : undefined;
      const { findConsolidationCandidates, executeConsolidation } = await import('../../memory/consolidation.js');

      if (action === 'preview') {
        const clusters = await findConsolidationCandidates(ctx.projectDir, ctx.project.id, { threshold: safeThreshold });

        if (clusters.length === 0) {
          return { content: [{ type: 'text' as const, text: '[OK] No consolidation candidates found. Your memories are already clean!' }] };
        }

        const lines = [`## Consolidation Preview`, `Found **${clusters.length}** clusters to merge:`, ''];
        for (let i = 0; i < clusters.length; i++) {
          const c = clusters[i];
          lines.push(`### Cluster ${i + 1} (${c.ids.length} observations, ~${(c.similarity * 100).toFixed(0)}% similar)`);
          lines.push(`Entity: \`${c.entityName}\` | Type: ${c.type}`);
          for (const title of c.titles) lines.push(`- ${title}`);
          lines.push('');
        }
        const totalMergeable = clusters.reduce((sum, c) => sum + c.ids.length - 1, 0);
        lines.push(`> Run with \`action: "execute"\` to merge. This will remove **${totalMergeable}** duplicate observations.`);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      // Execute
      const result = await executeConsolidation(ctx.projectDir, ctx.project.id, { threshold: safeThreshold });

      if (result.clustersFound === 0) {
        return { content: [{ type: 'text' as const, text: '[OK] No consolidation needed. Memories are already clean!' }] };
      }

      const lines = [
        `## Consolidation Complete`,
        `- Clusters merged: **${result.clustersFound}**`,
        `- Observations removed: **${result.observationsMerged}**`,
        `- Observations remaining: **${result.observationsAfter}**`,
        '',
      ];
      for (const m of result.merges) {
        lines.push(`- Merged [${m.mergedIds.join(', ')}] → "${m.resultTitle}" (${m.factCount} facts)`);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}
