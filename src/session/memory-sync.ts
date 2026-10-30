/**
 * Memory sync with the PMI server outside the CLI: the daemon runs it for
 * the working copies of its live sessions, so knowledge reaches the team
 * without anyone typing `pmi sync`. One sync per data directory at a time
 * (`pmi-memory-sync.lock`): the sync sequence and row state are shared.
 */
import path from 'node:path';

import { readProjectLink } from '../client/config.js';
import { acquireLock, releaseLock } from '../store/file-lock.js';
import { getObservationStore, initObservationStore } from '../store/obs-store.js';
import { runSync } from '../sync/engine.js';
import { createRemote } from '../sync/remote-factory.js';
import { createSqliteSyncStore } from '../sync/store-port.js';
import type { SyncReport } from '../sync/types.js';

export async function withMemorySyncLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(dataDir, 'pmi-memory-sync.lock');
  await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}

/** Push and pull one linked working copy's memory; undefined when it is not linked. */
export async function syncProjectMemory(dataDir: string, projectRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<SyncReport | undefined> {
  const link = readProjectLink(projectRoot);
  if (!link) return undefined;
  return withMemorySyncLock(dataDir, async () => {
    await initObservationStore(dataDir);
    const syncStore = createSqliteSyncStore(dataDir, getObservationStore(), link.legacyProjectId);
    const remote = await createRemote('pmi', syncStore.namespace(), env, { link });
    return runSync(syncStore, remote, { deviceId: syncStore.deviceId(), dryRun: false, push: true, pull: true });
  });
}
