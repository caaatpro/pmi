/**
 * Resolves a `SyncRemote` from configuration. Provider choice is data, not
 * code: the caller picks a provider name and the matching adapter is
 * lazy-imported so unused providers never load their optional SDKs.
 *
 * Configuration is env-driven and opt-in. Sync is OFF unless
 * `MEMORIX_SYNC_PROVIDER` is set (or an explicit provider is passed).
 */

import type { SyncRemote } from './types.js';
import type { ProjectLink } from '../client/config.js';

export type SyncProvider = 'fs' | 'github' | 's3' | 'postgres' | 'pmi';

export interface SyncConfig {
  enabled: boolean;
  provider?: SyncProvider;
}

/**
 * An explicit `MEMORIX_SYNC_PROVIDER` wins; otherwise a working copy linked
 * with `pmi project link` syncs with its PMI server.
 */
export function resolveSyncConfig(env: NodeJS.ProcessEnv = process.env, link?: ProjectLink): SyncConfig {
  const provider = env.MEMORIX_SYNC_PROVIDER as SyncProvider | undefined;
  if (!provider) return link ? { enabled: true, provider: 'pmi' } : { enabled: false };
  if (provider !== 'fs' && provider !== 'github' && provider !== 's3' && provider !== 'postgres' && provider !== 'pmi') {
    throw new Error(`[memorix] unknown MEMORIX_SYNC_PROVIDER "${provider}" (expected fs|github|s3|postgres|pmi)`);
  }
  return { enabled: true, provider };
}

export interface RemoteContext {
  /** `.pmi/project.json` of the working copy; required by the pmi provider. */
  link?: ProjectLink;
}

export async function createRemote(
  provider: SyncProvider,
  namespace: string,
  env: NodeJS.ProcessEnv = process.env,
  context: RemoteContext = {},
): Promise<SyncRemote> {
  if (provider === 'pmi') {
    const link = context.link;
    if (!link) throw new Error('[pmi] this working copy is not linked; run `pmi project link` first');
    const { tokenFor } = await import('../client/config.js');
    const token = tokenFor(link.server, env);
    if (!token) throw new Error(`[pmi] no token for ${link.server}; run \`pmi login ${link.server}\``);
    const { createApiClient } = await import('../client/api.js');
    const { PmiServerRemote } = await import('./adapters/pmi-server.js');
    return new PmiServerRemote(createApiClient(link.server, token), link.projectId, link.legacyProjectId, namespace);
  }
  if (provider === 'fs') {
    const root = env.MEMORIX_SYNC_FS_ROOT;
    if (!root) throw new Error('[memorix] fs sync requires MEMORIX_SYNC_FS_ROOT');
    const { FsRemote } = await import('./adapters/fs.js');
    return new FsRemote({ root, namespace });
  }
  if (provider === 'github') {
    const { createGitHubRemote } = await import('./adapters/github.js');
    return createGitHubRemote(namespace, env);
  }
  if (provider === 's3') {
    const { createS3ObjectStore, ObjectStoreRemote } = await import('./adapters/object-store.js');
    return new ObjectStoreRemote(await createS3ObjectStore(env), namespace, env.MEMORIX_SYNC_S3_PREFIX ?? '');
  }
  const { createPgSqlClient, PostgresSyncRemote } = await import('./adapters/postgres.js');
  return new PostgresSyncRemote(await createPgSqlClient(env), namespace);
}
