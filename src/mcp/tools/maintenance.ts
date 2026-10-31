/**
 * Memory maintenance tools inherited from Memorix: memorix_audit_project, memorix_retention,
 * memorix_formation_metrics, memorix_transfer.
 *
 * Split out of src/server.ts without behaviour changes; connection state comes
 * from `ServerToolContext`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAllObservations } from '../../memory/observations.js';
import { withFreshIndex } from '../../memory/freshness.js';
import { auditProjectObservations } from '../../memory/attribution-guard.js';
import { canManageObservation, filterReadableObservations } from '../../memory/visibility.js';
import { getMetricsSummary, getBeforeAfterMetrics } from '../../memory/formation/index.js';
import type { ServerToolContext } from './server-context.js';


export function registerMaintenanceTools(server: McpServer, ctx: ServerToolContext): void {
  /**
   * memorix_audit_project — Scan for misattributed observations
   *
   * Read-only audit: identifies observations in the current project whose
   * entityName is well-known in a different project but absent here.
   * Use the results to decide which observations to archive with memorix_resolve.
   */
  server.registerTool(
    'memorix_audit_project',
    {
      title: 'Audit Project Attribution',
      description:
        'Scan the current project for observations that may have been written to the wrong project bucket. ' +
        'Identifies observations whose entityName appears exclusively in a different project. ' +
        'Read-only — no data is changed. Use memorix_resolve to archive confirmed mis-attributed observations.',
      inputSchema: {
        threshold: z.number().int().min(1).optional().describe(
          'Minimum occurrences of an entityName in another project to flag it as suspicious (default: 2)',
        ),
      },
    },
    async ({ threshold }) => {
      const unresolved = ctx.requireResolvedProject('audit project attribution');
      if (unresolved) return unresolved;
      const minCount = threshold ?? 2;
      let entries: import('../../memory/attribution-guard.js').AuditEntry[];
      try {
        entries = await auditProjectObservations(
          ctx.project.id,
          await withFreshIndex(() => filterReadableObservations(getAllObservations(), ctx.getObservationReader())),
          minCount,
        );
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Audit failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }

      if (entries.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `[OK] No suspicious observations found in project "${ctx.project.id}" (threshold: ${minCount}).`,
          }],
        };
      }

      const lines: string[] = [
        `## Attribution Audit — ${ctx.project.id}`,
        `Found **${entries.length}** potentially mis-attributed observation(s) (threshold: ≥${minCount} occurrences in another project).\n`,
        '| ID | Entity | Title | Source | Detail | Likely Belongs To | Count | Confidence |',
        '|----|--------|-------|--------|--------|-------------------|-------|------------|',
      ];

      for (const e of entries) {
        const titleTrunc = e.title.length > 50 ? e.title.slice(0, 47) + '...' : e.title;
        lines.push(
          `| #${e.id} | ${e.entityName} | ${titleTrunc} | ${e.source} | ${e.sourceDetail ?? '-'} | ${e.likelyBelongsTo} | ${e.count} | ${e.confidence} |`,
        );
      }

      // Actionable IDs block (cap display to avoid very long outputs)
      const auditIds = entries.map(e => e.id);
      const auditPreview = auditIds.slice(0, 20);
      const auditSummary = `[${auditPreview.join(', ')}]${auditIds.length > 20 ? ` … (${auditIds.length} total)` : ''}`;
      lines.push('');
      lines.push('### Suggested Actions');
      lines.push(`Suggested IDs: ${auditSummary}`);
      lines.push('- Archive confirmed mis-attributed observations: use `memorix_resolve` with the specific IDs above and `status: "archived"`.');
      lines.push('- Review first with `memorix_detail` if unsure.');

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  // ================================================================
  // Memorix Retention & Decay Tools (inspired by mcp-memory-service + MemCP)
  // ================================================================

  /**
   * memorix_retention — Memory retention status
   *
   * Shows which observations are active, stale, or candidates for archiving.
   * Uses exponential decay scoring from mcp-memory-service.
   */
  server.registerTool(
    'memorix_retention',
    {
      title: 'Memory Retention Status & Archive',
      description:
        'Show memory retention status or archive expired memories. ' +
        'action="report" (default): show active/stale/archive-candidate counts. ' +
        'action="archive": move expired observations to archive file (reversible). ' +
        'action="stale": list stale observations with full retention explanation. ' +
        'Uses exponential decay scoring based on importance, age, and access patterns.',
      inputSchema: {
        action: z.enum(['report', 'archive', 'stale']).optional().describe('Action: "report" (show status, default) or "archive" (move expired to archive) or "stale" (list stale observations with explanation)'),
      },
    },
    async (args: { action?: string }) => {
      const action = args.action ?? 'report';
      const { getRetentionSummary, getArchiveCandidates, rankByRelevance, getRetentionZone, explainRetention } = await import('../../memory/retention.js');
      const { getDb } = await import('../../store/orama-store.js');
      const { search } = await import('@orama/orama');

      // Shared: build MemorixDocument[] from in-memory observations
      const { getAllObservations, resolveObservations } = await import('../../memory/observations.js');
      const reader = ctx.getObservationReader();
      const allObs = await withFreshIndex(() => filterReadableObservations(
        getAllObservations().filter((observation) => observation.projectId === ctx.project.id),
        reader,
      ));

      // Pull current access metadata from the live Orama index so access-based
      // immunity (e.g. accessCount >= 3) still works in retention/report/archive
      // paths even though observations.json itself does not persist those fields.
      const accessMap = new Map<number, { accessCount: number; lastAccessedAt: string }>();
      try {
        const database = await getDb();
        const accessResults = await search(database, {
          term: '',
          limit: Math.max(1, allObs.length),
        });
        for (const hit of accessResults.hits) {
          const doc = hit.document as unknown as import('../../types.js').MemorixDocument;
          accessMap.set(doc.observationId, {
            accessCount: doc.accessCount ?? 0,
            lastAccessedAt: doc.lastAccessedAt ?? '',
          });
        }
      } catch {
        // Best-effort: retention still works without access metadata, just with
        // less precise immunity/reporting.
      }

      const docs: import('../../types.js').MemorixDocument[] = allObs.map(obs => ({
        id: `obs-${obs.id}`,
        observationId: obs.id,
        entityName: obs.entityName,
        type: obs.type,
        title: obs.title,
        narrative: obs.narrative,
        facts: obs.facts.join('\n'),
        filesModified: obs.filesModified.join('\n'),
        concepts: obs.concepts.join(', '),
        tokens: obs.tokens,
        createdAt: obs.createdAt,
        projectId: obs.projectId,
        accessCount: accessMap.get(obs.id)?.accessCount ?? 0,
        lastAccessedAt: accessMap.get(obs.id)?.lastAccessedAt ?? '',
        status: obs.status ?? 'active',
        source: obs.source ?? 'agent',
        sourceDetail: obs.sourceDetail ?? '',
        valueCategory: obs.valueCategory ?? '',
        admissionState: obs.admissionState ?? '',
        admissionReason: obs.admissionReason ?? '',
        visibility: obs.visibility ?? 'project',
        createdByAgentId: obs.createdByAgentId ?? '',
        sharedWithAgentIds: JSON.stringify(obs.sharedWithAgentIds ?? []),
      }));

      if (docs.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No observations found for this project.' }],
        };
      }

      if (action === 'archive') {
        const managedIds = new Set(
          allObs
            .filter((observation) => canManageObservation(observation, reader))
            .map((observation) => observation.id),
        );
        const candidates = getArchiveCandidates(docs).filter((document) => managedIds.has(document.observationId));
        if (candidates.length === 0) {
          return {
            content: [{ type: 'text' as const, text: '[OK] No expired memories in this session\'s write scope to archive.' }],
          };
        }
        const result = await resolveObservations(candidates.map((document) => document.observationId), 'archived');
        return {
          content: [{ type: 'text' as const, text: `[ARCHIVED] Archived ${result.resolved.length} expired observation(s) in this session's write scope.\n${Math.max(0, managedIds.size - result.resolved.length)} visible writable observations remaining.` }],
        };
      }

      // ── action="stale": full table of stale observations with explanation ──
      if (action === 'stale') {
        const staleDocs = docs.filter(d => getRetentionZone(d) === 'stale');
        if (staleDocs.length === 0) {
          return {
            content: [{ type: 'text' as const, text: '[OK] No stale observations. All active memories are within 50% of their retention period.' }],
          };
        }
        const staleLines: string[] = [
          `## Stale Observations (${staleDocs.length})`,
          '',
          '| ID | Entity | Title | Age | Source | Retention | Why |',
          '|----|--------|-------|-----|--------|-----------|-----|',
        ];
        for (const d of staleDocs) {
          const exp = explainRetention(d);
          const src = d.sourceDetail || '—';
          const vc = d.valueCategory || '—';
          staleLines.push(
            `| ${d.observationId} | ${d.entityName} | ${d.title} | ${exp.ageDays}d | ${src} (${vc}) | ${exp.effectiveRetentionDays}d | ${exp.summary} |`,
          );
        }
        staleLines.push('');
        staleLines.push('> [TIP] Stale = past 50% of effective retention. Review or access to keep; otherwise will become archive candidates.');

        // Actionable IDs block
        const staleIds = staleDocs.map(d => d.observationId);
        staleLines.push('');
        staleLines.push('### Suggested Actions');
        staleLines.push(`Suggested IDs: [${staleIds.join(', ')}]`);
        staleLines.push(`- Archive stale observations: \`memorix_resolve\` with \`ids: [${staleIds.join(', ')}]\` and \`status: "archived"\``);
        staleLines.push('- Or review individually with `memorix_detail` before deciding.');

        return {
          content: [{ type: 'text' as const, text: staleLines.join('\n') }],
        };
      }

      // ── action="report" (default): concise summary ──
      const summary = getRetentionSummary(docs);
      const candidates = getArchiveCandidates(docs);
      const ranked = rankByRelevance(docs);

      // Source breakdown
      const srcCounts = new Map<string, number>();
      for (const d of docs) {
        const key = d.sourceDetail || '(undefined)';
        srcCounts.set(key, (srcCounts.get(key) ?? 0) + 1);
      }

      const lines: string[] = [
        `## Memory Retention Status`,
        ``,
        `| Zone | Count |`,
        `|------|-------|`,
        `| Active | ${summary.active} |`,
        `| Stale | ${summary.stale} |`,
        `| Archive Candidates | ${summary.archiveCandidates} |`,
        `| Immune | ${summary.immune} |`,
        `| **Total** | **${docs.length}** |`,
        ``,
        `### Source Breakdown`,
        `| Source | Count |`,
        `|--------|-------|`,
      ];
      for (const [src, count] of [...srcCounts.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${src} | ${count} |`);
      }
      lines.push('');

      if (candidates.length > 0) {
        lines.push(`### Archive Candidates (${candidates.length})`);
        lines.push(`| ID | Title | Age | Retention | Why |`);
        lines.push(`|----|-------|-----|-----------|-----|`);
        for (const c of candidates.slice(0, 10)) {
          const exp = explainRetention(c);
          lines.push(`| ${c.observationId} | ${c.title} | ${exp.ageDays}d | ${exp.effectiveRetentionDays}d | ${exp.summary} |`);
        }
        if (candidates.length > 10) {
          lines.push(`| … | *(${candidates.length - 10} more)* | | | |`);
        }
        const candidateIds = candidates.map(c => c.observationId);
        lines.push('');
        lines.push(`Candidate IDs: [${candidateIds.slice(0, 20).join(', ')}]${candidateIds.length > 20 ? ` … (${candidateIds.length} total)` : ''}`);
        lines.push(`> [TIP] Use \`memorix_retention\` with \`action: "archive"\` to move all, or \`memorix_resolve\` with specific IDs.`);
        lines.push('');
      }

      if (summary.stale > 0) {
        lines.push(`> [TASK] ${summary.stale} stale observation(s) — use \`memorix_retention\` with \`action: "stale"\` for full details.`);
        lines.push('');
      }

      // Top 5 most relevant
      lines.push(`### Top 5 Most Relevant`);
      lines.push(`| ID | Title | Score | Decay | Access Boost |`);
      lines.push(`|----|-------|-------|-------|-------------|`);
      for (const r of ranked.slice(0, 5)) {
        const doc = docs.find((d) => d.observationId === r.observationId);
        lines.push(
          `| ${r.observationId} | ${doc?.title ?? '?'} | ${r.totalScore.toFixed(3)} | ${r.decayFactor.toFixed(3)} | ${r.accessBoost.toFixed(1)}× |`,
        );
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  /**
   * memorix_formation_metrics — Formation Pipeline shadow mode metrics
   *
   * Shows aggregated metrics from the Memory Formation Pipeline running
   * in shadow mode. Useful for evaluating pipeline quality before
   * switching from shadow to active mode.
   */
  server.registerTool(
    'memorix_formation_metrics',
    {
      title: 'Formation Pipeline Metrics',
      description:
        'Show aggregated metrics from recent Memory Formation Pipeline runs. ' +
        'Reports value scores, resolution actions, fact extraction rates, and processing times.',
      inputSchema: {},
    },
    async () => {
      const summary = getMetricsSummary();
      const beforeAfter = getBeforeAfterMetrics();

      if (summary.total === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: '[STATS] Formation Pipeline: No metrics collected yet.\nStore some observations to start collecting runtime data.',
          }],
        };
      }

      const lines: string[] = [
        '[STATS] **Formation Pipeline Metrics**',
        '',
        `**Total observations processed:** ${summary.total}`,
        `**Average value score:** ${summary.avgValueScore.toFixed(3)}`,
        `**Average processing time:** ${summary.avgDurationMs.toFixed(1)}ms`,
        '',
        '### Quality Indicators',
        `- **Avg system-extracted facts:** ${summary.avgExtractedFacts.toFixed(1)} per observation`,
        `- **Title improved rate:** ${(summary.titleImprovedRate * 100).toFixed(1)}%`,
        `- **Entity resolved rate:** ${(summary.entityResolvedRate * 100).toFixed(1)}%`,
        `- **Type corrected rate:** ${(summary.typeCorectedRate * 100).toFixed(1)}%`,
        '',
        '### Value Categories',
      ];

      for (const [cat, count] of Object.entries(summary.categoryBreakdown)) {
        const pct = ((count / summary.total) * 100).toFixed(1);
        const icon = cat === 'core' ? '[CHANGE]' : cat === 'contextual' ? '[FIX]' : '[GOTCHA]';
        lines.push(`- ${icon} **${cat}:** ${count} (${pct}%)`);
      }

      lines.push('', '### Resolution Actions');
      for (const [action, count] of Object.entries(summary.resolutionBreakdown)) {
        const pct = ((count / summary.total) * 100).toFixed(1);
        lines.push(`- **${action}:** ${count} (${pct}%)`);
      }

      // ── Before/After Comparison Metrics ─────────────────────────
      if (beforeAfter.totalProcessed > 0) {
        lines.push(
          '',
          '### Before/After Comparison (Formation vs Old Compact)',
          `**Total comparisons:** ${beforeAfter.totalProcessed}`,
          `**Agreements:** ${beforeAfter.agreements} (${((beforeAfter.agreements / beforeAfter.totalProcessed) * 100).toFixed(1)}%)`,
          `**Disagreements:** ${beforeAfter.disagreements} (${((beforeAfter.disagreements / beforeAfter.totalProcessed) * 100).toFixed(1)}%)`,
          '',
          '### Disagreement Breakdown',
          `- Formation discarded, Compact added: ${beforeAfter.disagreementBreakdown.formationDiscardedCompactAdded}`,
          `- Formation merged, Compact added: ${beforeAfter.disagreementBreakdown.formationMergedCompactAdded}`,
          `- Formation added, Compact discarded: ${beforeAfter.disagreementBreakdown.formationAddedCompactDiscarded}`,
          '- Formation added, Compact merged: ' + beforeAfter.disagreementBreakdown.formationAddedCompactMerged,
          '- Formation evolved, Compact added: ' + beforeAfter.disagreementBreakdown.formationEvolvedCompactAdded,
          '- Other: ' + beforeAfter.disagreementBreakdown.other,
          '',
          '### Quality Improvements',
          `- Formation discarded low-value: ${beforeAfter.quality.formationDiscardedLowValue}`,
          `- Formation merged duplicates: ${beforeAfter.quality.formationMergedDuplicates}`,
          `- Formation evolved outdated: ${beforeAfter.quality.formationEvolvedOutdated}`,
          `- Compact missed duplicates: ${beforeAfter.quality.compactMissedDuplicates}`,
          `- Compact kept low-value: ${beforeAfter.quality.compactKeptLowValue}`,
          '',
          `### Duration Comparison`,
          `- Formation avg: ${beforeAfter.duration.formationAvgMs.toFixed(1)}ms`,
          `- Compact avg: ${beforeAfter.duration.compactAvgMs.toFixed(1)}ms`,
          `- Diff: ${beforeAfter.duration.diffMs.toFixed(1)}ms`,
        );
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  // ============================================================
  // Export / Import
  // ============================================================

  /**
   * memorix_transfer — Export or import project memories
   */
  server.registerTool(
    'memorix_transfer',
    {
      title: 'Transfer Memories',
      description:
        'Export or import project memories. ' +
        'Action "export": export observations visible to the current agent and project sessions (JSON or Markdown). ' +
        'Action "import": import from a JSON export (re-assigns IDs, skips duplicate topicKeys).',
      inputSchema: {
        action: z.enum(['export', 'import']).describe('Operation: export or import'),
        format: z.enum(['json', 'markdown']).optional().describe('Export format (for export, default: json)'),
        data: z.string().optional().describe('JSON string from a previous export (for import)'),
      },
    },
    async ({ action, format, data: jsonStr }) => {
      if (action === 'export') {
        const { exportAsJson, exportAsMarkdown } = await import('../../memory/export-import.js');
        if (format === 'markdown') {
          const md = await exportAsMarkdown(ctx.projectDir, ctx.project.id, ctx.getObservationReader());
          return { content: [{ type: 'text' as const, text: md }] };
        }
        const data = await exportAsJson(ctx.projectDir, ctx.project.id, ctx.getObservationReader());
        const json = JSON.stringify(data, null, 2);
        return {
          content: [{
            type: 'text' as const,
            text: `Export complete — ${data.stats.observationCount} observations, ${data.stats.sessionCount} sessions\n\n\`\`\`json\n${json}\n\`\`\`\n\n> Use action "import" on another machine to restore.`,
          }],
        };
      }
      // import
      if (!jsonStr) return { content: [{ type: 'text' as const, text: '[ERROR] data is required for import' }], isError: true };
      const { importFromJson } = await import('../../memory/export-import.js');
      let parsed;
      try { parsed = JSON.parse(jsonStr); } catch {
        return { content: [{ type: 'text' as const, text: 'Invalid JSON. Provide the exact output from export.' }], isError: true };
      }
      const result = await importFromJson(ctx.projectDir, parsed);
      return {
        content: [{
          type: 'text' as const,
          text: `Import complete — ${result.observationsImported} observations, ${result.sessionsImported} sessions imported, ${result.skipped} skipped`,
        }],
      };
    },
  );
}
