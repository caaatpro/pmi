/**
 * `pmi workspace snapshot|restore|list|show|upload|gc` — Workspace Recovery
 * (docs/PMI/WORKSPACE_RECOVERY.md). Exit codes: 0 ok, 1 error, 2 refused or
 * conflicts (nothing overwritten), 3 server unreachable (kept locally).
 */
import { defineCommand } from 'citty';

import { emitError, emitResult, getCliProjectContext } from './operator-shared.js';

export default defineCommand({
  meta: { name: 'workspace', description: 'Snapshot uncommitted work and restore it on another machine' },
  args: {
    session: { type: 'string', description: 'Session id to attach the snapshot to / filter by' },
    worktree: { type: 'string', description: 'restore: path of the new worktree (default <repo>-pmi-<id>)' },
    'in-place': { type: 'boolean', description: 'restore: into this working copy (must be clean and at the snapshot HEAD)' },
    'dry-run': { type: 'boolean', description: 'restore: check everything, change nothing' },
    'include-secrets': { type: 'boolean', description: 'snapshot: keep files that look like secrets (logged)' },
    patch: { type: 'boolean', description: 'show: print the working-tree patch' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const asJson = Boolean(args.json);
    const action = (args._ as string[])?.[0] || 'list';
    const target = (args._ as string[])?.[1];
    try {
      const { project, dataDir } = await getCliProjectContext();
      const { LocalSnapshots } = await import('../../workspace-snapshot/local.js');
      const remote = await import('../../workspace-snapshot/remote.js');
      const { connectedProject } = await import('../../session/service.js');
      const snapshots = new LocalSnapshots(dataDir);
      const connection = connectedProject(project.rootPath);

      switch (action) {
        case 'snapshot': {
          const { snapshot, reused } = snapshots.take({
            root: project.rootPath,
            projectId: project.id,
            sessionId: (args.session as string | undefined) ?? null,
            includeSecrets: Boolean(args['include-secrets']),
          });
          let upload: Awaited<ReturnType<typeof remote.uploadSnapshot>> | undefined;
          let offline = false;
          if (connection) {
            try {
              upload = await remote.uploadSnapshot(connection.api, connection.link.projectId, snapshots, snapshot.id);
            } catch (error) {
              if (!(error as { offline?: boolean }).offline) throw error;
              offline = true;
            }
          }
          const m = snapshot.manifest;
          emitResult(
            { snapshot: { id: snapshot.id, manifestSha256: snapshot.manifestSha256, reused, files: m.files.length, bytes: m.totals.bytes, unpushedCommits: m.git.bundle?.commits.length ?? 0, excluded: m.excluded }, upload: upload ?? null, offline },
            [
              `${reused ? 'Unchanged since' : 'Snapshot'} ${snapshot.id}: ${m.files.length} file(s), ${m.totals.bytes} bytes, ${m.git.bundle?.commits.length ?? 0} unpushed commit(s) on ${m.git.branch ?? 'detached HEAD'}`,
              ...m.excluded.map((item) => `  excluded ${item.path} (${item.reason})`),
              upload ? `Uploaded ${upload.uploadedBlobs} new blob(s), ${upload.uploadedBytes} bytes.` : offline ? 'Server unreachable: kept locally; run `pmi workspace upload <id>` later.' : 'Local mode: stored on this machine only.',
            ].join('\n'),
            asJson,
          );
          if (offline) process.exitCode = 3;
          return;
        }

        case 'upload': {
          if (!target) throw new Error('usage: pmi workspace upload <snapshot-id>');
          if (!connection) throw new Error('this working copy is not linked to a PMI server');
          const upload = await remote.uploadSnapshot(connection.api, connection.link.projectId, snapshots, target);
          emitResult(upload, `Uploaded ${upload.uploadedBlobs} new blob(s) for ${target}.`, asJson);
          return;
        }

        case 'restore': {
          if (!target) throw new Error('usage: pmi workspace restore <snapshot-id> [--worktree <path> | --in-place] [--dry-run]');
          const { restoreSnapshot, RestoreRefused } = await import('../../workspace-snapshot/restore.js');
          // Downloading also fills in blobs a locally known manifest is missing; every blob is verified.
          const snapshot = connection ? await remote.downloadSnapshot(connection.api, connection.link.projectId, snapshots, target) : snapshots.get(target);
          if (!snapshot) throw new Error(`snapshot ${target} is not on this machine and the working copy is not linked to a server`);
          try {
            const report = restoreSnapshot(snapshot.manifest, {
              repoRoot: project.rootPath,
              mode: args['in-place'] ? 'in-place' : 'worktree',
              ...(args.worktree ? { worktreePath: String(args.worktree) } : {}),
              dryRun: Boolean(args['dry-run']),
              expectedManifestSha256: snapshot.manifestSha256,
              getBlob: (sha) => snapshots.blobs.get(sha),
            });
            if (connection && !report.dryRun) await remote.reportRestore(connection.api, report).catch(() => undefined);
            emitResult(report, renderRestore(report), asJson);
            if (report.conflicts.length || report.mismatches.length) process.exitCode = 2;
          } catch (error) {
            if (error instanceof RestoreRefused) {
              emitError(`restore refused (${error.code}): ${error.message}`, asJson);
              process.exitCode = 2;
              return;
            }
            throw error;
          }
          return;
        }

        case 'list': {
          const sessionId = args.session as string | undefined;
          if (connection) {
            try {
              const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
              const { snapshots: rows } = await connection.api.get<{ snapshots: Array<{ id: string; sessionId: string | null; branch: string | null; fileCount: number; totalBytes: number; pinned: boolean; createdAt: string }> }>(
                `/v1/projects/${connection.link.projectId}/snapshots${query}`,
              );
              emitResult({ source: 'server', snapshots: rows }, rows.map((row) => `${row.id}  ${row.createdAt}  ${row.branch ?? '-'}  ${row.fileCount} file(s)${row.pinned ? '  pinned' : ''}  ${row.sessionId ?? ''}`).join('\n') || 'No snapshots.', asJson);
              return;
            } catch (error) {
              if (!(error as { offline?: boolean }).offline) throw error;
            }
          }
          const rows = snapshots.list({ projectId: project.id, sessionId });
          emitResult({ source: 'local', snapshots: rows.map(({ manifest: m, ...rest }) => ({ ...rest, files: m.files.length })) },
            rows.map((row) => `${row.id}  ${row.createdAt}  ${row.manifest.git.branch ?? '-'}  ${row.manifest.files.length} file(s)${row.registeredAt ? '' : '  not uploaded'}`).join('\n') || 'No snapshots.', asJson);
          return;
        }

        case 'show': {
          if (!target) throw new Error('usage: pmi workspace show <snapshot-id> [--patch]');
          const snapshot = snapshots.get(target) ?? (connection ? await remote.downloadSnapshot(connection.api, connection.link.projectId, snapshots, target) : undefined);
          if (!snapshot) throw new Error(`snapshot ${target} not found`);
          const m = snapshot.manifest;
          if (args.patch) {
            process.stdout.write(m.patches.worktree ? snapshots.blobs.get(m.patches.worktree).toString('utf8') : '');
            return;
          }
          emitResult(m, [
            `Snapshot ${m.id} of ${m.projectId} at ${m.git.head.slice(0, 12)} (${m.git.branch ?? 'detached'}) — ${m.createdAt}`,
            ...m.files.map((file) => `  ${file.status}${file.staged ? '+' : ' '} ${file.oldPath ? `${file.oldPath} -> ` : ''}${file.path}`),
            ...(m.git.bundle ? [`  unpushed commits: ${m.git.bundle.commits.map((sha) => sha.slice(0, 12)).join(', ')}`] : []),
            ...m.excluded.map((item) => `  excluded ${item.path} (${item.reason})`),
          ].join('\n'), asJson);
          return;
        }

        case 'gc': {
          const report = snapshots.gc();
          emitResult(report, `Removed ${report.snapshots} local snapshot(s) and ${report.blobs} blob(s).`, asJson);
          return;
        }

        default:
          emitError(`unknown action "${action}" (expected snapshot|restore|list|show|upload|gc)`, asJson);
          process.exitCode = 2;
      }
    } catch (error) {
      emitError((error as Error).message, asJson);
      process.exitCode = (error as { offline?: boolean }).offline ? 3 : 1;
    }
  },
});

export function renderRestore(report: import('../../workspace-snapshot/restore.js').RestoreReport): string {
  return [
    `${report.dryRun ? 'Dry run: would restore' : 'Restored'} snapshot ${report.snapshotId} into ${report.target}${report.branch ? ` (branch ${report.branch})` : ''}`,
    `  written ${report.written.length}, deleted ${report.deleted.length}, unpushed commits imported ${report.importedCommits}`,
    ...report.conflicts.map((conflict) => `  CONFLICT ${conflict.path}: ${conflict.reason}${conflict.savedAs ? ` — snapshot version saved as ${conflict.savedAs}` : ''}`),
    ...report.mismatches.map((file) => `  MISMATCH ${file}: content differs from the snapshot after writing`),
    ...report.excluded.map((item) => `  not in snapshot: ${item.path} (${item.reason})`),
    report.dryRun ? '' : report.verified ? '  verified: every restored file matches its SHA-256' : '  NOT fully restored — see above; nothing of yours was overwritten',
  ].filter(Boolean).join('\n');
}
