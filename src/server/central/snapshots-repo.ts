/**
 * Server side of workspace recovery (WORKSPACE_RECOVERY.md §4, §7):
 * content-addressed blob storage, snapshot registration, retention and GC.
 *
 * Blobs under 256 KiB live in Postgres; larger ones in `blobDir` (a volume).
 * Storage is shared and deduplicated, but a project sees a blob only after
 * one of its members uploaded it (`work.project_blobs`), so the server never
 * answers "does any project have this hash?".
 */
import fs from 'node:fs';
import path from 'node:path';

import { sha256Hex } from '../../workspace-snapshot/blob-store.js';
import { manifestBlobs, manifestSha256, type SnapshotManifest } from '../../workspace-snapshot/snapshot.js';
import type { Queryable } from './db.js';
import { HttpError, audit, type AuthUser, type ProjectRecord } from './identity.js';
import { getSession } from './sessions-repo.js';

export const INLINE_BLOB_LIMIT = 256 * 1024;

export class ServerBlobStorage {
  constructor(readonly blobDir: string) {}

  private filePath(sha: string): string {
    return path.join(this.blobDir, sha.slice(0, 2), sha.slice(2, 4), sha);
  }

  /** Store a verified body (owner connection). Re-uploading an existing blob is a no-op. */
  async put(db: Queryable, sha: string, data: Buffer): Promise<void> {
    if (sha256Hex(data) !== sha) throw new HttpError(422, 'blob_hash_mismatch', 'the body does not hash to the given SHA-256');
    const [existing] = await db.query<{ sha256: string }>('SELECT sha256 FROM work.blobs WHERE sha256 = $1', [sha]);
    if (existing) return;
    if (data.length >= INLINE_BLOB_LIMIT) {
      const target = this.filePath(sha);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, target);
      await db.query("INSERT INTO work.blobs (sha256, size, storage) VALUES ($1, $2, 'fs') ON CONFLICT DO NOTHING", [sha, data.length]);
    } else {
      await db.query("INSERT INTO work.blobs (sha256, size, storage, data) VALUES ($1, $2, 'inline', $3) ON CONFLICT DO NOTHING", [sha, data.length, data]);
    }
  }

  /** Read and verify a body (owner connection); a damaged blob is an error, never served. */
  async get(db: Queryable, sha: string): Promise<Buffer> {
    const [row] = await db.query<{ storage: string; data: Buffer | null }>('SELECT storage, data FROM work.blobs WHERE sha256 = $1', [sha]);
    if (!row) throw new HttpError(404, 'blob_not_found', 'blob not found');
    const data = row.storage === 'fs' ? fs.readFileSync(this.filePath(sha)) : row.data!;
    if (sha256Hex(data) !== sha) throw new HttpError(500, 'blob_corrupted', `stored blob ${sha.slice(0, 12)} failed its integrity check`);
    return data;
  }

  async remove(db: Queryable, sha: string): Promise<void> {
    const [row] = await db.query<{ storage: string }>('DELETE FROM work.blobs WHERE sha256 = $1 RETURNING storage', [sha]);
    if (row?.storage === 'fs') fs.rmSync(this.filePath(sha), { force: true });
  }
}

export async function missingBlobs(tx: Queryable, projectId: string, shas: string[]): Promise<string[]> {
  if (shas.length === 0) return [];
  const present = new Set((await tx.query<{ sha256: string }>(
    'SELECT sha256 FROM work.project_blobs WHERE project_id = $1 AND sha256 = ANY ($2::text[])',
    [projectId, shas],
  )).map((row) => row.sha256));
  return [...new Set(shas)].filter((sha) => !present.has(sha));
}

export async function addProjectBlob(tx: Queryable, projectId: string, user: AuthUser, sha: string): Promise<void> {
  await tx.query(
    'INSERT INTO work.project_blobs (project_id, sha256, uploaded_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [projectId, sha, user.id],
  );
}

export interface SnapshotRow {
  id: string;
  projectId: string;
  sessionId: string | null;
  parentSnapshotId: string | null;
  baseCommit: string;
  branch: string | null;
  manifestSha256: string;
  totalBytes: number;
  fileCount: number;
  pinned: boolean;
  createdByUser: string;
  deviceId: string;
  createdAt: string;
}

const SNAPSHOT_COLUMNS = `id, project_id AS "projectId", session_id AS "sessionId", parent_snapshot_id AS "parentSnapshotId",
  base_commit AS "baseCommit", branch, manifest_sha256 AS "manifestSha256", total_bytes::float8 AS "totalBytes",
  file_count AS "fileCount", pinned, created_by_user AS "createdByUser", device_id AS "deviceId", created_at AS "createdAt"`;

