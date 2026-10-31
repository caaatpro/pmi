/**
 * MCP `git_analyze` (docs/baton/API.md §2): incremental analysis of the
 * commits after the last analyzed one; `full` also checks that the related
 * files of active knowledge still exist.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { analyzeProject } from '../../git/analyze.js';
import type { SessionToolContext } from './session.js';

export function registerGitTools(server: McpServer, ctx: Pick<SessionToolContext, 'dataDir' | 'project'>): void {
  server.registerTool('git_analyze', {
    title: 'Git Analyze',
    description:
      'Turn new commits into project knowledge: only commits since the last analysis are read; dependency, API, structure, ' +
      'deletion, fix and constraint changes become memories, and knowledge about changed files is marked for review. ' +
      'full=true also verifies that files referenced by active knowledge still exist.',
    inputSchema: { full: z.boolean().optional() },
  }, async ({ full }) => {
    try {
      const project = ctx.project();
      const report = await analyzeProject({ dataDir: ctx.dataDir(), projectId: project.id, root: project.rootPath, full });
      const text = `Analyzed ${report.commitsAnalyzed} commit(s) (${report.mode}); ${report.memoriesWritten} memories written, ${report.staleMarked} marked for review, ${report.reviewTasks} review task(s)${report.reconcile ? `; reconcile marked ${report.reconcile.marked}` : ''}.`;
      return { content: [{ type: 'text' as const, text }], structuredContent: { ...report } };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true as const };
    }
  });
}
