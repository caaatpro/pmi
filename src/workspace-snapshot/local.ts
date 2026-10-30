/**
 * Local snapshot catalogue: manifests in SQLite (`workspace_snapshots`),
 * bodies in the blob store. A snapshot identical in content to the session's
 * previous one is not stored again — the daemon may checkpoint often, the
 * working copy changes less often.
 */
import { getDatabase } from '../store/sqlite-db.js';
import { localDeviceId } from '../sync/store-port.js';
import { BlobStore, sha256Hex } from './blob-store.js';
import { buildSnapshot, canonicalJson, manifestBlobs, type SnapshotManifest } from './snapshot.js';

export interface LocalSnapshot {
  id: string;
  projectId: string;
  sessionId: string | null;
  manifest: SnapshotManifest;
  manifestSha256: string;
  totalBytes: number;
  pinned: boolean;
  createdAt: string;
  registeredAt: string | null;
}

function rowToSnapshot(row: any): LocalSnapshot {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id ?? null,
    manifest: JSON.parse(row.manifest_json),
    manifestSha256: row.manifest_sha256,
    totalBytes: row.total_bytes,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    registeredAt: row.registered_at ?? null,
  };
}

/** What makes two snapshots the same working copy (ignores id, time and lineage). */
function contentKey(manifest: SnapshotManifest): string {
  return sha256Hex(canonicalJson({ git: manifest.git, files: manifest.files, excluded: manifest.excluded }));
}

export class LocalSnapshots {
  readonly db: any;
  readonly blobs: BlobStore;
  readonly deviceId: string;

  constructor(readonly dataDir: string) {
    this.db = getDatabase(dataDir);
    this.blobs = new BlobStore(dataDir);
    this.deviceId = localDeviceId(this.db);
  }

  get(id: string): LocalSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM workspace_snapshots WHERE id = ?').get(id);
    return row ? rowToSnapshot(row) : undefined;
  }

  list(filter: { projectId?: string; sessionId?: string } = {}): LocalSnapshot[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) { where.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.sessionId) { where.push('session_id = ?'); params.push(filter.sessionId); }
    return this.db.prepare(`SELECT * FROM workspace_snapshots ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`)
      .all(...params).map(rowToSnapshot);
  }

  /**
   * Snapshot the working copy at `root`. Returns the session's previous
   * snapshot instead of a new one when nothing changed (`reused: true`).
   */
  take(input: { root: string; projectId: string; sessionId?: string | null; pinned?: boolean; includeSecrets?: boolean }): { snapshot: LocalSnapshot; reused: boolean } {
    const previous = input.sessionId ? this.list({ sessionId: input.sessionId })[0] : undefined;
    const built = buildSnapshot(this.blobs, {
      root: input.root,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      deviceId: this.deviceId,
      parent: previous?.id ?? null,
      includeSecrets: input.includeSecrets,
    });
    const key = contentKey(built.manifest);
    if (previous && this.db.prepare('SELECT content_key FROM workspace_snapshots WHERE id = ?').get(previous.id)?.content_key === key) {
      if (input.pinned && !previous.pinned) this.db.prepare('UPDATE workspace_snapshots SET pinned = 1 WHERE id = ?').run(previous.id);
      return { snapshot: this.get(previous.id)!, reused: true };
    }
    this.db.prepare(`INSERT INTO workspace_snapshots (id, project_id, session_id, manifest_json, manifest_sha256, content_key, total_bytes, pinned, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(built.manifest.id, input.projectId, input.sessionId ?? null, JSON.stringify(built.manifest), built.manifestSha256, key, built.totalBytes, input.pinned ? 1 : 0, built.manifest.createdAt);
    return { snapshot: this.get(built.manifest.id)!, reused: false };
  }

  /** Keep a manifest downloaded from the server so a restore can run from local data. */
  importManifest(manifest: SnapshotManifest, manifestSha256: string, pinned: boolean): LocalSnapshot {
    this.db.prepare(`INSERT OR IGNORE INTO workspace_snapshots (id, project_id, session_id, manifest_json, manifest_sha256, content_key, total_bytes, pinned, created_at, registered_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(manifest.id, manifest.projectId, manifest.sessionId, JSON.stringify(manifest), manifestSha256, contentKey(manifest), manifest.totals.bytes, pinned ? 1 : 0, manifest.createdAt, new Date().toISOString());
    return this.get(manifest.id)!;
  }

  markRegistered(id: string): void {
    this.db.prepare('UPDATE workspace_snapshots SET registered_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  /**
   * Local retention (WORKSPACE_RECOVERY.md §7): keep pinned snapshots, the
   * latest of every session, and everything from the last `keepDays`; then
   * drop blobs no remaining manifest references.
   */
  gc(keepDays = 30, now = Date.now()): { snapshots: number; blobs: number } {
    const cutoff = new Date(now - keepDays * 86_400_000).toISOString();
    const latest = new Set(
      (this.db.prepare(`SELECT id FROM workspace_snapshots s WHERE created_at = (
         SELECT MAX(created_at) FROM workspace_snapshots t
          WHERE COALESCE(t.session_id, 'project:' || t.project_id) = COALESCE(s.session_id, 'project:' || s.project_id))`).all() as Array<{ id: string }>)
        .map((row) => row.id),
    );
    const doomed = (this.db.prepare('SELECT id FROM workspace_snapshots WHERE pinned = 0 AND created_at < ?').all(cutoff) as Array<{ id: string }>)
      .map((row) => row.id).filter((id) => !latest.has(id));
    const remove = this.db.prepare('DELETE FROM workspace_snapshots WHERE id = ?');
    for (const id of doomed) remove.run(id);
    const keep = new Set<string>();
    for (const snapshot of this.list()) for (const sha of manifestBlobs(snapshot.manifest)) keep.add(sha);
    return { snapshots: doomed.length, blobs: this.blobs.gc(keep) };
  }
}
