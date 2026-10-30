/**
 * Server side of workspace recovery (WORKSPACE_RECOVERY.md §4, §7):
 * content-addressed blob storage, snapshot registration, retention and GC.
 *
 * Blobs under 256 KiB live in Postgres; larger ones in `blobDir` (a volume).
 * Storage is shared and deduplicated, but a project sees a blob only after
 * one of its members uploaded it (`work.project_blobs`), so the server never
 * answers "does any project have this hash?".
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sha256Hex } from '../../workspace-snapshot/blob-store.js';
import { manifestBlobs, manifestSha256, type SnapshotManifest } from '../../workspace-snapshot/snapshot.js';
import type { Queryable } from './db.js';
import { HttpError, audit, type AuthUser, type ProjectRecord } from './identity.js';
import { getSession } from './sessions-repo.js';

export const INLINE_BLOB_LIMIT = 256 * 1024;

/** `PMIE1` + key id (8) + IV (12) + GCM tag (16) + ciphertext. */
const ENCRYPTED_MAGIC = Buffer.from('PMIE1');

function keyId(key: Buffer): Buffer {
  return createHash('sha256').update(key).digest().subarray(0, 8);
}

function parseKey(value: string, name: string): Buffer {
  const key = Buffer.from(value.trim(), 'base64');
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded (openssl rand -base64 32)`);
  return key;
}

export interface BlobKeys {
  /** Encrypts new blobs; absent leaves new blobs unencrypted. */
  current?: Buffer;
  /** Previous keys, still accepted for reading during a rotation. */
  previous: Buffer[];
}

/** PMI_BLOB_KEY (current) and PMI_BLOB_KEYS_OLD (comma-separated previous keys). */
export function blobKeysFromEnv(env: NodeJS.ProcessEnv = process.env): BlobKeys {
  return {
    ...(env.PMI_BLOB_KEY?.trim() ? { current: parseKey(env.PMI_BLOB_KEY, 'PMI_BLOB_KEY') } : {}),
    previous: (env.PMI_BLOB_KEYS_OLD ?? '').split(',').filter((value) => value.trim()).map((value) => parseKey(value, 'PMI_BLOB_KEYS_OLD')),
  };
}

/**
 * Encryption at rest for snapshot blobs (AES-256-GCM). The content address
 * stays the SHA-256 of the plaintext, so deduplication and client
 * verification are unchanged; blobs stored before encryption was enabled
 * remain readable.
 */
export function encryptBlob(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([ENCRYPTED_MAGIC, keyId(key), iv, cipher.getAuthTag(), body]);
}

export function decryptBlob(stored: Buffer, keys: BlobKeys): Buffer {
  if (!stored.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC)) return stored;
  const id = stored.subarray(5, 13);
  const key = [keys.current, ...keys.previous].find((candidate) => candidate && keyId(candidate).equals(id));
  if (!key) throw new HttpError(500, 'blob_key_missing', 'a blob is encrypted with a key this server does not have (set PMI_BLOB_KEYS_OLD)');
  const decipher = createDecipheriv('aes-256-gcm', key, stored.subarray(13, 25));
  decipher.setAuthTag(stored.subarray(25, 41));
  return Buffer.concat([decipher.update(stored.subarray(41)), decipher.final()]);
}

export class ServerBlobStorage {
  constructor(readonly blobDir: string, readonly keys: BlobKeys = blobKeysFromEnv()) {}

  private seal(data: Buffer): Buffer {
    return this.keys.current ? encryptBlob(data, this.keys.current) : data;
  }

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
      fs.writeFileSync(tmp, this.seal(data));
      fs.renameSync(tmp, target);
      await db.query("INSERT INTO work.blobs (sha256, size, storage) VALUES ($1, $2, 'fs') ON CONFLICT DO NOTHING", [sha, data.length]);
    } else {
      await db.query("INSERT INTO work.blobs (sha256, size, storage, data) VALUES ($1, $2, 'inline', $3) ON CONFLICT DO NOTHING", [sha, data.length, this.seal(data)]);
    }
  }

  /** Read and verify a body (owner connection); a damaged blob is an error, never served. */
  async get(db: Queryable, sha: string): Promise<Buffer> {
    const [row] = await db.query<{ storage: string; data: Buffer | null }>('SELECT storage, data FROM work.blobs WHERE sha256 = $1', [sha]);
    if (!row) throw new HttpError(404, 'blob_not_found', 'blob not found');
    const stored = row.storage === 'fs' ? fs.readFileSync(this.filePath(sha)) : row.data!;
    let data: Buffer;
    try {
      data = decryptBlob(stored, this.keys);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, 'blob_corrupted', `stored blob ${sha.slice(0, 12)} failed authenticated decryption`);
    }
    if (sha256Hex(data) !== sha) throw new HttpError(500, 'blob_corrupted', `stored blob ${sha.slice(0, 12)} failed its integrity check`);
    return data;
  }

  /**
   * Re-write every blob with the current key (enabling encryption or
   * finishing a rotation). Each blob is verified before it is replaced.
   */
  async reencryptAll(db: Queryable): Promise<{ rewritten: number; failed: string[] }> {
    if (!this.keys.current) throw new Error('set PMI_BLOB_KEY before re-encrypting');
    const currentId = keyId(this.keys.current);
    let rewritten = 0;
    const failed: string[] = [];
    for (const { sha256, storage } of await db.query<{ sha256: string; storage: string }>('SELECT sha256, storage FROM work.blobs')) {
      try {
        const stored = storage === 'fs' ? fs.readFileSync(this.filePath(sha256)) : (await db.query<{ data: Buffer }>('SELECT data FROM work.blobs WHERE sha256 = $1', [sha256]))[0].data;
        if (stored.subarray(0, 5).equals(ENCRYPTED_MAGIC) && stored.subarray(5, 13).equals(currentId)) continue;
        const plain = await this.get(db, sha256);
        const sealed = encryptBlob(plain, this.keys.current);
        if (storage === 'fs') {
          const target = this.filePath(sha256);
          fs.writeFileSync(`${target}.${process.pid}.tmp`, sealed);
          fs.renameSync(`${target}.${process.pid}.tmp`, target);
        } else {
          await db.query('UPDATE work.blobs SET data = $2 WHERE sha256 = $1', [sha256, sealed]);
        }
        rewritten++;
      } catch {
        failed.push(sha256);
      }
    }
    return { rewritten, failed };
  }

  /** Verify every stored blob against its hash (after a restore from backup). */
  async verifyAll(db: Queryable): Promise<{ checked: number; failed: string[] }> {
    const failed: string[] = [];
    const rows = await db.query<{ sha256: string }>('SELECT sha256 FROM work.blobs');
    for (const { sha256 } of rows) {
      try {
        await this.get(db, sha256);
      } catch {
        failed.push(sha256);
      }
    }
    return { checked: rows.length, failed };
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