export async function registerSnapshot(
  tx: Queryable,
  project: ProjectRecord,
  user: AuthUser,
  input: { deviceId: string; manifest: SnapshotManifest; manifestSha256: string; pinned: boolean },
): Promise<{ snapshot: SnapshotRow; created: boolean }> {
  const { manifest } = input;
  if (manifestSha256(manifest) !== input.manifestSha256) throw new HttpError(422, 'manifest_hash_mismatch', 'the manifest does not hash to manifest_sha256');
  if (!project.legacyProjectIds.includes(manifest.projectId)) {
    throw new HttpError(409, 'identity_mismatch', `project "${project.slug}" does not replicate ${manifest.projectId}`);
  }
  const [owner] = await tx.query<{ project_id: string | null }>('SELECT work.snapshot_project($1) AS project_id', [manifest.id]);
  if (owner?.project_id) {
    const [existing] = await tx.query<SnapshotRow>(`SELECT ${SNAPSHOT_COLUMNS} FROM work.snapshots WHERE id = $1`, [manifest.id]);
    if (owner.project_id !== project.id || !existing || existing.manifestSha256 !== input.manifestSha256) {
      throw new HttpError(409, 'snapshot_id_taken', 'a different snapshot with this id exists');
    }
    if (input.pinned && !existing.pinned) await tx.query('UPDATE work.snapshots SET pinned = true WHERE id = $1', [manifest.id]);
    return { snapshot: { ...existing, pinned: existing.pinned || input.pinned }, created: false };
  }
  const blobs = manifestBlobs(manifest);
  const missing = await missingBlobs(tx, project.id, blobs);
  if (missing.length) throw new HttpError(412, 'blobs_missing', `${missing.length} blob(s) must be uploaded first`, { missing });
  let sessionId: string | null = null;
  if (manifest.sessionId) {
    const session = await getSession(tx, manifest.sessionId);
    sessionId = session?.projectId === project.id ? session.id : null;
  }
  await tx.query(
    `INSERT INTO work.snapshots (id, project_id, session_id, parent_snapshot_id, base_commit, branch, manifest, manifest_sha256,
                                 total_bytes, file_count, pinned, created_by_user, device_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
    [manifest.id, project.id, sessionId, manifest.parent, manifest.git.head, manifest.git.branch, JSON.stringify(manifest),
      input.manifestSha256, manifest.totals.bytes, manifest.files.length, input.pinned, user.id, input.deviceId, manifest.createdAt],
  );
  for (const sha of blobs) {
    await tx.query('INSERT INTO work.snapshot_blobs (snapshot_id, project_id, sha256) VALUES ($1, $2, $3)', [manifest.id, project.id, sha]);
  }
  await audit(tx, {
    action: 'snapshot.create', actorUserId: user.id, orgId: project.orgId, projectId: project.id, deviceId: input.deviceId,
    targetType: 'snapshot', targetId: manifest.id, detail: { files: manifest.files.length, bytes: manifest.totals.bytes, excluded: manifest.excluded.length, pinned: input.pinned },
  });
  const [snapshot] = await tx.query<SnapshotRow>(`SELECT ${SNAPSHOT_COLUMNS} FROM work.snapshots WHERE id = $1`, [manifest.id]);
  return { snapshot, created: true };
}

export async function getSnapshot(tx: Queryable, id: string): Promise<(SnapshotRow & { manifest: SnapshotManifest }) | undefined> {
  const [row] = await tx.query<SnapshotRow & { manifest: SnapshotManifest }>(`SELECT ${SNAPSHOT_COLUMNS}, manifest FROM work.snapshots WHERE id = $1`, [id]);
  return row;
}

export async function listSnapshots(tx: Queryable, projectId: string, sessionId?: string): Promise<SnapshotRow[]> {
  return tx.query<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM work.snapshots WHERE project_id = $1 AND ($2::text IS NULL OR session_id = $2)
      ORDER BY created_at DESC LIMIT 200`,
    [projectId, sessionId ?? null],
  );
}

export interface RetentionReport {
  snapshots: number;
  projectBlobs: number;
  blobs: number;
}

/**
 * Retention (WORKSPACE_RECOVERY.md §7), on the owner connection:
 * keep pinned snapshots, the latest snapshot of every unfinished session,
 * everything younger than `keepAllDays`, and one per session per day up to
 * `keepDailyDays`; then drop project blob claims no snapshot uses (older
 * than `blobGraceHours`) and blob bodies no project claims.
 */
export async function applyRetention(
  db: Queryable,
  storage: ServerBlobStorage,
  options: { keepAllDays?: number; keepDailyDays?: number; blobGraceHours?: number } = {},
): Promise<RetentionReport> {
  const keepAll = `${options.keepAllDays ?? 7} days`;
  const keepDaily = `${options.keepDailyDays ?? 30} days`;
  const grace = `${options.blobGraceHours ?? 24} hours`;
  const snapshots = await db.query<{ id: string }>(
    `WITH ranked AS (
       SELECT s.id, s.pinned, s.created_at, se.status,
              -- Snapshots without a session (pmi workspace snapshot) form one series per project.
              row_number() OVER (PARTITION BY COALESCE(s.session_id, 'project:' || s.project_id) ORDER BY s.created_at DESC) AS newest,
              row_number() OVER (PARTITION BY COALESCE(s.session_id, 'project:' || s.project_id), date_trunc('day', s.created_at) ORDER BY s.created_at DESC) AS daily
         FROM work.snapshots s LEFT JOIN work.sessions se ON se.id = s.session_id)
     DELETE FROM work.snapshots WHERE id IN (
       SELECT id FROM ranked
        WHERE NOT pinned
          AND NOT (newest = 1 AND COALESCE(status, 'in_progress') NOT IN ('completed', 'failed'))
          AND created_at < now() - $1::interval
          AND (created_at < now() - $2::interval OR daily > 1))
     RETURNING id`,
    [keepAll, keepDaily],
  );
  const claims = await db.query<{ sha256: string }>(
    `DELETE FROM work.project_blobs pb
      WHERE pb.created_at < now() - $1::interval
        AND NOT EXISTS (SELECT 1 FROM work.snapshot_blobs sb WHERE sb.project_id = pb.project_id AND sb.sha256 = pb.sha256)
      RETURNING sha256`,
    [grace],
  );
  const orphans = await db.query<{ sha256: string }>(
    `SELECT b.sha256 FROM work.blobs b WHERE NOT EXISTS (SELECT 1 FROM work.project_blobs pb WHERE pb.sha256 = b.sha256)
        AND b.created_at < now() - $1::interval`,
    [grace],
  );
  for (const { sha256 } of orphans) await storage.remove(db, sha256);
  return { snapshots: snapshots.length, projectBlobs: claims.length, blobs: orphans.length };
}
