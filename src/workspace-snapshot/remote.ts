/**
 * Moving snapshots between this machine and the Baton server: incremental
 * upload (only blobs the project does not have yet), registration, and
 * download with verification before anything is restored.
 */
import type { BatonApiClient } from '../client/api.js';
import type { LocalSnapshots, LocalSnapshot } from './local.js';
import type { RestoreReport } from './restore.js';
import { manifestBlobs, manifestSha256, type SnapshotManifest } from './snapshot.js';

export interface UploadReport {
  snapshotId: string;
  uploadedBlobs: number;
  uploadedBytes: number;
  created: boolean;
}

export async function uploadSnapshot(
  api: BatonApiClient,
  projectId: string,
  snapshots: LocalSnapshots,
  snapshotId: string,
): Promise<UploadReport> {
  const snapshot = snapshots.get(snapshotId);
  if (!snapshot) throw new Error(`[baton] snapshot ${snapshotId} is not on this device`);
  const blobs = manifestBlobs(snapshot.manifest);
  const { missing } = await api.post<{ missing: string[] }>(`/v1/projects/${projectId}/blobs/missing`, { sha256: blobs });
  let uploadedBytes = 0;
  for (const sha of missing) {
    const data = snapshots.blobs.get(sha);
    await api.putBinary(`/v1/projects/${projectId}/blobs/${sha}`, data);
    uploadedBytes += data.length;
  }
  const result = await api.post<{ created: boolean }>(`/v1/projects/${projectId}/snapshots`, {
    device_id: snapshots.deviceId,
    manifest: snapshot.manifest,
    manifest_sha256: snapshot.manifestSha256,
    pinned: snapshot.pinned,
  });
  snapshots.markRegistered(snapshotId);
  return { snapshotId, uploadedBlobs: missing.length, uploadedBytes, created: result.created };
}

/**
 * Bring a snapshot's manifest and every blob it needs into the local store,
 * verifying the manifest hash and each blob's SHA-256 on the way in.
 */
export async function downloadSnapshot(
  api: BatonApiClient,
  projectId: string,
  snapshots: LocalSnapshots,
  snapshotId: string,
): Promise<LocalSnapshot> {
  const local = snapshots.get(snapshotId);
  const response = local ? undefined : await api.get<{ snapshot: { manifest: SnapshotManifest; manifestSha256: string; pinned: boolean } }>(
    `/v1/snapshots/${encodeURIComponent(snapshotId)}`,
  );
  if (response && manifestSha256(response.snapshot.manifest) !== response.snapshot.manifestSha256) {
    throw new Error('[baton] the downloaded manifest does not match its SHA-256; nothing was changed');
  }
  const snapshot = local ?? snapshots.importManifest(response!.snapshot.manifest, response!.snapshot.manifestSha256, response!.snapshot.pinned);
  for (const sha of manifestBlobs(snapshot.manifest)) {
    if (snapshots.blobs.has(sha)) continue;
    snapshots.blobs.putVerified(sha, await api.getBinary(`/v1/projects/${projectId}/blobs/${sha}`));
  }
  return snapshot;
}

export async function reportRestore(api: BatonApiClient, report: RestoreReport): Promise<void> {
  await api.post(`/v1/snapshots/${encodeURIComponent(report.snapshotId)}/restored`, {
    mode: report.mode,
    verified: report.verified,
    written: report.written.length,
    conflicts: report.conflicts.length,
  });
}
