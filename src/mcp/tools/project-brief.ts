/**
 * Project brief tools inherited from Memorix: memorix_project_context (Memory Autopilot),
 * memorix_codegraph_status, memorix_context_pack, memorix_knowledge.
 *
 * Split out of src/server.ts without behaviour changes; connection state comes
 * from `ServerToolContext`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getObservationStore } from '../../store/obs-store.js';
import { filterReadableObservations } from '../../memory/visibility.js';
import type { ServerToolContext } from './server-context.js';
import { READ_ONLY_TASK_PATTERN } from './helpers.js';

export function registerProjectBriefTools(server: McpServer, ctx: ServerToolContext): void {
  server.registerTool(
    'memorix_project_context',
    {
      title: 'Memory Autopilot Project Context',
      description:
        'Build a compact Memory Autopilot brief for the current coding task. ' +
        'Schedules Code Memory refresh when needed, includes Start here files, ' +
        'reliable code-bound memories, stale/suspect cautions, and verification hints. Use this at the start of a new coding turn or after switching tasks.',
      inputSchema: {
        task: z.string().optional().describe('Current coding task or question'),
        taskId: z.string().max(120).optional().describe('Optional task continuity ledger id to include in the brief'),
        refresh: z.enum(['auto', 'always', 'never']).optional().default('auto').describe(
          'Code Memory refresh policy. auto refreshes only when missing or stale.',
        ),
        format: z.enum(['prompt', 'summary', 'json', 'receipt']).optional().default('prompt').describe(
          'Output format. "prompt" is agent-ready; "summary" is human-readable; "receipt" is bounded JSON; "json" is detailed diagnostics.',
        ),
        agent: z.enum([
          'windsurf', 'cursor', 'claude-code', 'codex', 'copilot', 'antigravity', 'gemini-cli',
          'openclaw', 'hermes', 'omp', 'kiro', 'opencode', 'trae',
        ]).optional().describe('Optional target agent for compatible workflow selection.'),
        limit: z.number().optional().describe('Reserved for future source limits; current prompt stays compact by default.'),
      },
    },
    async ({ task, taskId, refresh, format, agent }) => {
      const unresolved = ctx.requireResolvedProject('build project context for the current project');
      if (unresolved) return unresolved;

      const [
        {
          buildAutoProjectBrief,
          buildAutoProjectContext,
          formatAutoProjectContextPrompt,
          formatAutoProjectContextSummary,
        },
        { getObservationStore },
        { MaintenanceJobStore },
        { enqueueCodegraphRefresh },
        { buildBoundedContextReceipt },
      ] = await Promise.all([
        import('../../codegraph/auto-context.js'),
        import('../../store/obs-store.js'),
        import('../../runtime/maintenance-jobs.js'),
        import('../../runtime/lifecycle.js'),
        import('../../knowledge/context-receipt.js'),
      ]);
      const observations = filterReadableObservations(
        await getObservationStore().loadByProject(ctx.project.id, { status: 'active' }),
        ctx.getObservationReader(),
      );
      const context = await buildAutoProjectContext({
        project: ctx.project,
        dataDir: ctx.projectDir,
        observations,
        task,
        taskId,
        agent,
        refresh: refresh ?? 'auto',
        reader: ctx.getObservationReader(),
        enqueueRefresh: () => {
          enqueueCodegraphRefresh({
            dataDir: ctx.projectDir,
            projectId: ctx.project.id,
            source: 'project-context',
            maxFiles: 5_000,
            queue: new MaintenanceJobStore(ctx.projectDir),
          });
        },
      });
      const text = format === 'json'
        ? JSON.stringify({ ...context, brief: buildAutoProjectBrief(context) }, null, 2)
        : format === 'receipt'
          ? JSON.stringify(buildBoundedContextReceipt({
            workset: context.workset,
            providerQuality: context.providerQuality,
          }), null, 2)
        : format === 'summary'
          ? formatAutoProjectContextSummary(context)
          : formatAutoProjectContextPrompt(context);

      ctx.autopilotRetrievalBoundary = {
        projectId: ctx.project.id,
        issuedAt: Date.now(),
        coveredObservationIds: new Set([
          ...(context.workset.continuation?.memories.map(memory => memory.id) ?? []),
          ...context.workset.reliableMemory.map(memory => memory.id),
          ...context.workset.cautionMemory.map(memory => memory.id),
        ]),
        readOnly: READ_ONLY_TASK_PATTERN.test(task ?? ''),
      };

      return {
        content: [{ type: 'text' as const, text }],
      };
    },
  );

  server.registerTool(
    'memorix_codegraph_status',
    {
      title: 'CodeGraph Memory Status',
      description: 'Show CodeGraph Memory provider and index status for the current project.',
      inputSchema: {},
    },
    async () => {
      const unresolved = ctx.requireResolvedProject('show CodeGraph Memory status for the current project');
      if (unresolved) return unresolved;

      const [{ CodeGraphStore }, { getResolvedConfig }, { inspectExternalCodeGraph }] = await Promise.all([
        import('../../codegraph/store.js'),
        import('../../config/resolved-config.js'),
        import('../../codegraph/external-provider.js'),
      ]);
      const store = new CodeGraphStore();
      await store.init(ctx.projectDir);
      const status = store.status(ctx.project.id);
      const codegraphConfig = getResolvedConfig({ projectRoot: ctx.project.rootPath }).codegraph;
      const providerQuality = await inspectExternalCodeGraph({
        projectRoot: ctx.project.rootPath,
        mode: codegraphConfig.externalContext,
        command: codegraphConfig.externalCommand,
        timeoutMs: codegraphConfig.externalTimeoutMs,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...status, providerQuality: providerQuality.quality }, null, 2) }],
      };
    },
  );

  server.registerTool(
    'memorix_context_pack',
    {
      title: 'Context Pack',
      description:
        'Build a prompt-ready working context pack for a coding task. ' +
        'Combines relevant memories, CodeGraph Memory facts, freshness warnings, suggested reads, and verification hints. ' +
        'After a complete memorix_project_context brief, provide purpose only when deliberately expanding beyond it.',
      inputSchema: {
        task: z.string().describe('Current coding task or question'),
        limit: z.preprocess(
          value => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
          z.number().int().positive().max(100),
        ).optional().describe('Max active memories to inspect before code-ref filtering (default: 20)'),
        purpose: z.string().optional().describe(
          'Why this must expand beyond the latest Autopilot brief. Name the missing fact or the user\'s explicit request.',
        ),
      },
    },
    async ({ task, limit, purpose }) => {
      const unresolved = ctx.requireResolvedProject('build a context pack for the current project');
      if (unresolved) return unresolved;
      const boundary = ctx.requireExplicitAutopilotExpansion('memorix_context_pack', purpose);
      if (boundary) return boundary;

      const [
        { CodeGraphStore },
        { assembleContextPackForTask, attachTaskWorkset, buildContextPackPrompt },
        { getResolvedConfig },
        { getExternalCodeGraphContext },
        { getObservationStore },
        { collectCurrentProjectFacts, formatGitFact },
        { resolveTaskLens },
      ] = await Promise.all([
        import('../../codegraph/store.js'),
        import('../../codegraph/context-pack.js'),
        import('../../config/resolved-config.js'),
        import('../../codegraph/external-provider.js'),
        import('../../store/obs-store.js'),
        import('../../codegraph/current-facts.js'),
        import('../../codegraph/task-lens.js'),
      ]);
      const store = new CodeGraphStore();
      await store.init(ctx.projectDir);
      const codegraphConfig = getResolvedConfig({ projectRoot: ctx.project.rootPath }).codegraph;
      const exclude = codegraphConfig.excludePatterns;
      const observations = filterReadableObservations(
        await getObservationStore().loadByProject(ctx.project.id, { status: 'active' }),
        ctx.getObservationReader(),
      );
      observations.reverse();
      const basePack = assembleContextPackForTask({
        store,
        projectId: ctx.project.id,
        task,
        observations,
        limit: typeof limit === 'number' ? limit : 20,
        exclude,
      });
      const status = store.status(ctx.project.id);
      const currentFacts = collectCurrentProjectFacts({ project: ctx.project, now: new Date() });
      const snapshot = status.latestSnapshot;
      const external = await getExternalCodeGraphContext({
        projectRoot: ctx.project.rootPath,
        task,
        exclude,
        mode: codegraphConfig.externalContext,
        command: codegraphConfig.externalCommand,
        timeoutMs: codegraphConfig.externalTimeoutMs,
      });
      const worksetFacts: string[] = [];
      if (currentFacts.packageVersion) worksetFacts.push('Package version: ' + currentFacts.packageVersion);
      if (currentFacts.latestChangelog) {
        worksetFacts.push('Latest changelog: ' + currentFacts.latestChangelog.version
          + (currentFacts.latestChangelog.date ? ' (' + currentFacts.latestChangelog.date + ')' : ''));
      }
      worksetFacts.push(formatGitFact(currentFacts.git));
      const codeState = snapshot
        ? '- Code state: ' + (snapshot.baseRevision ? snapshot.baseRevision.slice(0, 12) : 'Git unavailable')
          + ', ' + snapshot.worktreeState + ' worktree'
          + ', epoch ' + snapshot.sourceEpoch
        : '- Code state: no completed snapshot yet';
      const pack = await attachTaskWorkset({
        pack: basePack,
        projectId: ctx.project.id,
        dataDir: ctx.projectDir,
        lens: resolveTaskLens(task).id,
        worktreeDirty: currentFacts.git.dirty,
        currentFacts: worksetFacts,
        codeState,
        ...(snapshot
          ? {
            snapshot: {
              id: snapshot.id,
              sourceEpoch: snapshot.sourceEpoch,
              worktreeState: snapshot.worktreeState,
              incomplete: snapshot.completeness.skippedOversizedFiles > 0
                || (snapshot.completeness.unreadableFiles ?? 0) > 0
                || snapshot.completeness.removalScanDeferred,
            },
          }
          : {}),
        ...(external.outline ? { semanticCode: external.outline } : {}),
        providerQuality: external.quality,
        ...(external.caution
          ? { runtimeCautions: [{ kind: 'external-codegraph-fallback' as const, message: external.caution }] }
          : {}),
        reader: ctx.getObservationReader(),
      });
      const text = buildContextPackPrompt(pack);

      return {
        content: [{ type: 'text' as const, text }],
      };
    },
  );

  server.registerTool(
    'memorix_knowledge',
    {
      title: 'Knowledge Workspace',
      description:
        'Manage the reviewable project Knowledge Workspace. Use it only for deliberate knowledge operations: initialize a local or versioned workspace, review source-backed claims, compile proposals, lint, apply a reviewed proposal, or manage canonical workflows. It is intentionally absent from the default micro/lite profiles.',
      inputSchema: {
        action: z.enum([
          'workspace_init',
          'status',
          'claim_list',
          'claim_review',
          'compile',
          'lint',
          'proposal_apply',
          'workflow_import',
          'workflow_list',
          'workflow_select',
          'workflow_preview',
          'workflow_apply',
          'workflow_run',
        ]).describe('Knowledge operation to perform'),
        mode: z.enum(['local', 'versioned']).optional().default('local').describe('Workspace mode; versioned writes require an explicit project path during workspace_init'),
        path: z.string().optional().describe('Explicit versioned workspace path, used only by workspace_init'),
        proposalId: z.string().optional().describe('Pending proposal id for proposal_apply'),
        allowManualOverwrite: z.boolean().optional().default(false).describe('Explicitly allow proposal_apply to replace a manually edited page'),
        claimId: z.string().optional().describe('Source-backed claim id for claim_review'),
        claimReviewState: z.enum(['approved', 'rejected']).optional().describe('Deliberate review verdict for claim_review'),
        reviewDetail: z.string().max(2_000).optional().describe('Evidence check performed before approving or rejecting a claim'),
        workflowId: z.string().optional().describe('Canonical workflow id for workflow preview, apply, or run'),
        agent: z.string().optional().describe('Target agent for a workflow adapter'),
        task: z.string().optional().describe('Task text for workflow selection or a workflow run'),
        outcome: z.enum(['passed', 'failed', 'cancelled', 'in-progress']).optional().describe('Workflow run outcome'),
        verificationVerdict: z.enum(['passed', 'failed', 'not-run']).optional().describe('Workflow run verification verdict'),
        failureReason: z.string().optional().describe('Sanitized workflow failure reason'),
        startingSnapshotId: z.string().optional().describe('Code snapshot id present when a workflow run began'),
        evidenceIds: z.array(z.string()).max(24).optional().describe('Selected evidence ids for a workflow run'),
      },
    },
    async ({
      action,
      mode,
      path: workspacePath,
      proposalId,
      allowManualOverwrite,
      claimId,
      claimReviewState,
      reviewDetail,
      workflowId,
      agent,
      task,
      outcome,
      verificationVerdict,
      failureReason,
      startingSnapshotId,
      evidenceIds,
    }) => {
      const unresolved = ctx.requireResolvedProject('manage the Knowledge Workspace for the current project');
      if (unresolved) return unresolved;

      const text = (value: unknown, isError = false) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
        ...(isError ? { isError: true as const } : {}),
      });
      const modeValue = mode ?? 'local';
      const requireText = (value: string | undefined, field: string): string | undefined => {
        const normalized = value?.trim();
        return normalized ? normalized : undefined;
      };

      const [
        { ClaimStore },
        { reviewClaim },
        { CodeGraphStore },
        { initializeKnowledgeWorkspace, loadKnowledgeWorkspace },
        { KnowledgeWorkspaceStore },
        { applyKnowledgeProposal, compileKnowledgeWorkspace, lintKnowledgeWorkspace },
        { WorkflowStore },
        {
          applyWorkflowAdapter,
          importWindsurfWorkflows,
          previewWorkflowAdapter,
          recordWorkflowRun,
          selectWorkspaceWorkflows,
          syncCanonicalWorkflows,
        },
      ] = await Promise.all([
        import('../../knowledge/claim-store.js'),
        import('../../knowledge/claims.js'),
        import('../../codegraph/store.js'),
        import('../../knowledge/workspace.js'),
        import('../../knowledge/workspace-store.js'),
        import('../../knowledge/wiki.js'),
        import('../../knowledge/workflow-store.js'),
        import('../../knowledge/workflows.js'),
      ]);

      if (action === 'workspace_init') {
        if (modeValue === 'versioned' && !requireText(workspacePath, 'path')) {
          return text({ error: 'path is required to initialize a versioned Knowledge Workspace.' }, true);
        }
        const workspace = await initializeKnowledgeWorkspace({
          projectId: ctx.project.id,
          dataDir: ctx.projectDir,
          mode: modeValue,
          ...(modeValue === 'versioned'
            ? { projectRoot: ctx.project.rootPath, rootPath: requireText(workspacePath, 'path')! }
            : {}),
        });
        return text({
          workspace: {
            id: workspace.id,
            mode: workspace.mode,
            rootPath: workspace.rootPath,
            status: workspace.status,
          },
          next: 'Compile creates reviewable proposals; it does not silently publish pages.',
        });
      }

      const workspace = await loadKnowledgeWorkspace({ projectId: ctx.project.id, dataDir: ctx.projectDir, mode: modeValue });
      if (!workspace) {
        return text({ error: 'Knowledge Workspace is not initialized. Run workspace_init first.' }, true);
      }
      const claims = new ClaimStore();
      const workspaceStore = new KnowledgeWorkspaceStore();
      await Promise.all([claims.init(ctx.projectDir), workspaceStore.init(ctx.projectDir)]);

      if (action === 'status') {
        const pages = workspaceStore.listPages(workspace.id);
        const pending = workspaceStore.listProposals(workspace.id, 'pending');
        return text({
          workspace: {
            id: workspace.id,
            mode: workspace.mode,
            rootPath: workspace.rootPath,
            status: workspace.status,
            publishedPages: pages.filter(page => page.status === 'active').length,
            pendingProposals: pending.map(proposal => ({
              id: proposal.id,
              targetPath: proposal.targetPath,
              reason: proposal.reason,
              createdAt: proposal.createdAt,
            })),
            reviewableClaims: claims.listClaims(ctx.project.id, { limit: 100 })
              .filter(claim => claim.reviewState === 'needs-review')
              .map(claim => ({ id: claim.id, subject: claim.subject, predicate: claim.predicate, objectValue: claim.objectValue })),
          },
        });
      }

      if (action === 'claim_list') {
        return text({
          claims: claims.listClaims(ctx.project.id, { limit: 100 }).map(claim => ({
            id: claim.id,
            subject: claim.subject,
            predicate: claim.predicate,
            objectValue: claim.objectValue,
            status: claim.status,
            reviewState: claim.reviewState,
            origin: claim.origin,
            confidence: claim.confidence,
            evidenceCount: claims.listEvidence(claim.id).length,
          })),
          next: 'Approve only after checking the linked evidence. Rejected claims stay out of retrieval and publication.',
        });
      }

      if (action === 'claim_review') {
        const requestedClaimId = requireText(claimId, 'claimId');
        const detail = requireText(reviewDetail, 'reviewDetail');
        if (!requestedClaimId || !claimReviewState || !detail) {
          return text({ error: 'claimId, claimReviewState, and reviewDetail are required for claim_review.' }, true);
        }
        const existing = claims.getClaim(requestedClaimId);
        if (!existing || existing.projectId !== ctx.project.id) {
          return text({ error: 'Claim was not found for the current project.' }, true);
        }
        const claim = reviewClaim(claims, {
          claimId: requestedClaimId,
          reviewState: claimReviewState,
          detail,
        });
        return text({
          claim: {
            id: claim.id,
            status: claim.status,
            reviewState: claim.reviewState,
            updatedAt: claim.updatedAt,
          },
          next: claim.reviewState === 'approved'
            ? 'This approved source-backed claim can now be considered by knowledge compilation.'
            : 'This rejected claim is excluded from retrieval and knowledge compilation.',
        });
      }

      if (action === 'compile') {
        const result = await compileKnowledgeWorkspace({ workspace, claims });
        return text({
          proposals: result.proposals.map(proposal => ({
            id: proposal.id,
            targetPath: proposal.targetPath,
            proposalPath: proposal.proposalPath,
            reason: proposal.reason,
          })),
          unchangedPublishedPages: result.published.map(page => page.relativePath),
          next: result.proposals.length ? 'Review a proposal, then use proposal_apply deliberately.' : undefined,
        });
      }

      if (action === 'lint') {
        const codeStore = new CodeGraphStore();
        await codeStore.init(ctx.projectDir);
        const result = await lintKnowledgeWorkspace({ workspace, claims, codeStore });
        return text(result);
      }

      if (action === 'proposal_apply') {
        const proposal = requireText(proposalId, 'proposalId');
        if (!proposal) return text({ error: 'proposalId is required for proposal_apply.' }, true);
        const result = await applyKnowledgeProposal({
          workspace,
          proposalId: proposal,
          allowManualOverwrite: !!allowManualOverwrite,
        });
        return text({
          proposal: { id: result.proposal.id, status: result.proposal.status },
          targetPath: result.targetPath,
        });
      }

      const workflowStore = new WorkflowStore();
      await workflowStore.init(ctx.projectDir);
      const projectRoot = workspace.projectRoot ?? ctx.project.rootPath;

      if (action === 'workflow_import') {
        const result = await importWindsurfWorkflows({ workspace, projectRoot });
        return text({
          imported: result.imported.map(workflow => ({
            id: workflow.id,
            title: workflow.title,
            sourcePath: workflow.sourcePath,
            importedFrom: workflow.importedFrom,
            verificationGates: workflow.verificationGates,
          })),
          skipped: result.skipped,
        });
      }

      const synced = await syncCanonicalWorkflows(workspace);
      if (action === 'workflow_list') {
        return text({
          workflows: workflowStore.listWorkflows(workspace.id).map(workflow => ({
            id: workflow.id,
            title: workflow.title,
            status: workflow.status,
            taskLenses: workflow.taskLenses,
            sourcePath: workflow.sourcePath,
            importedFrom: workflow.importedFrom,
            verificationGates: workflow.verificationGates,
          })),
          parseErrors: synced.errors,
        });
      }

      if (action === 'workflow_select') {
        const selectedTask = requireText(task, 'task');
        if (!selectedTask) return text({ error: 'task is required for workflow_select.' }, true);
        const result = await selectWorkspaceWorkflows({ workspace, task: selectedTask });
        return text({
          selections: result.selections.map(selection => ({
            id: selection.workflow.id,
            title: selection.workflow.title,
            reasons: selection.reasons,
            firstPhase: selection.firstPhase.title,
            cautions: selection.cautions,
          })),
          parseErrors: result.errors,
        });
      }

      const requestedWorkflowId = requireText(workflowId, 'workflowId');
      if (!requestedWorkflowId) return text({ error: 'workflowId is required for this workflow action.' }, true);
      const workflow = workflowStore.getWorkflow(requestedWorkflowId);
      if (!workflow || workflow.workspaceId !== workspace.id) {
        return text({ error: 'Workflow was not found for this Knowledge Workspace.' }, true);
      }

      if (action === 'workflow_preview' || action === 'workflow_apply') {
        const targetAgent = requireText(agent, 'agent');
        if (!targetAgent) return text({ error: 'agent is required for a workflow adapter action.' }, true);
        const result = action === 'workflow_preview'
          ? await previewWorkflowAdapter({ workflow, projectRoot, agent: targetAgent as any })
          : await applyWorkflowAdapter({ workflow, projectRoot, agent: targetAgent as any });
        return text({
          workflowId: workflow.id,
          agent: targetAgent,
          status: result.status,
          targetPath: result.targetPath,
          reason: result.reason,
          ...(action === 'workflow_preview' && result.content ? { content: result.content } : {}),
        });
      }

      if (action === 'workflow_run') {
        const runTask = requireText(task, 'task');
        if (!runTask) return text({ error: 'task is required for workflow_run.' }, true);
        if (!outcome) return text({ error: 'outcome is required for workflow_run.' }, true);
        const result = await recordWorkflowRun({
          workspace,
          run: {
            workflowId: workflow.id,
            projectId: ctx.project.id,
            task: runTask,
            outcome,
            ...(verificationVerdict ? { verificationVerdict } : {}),
            ...(requireText(failureReason, 'failureReason') ? { failureReason: requireText(failureReason, 'failureReason') } : {}),
            ...(requireText(startingSnapshotId, 'startingSnapshotId') ? { startingSnapshotId: requireText(startingSnapshotId, 'startingSnapshotId') } : {}),
            selectedEvidence: [...new Set((evidenceIds ?? []).map(item => item.trim()).filter(Boolean))],
          },
        });
        return text({
          id: result.id,
          workflowId: result.workflowId,
          outcome: result.outcome,
          verificationVerdict: result.verificationVerdict,
        });
      }

      return text({ error: 'Unsupported knowledge action.' }, true);
    },
  );
}
