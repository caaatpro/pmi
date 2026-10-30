/**
 * Workspace Recovery tools for the local MCP server (docs/PMI/API.md §2):
 * workspace_snapshot and workspace_restore. Restores go into a new git
 * worktree unless the agent explicitly asks for in place, which is refused
 * on a working copy with any uncommitted change.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { connectedProject } from '../../session/service.js';
import { LocalSnapshots } from '../../workspace-snapshot/local.js';
import { downloadSnapshot, reportRestore, uploadSnapshot } from '../../workspace-snapshot/remote.js';
import { RestoreRefused, restoreSnapshot } from '../../workspace-snapshot/restore.js';
import type { SessionToolContext } from './session.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: true };

export function registerWorkspaceTools(server: McpServer, ctx: Pick<SessionToolContext, 'dataDir' | 'project' | 'connectionSessionId'>): void {
  server.registerTool('workspace_snapshot', {
    title: 'Workspace Snapshot',
    description:
      'Save the uncommitted state of this working copy (changed, deleted, renamed and untracked files, staged state, unpushed commits) ' +
      'so it can be restored on another machine. Secrets and files over 50 MiB are excluded and listed. Does not modify the working copy.',
    inputSchema: { sessionId: z.string().optional() },
  }, async ({ sessionId }): Promise<ToolResult> => {
    try {
      const project = ctx.project();
      const snapshots = new LocalSnapshots(ctx.dataDir());
      const { snapshot, reused } = snapshots.take({ root: project.rootPath, projectId: project.id, sessionId: sessionId ?? ctx.connectionSessionId() ?? null });
      const connection = connectedProject(project.rootPath);
      let uploaded = false;
      if (connection) {
        try {
          await uploadSnapshot(connection.api, connection.link.projectId, snapshots, snapshot.id);
          uploaded = true;
        } catch { /* kept locally; the next checkpoint or `pmi workspace upload` retries */ }
      }
      const m = snapshot.manifest;
      return {
        content: [{ type: 'text', text: `Snapshot ${snapshot.id}${reused ? ' (unchanged)' : ''}: ${m.files.length} file(s), ${m.git.bundle?.commits.length ?? 0} unpushed commit(s)${m.excluded.length ? `; excluded: ${m.excluded.map((e) => `${e.path} (${e.reason})`).join(', ')}` : ''}${connection ? (uploaded ? '; uploaded' : '; server unreachable, kept locally') : ''}.` }],
        structuredContent: { snapshotId: snapshot.id, files: m.files.length, excluded: m.excluded, uploaded },
      };
    } catch (error) {
      return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
    }
  });

  server.registerTool('workspace_restore', {
    title: 'Workspace Restore',
    description:
      'Restore a workspace snapshot. Default target: a NEW git worktree next to the repository (nothing existing is touched). ' +
      'in_place=true restores into this working copy only if it is clean and at the snapshot commit; files that differ from the ' +
      'snapshot base are never overwritten (the snapshot version is saved beside them).',
    inputSchema: {
      snapshotId: z.string().min(1),
      in_place: z.boolean().optional(),
      worktreePath: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
  }, async ({ snapshotId, in_place, worktreePath, dryRun }): Promise<ToolResult> => {
    try {
      const project = ctx.project();
      const snapshots = new LocalSnapshots(ctx.dataDir());
      const connection = connectedProject(project.rootPath);
      const snapshot = connection ? await downloadSnapshot(connection.api, connection.link.projectId, snapshots, snapshotId) : snapshots.get(snapshotId);
      if (!snapshot) throw new Error(`snapshot ${snapshotId} is not available`);
      const report = restoreSnapshot(snapshot.manifest, {
        repoRoot: project.rootPath,
        mode: in_place ? 'in-place' : 'worktree',
        ...(worktreePath ? { worktreePath } : {}),
        dryRun,
        expectedManifestSha256: snapshot.manifestSha256,
        getBlob: (sha) => snapshots.blobs.get(sha),
      });
      if (connection && !report.dryRun) await reportRestore(connection.api, report).catch(() => undefined);
      const lines = [
        `${report.dryRun ? 'Dry run for' : 'Restored'} ${snapshotId} into ${report.target}${report.branch ? ` (branch ${report.branch})` : ''}: ${report.written.length} written, ${report.deleted.length} deleted.`,
        ...report.conflicts.map((c) => `CONFLICT ${c.path}: ${c.reason}${c.savedAs ? ` (snapshot version: ${c.savedAs})` : ''}`),
        ...report.excluded.map((e) => `Not included: ${e.path} (${e.reason})`),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...report } };
    } catch (error) {
      const message = error instanceof RestoreRefused ? `Restore refused (${error.code}): ${error.message}` : (error as Error).message;
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });
}
