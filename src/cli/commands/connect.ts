/**
 * Connected mode: `pmi login`, `pmi logout`, `pmi project link|show`.
 *
 * Login verifies the token against `/v1/me` before saving it, so a typo never
 * leaves a broken credential behind. Linking writes `.pmi/project.json`; the
 * next `pmi sync` uploads the existing local memory (engine diff against
 * `sync_row_state`), so nothing has to be exported by hand.
 */
import { execFileSync } from 'node:child_process';
import { defineCommand } from 'citty';

import { createApiClient, PmiApiError } from '../../client/api.js';
import {
  normalizeServerUrl,
  readCredentials,
  readProjectLink,
  tokenFor,
  writeCredentials,
  writeProjectLink,
  type ProjectLink,
} from '../../client/config.js';
import { emitError, emitResult } from './operator-shared.js';

interface MeResponse {
  user: { id: string; email: string; displayName: string };
  organizations: Array<{ slug: string; role: string }>;
  projects: Array<{ id: string; slug: string }>;
}

function fail(error: unknown, asJson: boolean): void {
  emitError((error as Error).message, asJson);
  process.exitCode = error instanceof PmiApiError && error.offline ? 3 : 1;
}

async function readStdinToken(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim() || undefined;
}

export const login = defineCommand({
  meta: { name: 'login', description: 'Save a personal access token for a PMI server (verified first)' },
  args: {
    server: { type: 'positional', description: 'Server URL, e.g. https://pmi.example.com', required: true },
    token: { type: 'string', description: 'Personal access token (or pipe it on stdin, or set PMI_TOKEN)' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const asJson = Boolean(args.json);
    try {
      const server = normalizeServerUrl(String(args.server));
      const token = (args.token as string | undefined)?.trim() || process.env.PMI_TOKEN?.trim() || await readStdinToken();
      if (!token) throw new Error('no token given; pass --token, pipe it on stdin, or set PMI_TOKEN (issue one with `pmi-server issue-token <email>`)');
      const me = await createApiClient(server, token).get<MeResponse>('/v1/me');
      const credentials = readCredentials();
      credentials.servers[server] = { token, email: me.user.email, savedAt: new Date().toISOString() };
      credentials.default = server;
      writeCredentials(credentials);
      emitResult(
        { server, user: me.user, organizations: me.organizations },
        `Logged in to ${server} as ${me.user.email} (${me.organizations.map((org) => `${org.slug}:${org.role}`).join(', ') || 'no organizations'})`,
        asJson,
      );
    } catch (error) {
      fail(error, asJson);
    }
  },
});

export const logout = defineCommand({
  meta: { name: 'logout', description: 'Forget the saved token for a PMI server' },
  args: {
    server: { type: 'positional', description: 'Server URL (default: the last one logged in to)', required: false },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const asJson = Boolean(args.json);
    try {
      const credentials = readCredentials();
      const server = args.server ? normalizeServerUrl(String(args.server)) : credentials.default;
      if (!server || !credentials.servers[server]) {
        emitResult({ server: server ?? null, removed: false }, 'Not logged in.', asJson);
        return;
      }
      delete credentials.servers[server];
      if (credentials.default === server) credentials.default = Object.keys(credentials.servers)[0];
      writeCredentials(credentials);
      emitResult({ server, removed: true }, `Removed the token for ${server}. Revoke it on the server with \`pmi-server revoke-token\`.`, asJson);
    } catch (error) {
      fail(error, asJson);
    }
  },
});

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Oldest root commit: survives remote renames and forks, unlike the remote URL. */
export function repositoryRootCommit(cwd: string): string | undefined {
  return gitOutput(cwd, ['rev-list', '--max-parents=0', 'HEAD'])?.split('\n').sort()[0];
}

function remoteUrls(cwd: string): string[] {
  const output = gitOutput(cwd, ['remote', '-v']) ?? '';
  const urls = output.split('\n').map((line) => line.split(/\s+/)[1]).filter(Boolean);
  // Strip credentials embedded in https remotes before they leave the machine.
  return [...new Set(urls.map((url) => url.replace(/^(https?:\/\/)[^@/]+@/, '$1')))];
}

const link = defineCommand({
  meta: { name: 'link', description: 'Link this working copy to a project on the PMI server' },
  args: {
    server: { type: 'string', description: 'Server URL (default: the last one logged in to)' },
    create: { type: 'boolean', description: 'Create the project when none matches (org owner/admin)', default: false },
    org: { type: 'string', description: 'Organization slug for --create' },
    slug: { type: 'string', description: 'Project slug for --create' },
    name: { type: 'string', description: 'Project name for --create' },
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const asJson = Boolean(args.json);
    try {
      const server = args.server ? normalizeServerUrl(String(args.server)) : readCredentials().default;
      if (!server) throw new Error('no server; run `pmi login <url>` first or pass --server');
      const token = tokenFor(server);
      if (!token) throw new Error(`no token for ${server}; run \`pmi login ${server}\``);

      const { getCliProjectContext } = await import('./operator-shared.js');
      const { project } = await getCliProjectContext();
      const rootCommit = repositoryRootCommit(project.rootPath);
      const result = await createApiClient(server, token).post<{ project: { id: string; slug: string }; created: boolean }>(
        '/v1/projects/resolve',
        {
          legacy_project_id: project.id,
          ...(rootCommit ? { root_commit: rootCommit } : {}),
          remote_urls: remoteUrls(project.rootPath),
          ...(args.create ? { create: { org: args.org, slug: args.slug, name: args.name } } : {}),
        },
      );
      const projectLink: ProjectLink = {
        server,
        projectId: result.project.id,
        slug: result.project.slug,
        legacyProjectId: project.id,
        linkedAt: new Date().toISOString(),
      };
      // The link is usually committed: leave it untouched when nothing changed.
      const existing = readProjectLink(project.rootPath);
      const unchanged = existing && existing.server === projectLink.server && existing.projectId === projectLink.projectId
        && existing.slug === projectLink.slug && existing.legacyProjectId === projectLink.legacyProjectId;
      if (!unchanged) writeProjectLink(project.rootPath, projectLink);
      emitResult(
        { ...projectLink, created: result.created },
        `${result.created ? 'Created and linked' : 'Linked'} project ${result.project.slug} on ${server}.\nRun \`pmi sync\` to upload local memory and pull the team's.`,
        asJson,
      );
    } catch (error) {
      if (error instanceof PmiApiError && error.code === 'project_not_found') {
        emitError('no project on the server matches this repository; ask an org admin, or pass --create if you are one', asJson);
        process.exitCode = 1;
        return;
      }
      fail(error, asJson);
    }
  },
});

const show = defineCommand({
  meta: { name: 'show', description: 'Show which PMI project this working copy is linked to' },
  args: { json: { type: 'boolean', default: false } },
  async run({ args }) {
    const asJson = Boolean(args.json);
    const { getCliProjectContext } = await import('./operator-shared.js');
    const { project } = await getCliProjectContext();
    const current = readProjectLink(project.rootPath);
    emitResult(
      { localProjectId: project.id, link: current ?? null },
      current ? `Linked to ${current.slug} (${current.projectId}) on ${current.server}` : `Not linked (local project ${project.id}).`,
      asJson,
    );
  },
});

export const projectCommand = defineCommand({
  meta: { name: 'project', description: 'Connect this working copy to a PMI server project' },
  subCommands: { link, show },
});
