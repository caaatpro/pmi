/**
 * Resolves a `SyncRemote` from configuration. Provider choice is data, not
 * code: the caller picks a provider name and the matching adapter is
 * lazy-imported so unused providers never load their optional SDKs.
 *
 * Configuration is env-driven and opt-in. Sync is OFF unless
 * `BATON_SYNC_PROVIDER` is set (or an explicit provider is passed).
 */

import type { SyncRemote } from './types.js';
import type { ProjectLink } from '../client/config.js';

export type SyncProvider = 'fs' | 'github' | 's3' | 'postgres' | 'baton';

export interface SyncConfig {
  enabled: boolean;
  provider?: SyncProvider;
}

/**
 * An explicit `BATON_SYNC_PROVIDER` wins; otherwise a working copy linked
 * with `baton project link` syncs with its Baton server.
 */
export function resolveSyncConfig(env: NodeJS.ProcessEnv = process.env, link?: ProjectLink): SyncConfig {
  const provider = env.BATON_SYNC_PROVIDER as SyncProvider | undefined;
  if (!provider) return link ? { enabled: true, provider: 'baton' } : { enabled: false };
  if (provider !== 'fs' && provider !== 'github' && provider !== 's3' && provider !== 'postgres' && provider !== 'baton') {
    throw new Error(`[baton] unknown BATON_SYNC_PROVIDER "${provider}" (expected fs|github|s3|postgres|baton)`);
  }
  return { enabled: true, provider };
}

export interface RemoteContext {
  /** `.baton/project.json` of the working copy; required by the baton provider. */
  link?: ProjectLink;
}

export async function createRemote(
  provider: SyncProvider,
  namespace: string,
  env: NodeJS.ProcessEnv = process.env,
  context: RemoteContext = {},
): Promise<SyncRemote> {
  if (provider === 'baton') {
    const link = context.link;
    if (!link) throw new Error('[baton] this working copy is not linked; run `baton project link` first');
    const { tokenFor } = await import('../client/config.js');
    const token = tokenFor(link.server, env);
    if (!token) throw new Error(`[baton] no token for ${link.server}; run \`baton login ${link.server}\``);
    const { createApiClient } = await import('../client/api.js');
    const { BatonServerRemote } = await import('./adapters/baton-server.js');
    return new BatonServerRemote(createApiClient(link.server, token), link.projectId, link.legacyProjectId, namespace);
  }
  if (provider === 'fs') {
    const root = env.BATON_SYNC_FS_ROOT;
    if (!root) throw new Error('[baton] fs sync requires BATON_SYNC_FS_ROOT');
    const { FsRemote } = await import('./adapters/fs.js');
    return new FsRemote({ root, namespace });
  }
  if (provider === 'github') {
    const { createGitHubRemote } = await import('./adapters/github.js');
    return createGitHubRemote(namespace, env);
  }
  if (provider === 's3') {
    const { createS3ObjectStore, ObjectStoreRemote } = await import('./adapters/object-store.js');
    return new ObjectStoreRemote(await createS3ObjectStore(env), namespace, env.BATON_SYNC_S3_PREFIX ?? '');
  }
  const { createPgSqlClient, PostgresSyncRemote } = await import('./adapters/postgres.js');
  return new PostgresSyncRemote(await createPgSqlClient(env), namespace);
}
