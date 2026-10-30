/**
 * Local client configuration for Connected mode:
 *
 * - `~/.pmi/credentials.json` (mode 0600): personal access token per server.
 *   Never inside the repository, never in project memory.
 * - `<repo>/.pmi/project.json`: which server project this working copy
 *   replicates. Holds no secret and may be committed so teammates link the
 *   same project.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServerCredential {
  token: string;
  email?: string;
  savedAt: string;
}

export interface CredentialsFile {
  default?: string;
  servers: Record<string, ServerCredential>;
}

export interface ProjectLink {
  server: string;
  projectId: string;
  slug: string;
  legacyProjectId: string;
  linkedAt: string;
}

export function pmiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PMI_HOME?.trim() || path.join(os.homedir(), '.pmi');
}

function credentialsPath(env?: NodeJS.ProcessEnv): string {
  return path.join(pmiHome(env), 'credentials.json');
}

/** Canonical server URL: scheme + host + optional path prefix, no trailing slash. */
export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error(`not a valid server URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`unsupported URL scheme ${url.protocol}`);
  if (url.protocol === 'http:' && !isLoopback(url.hostname) && process.env.PMI_ALLOW_INSECURE_HTTP !== '1') {
    throw new Error('refusing to send a token over plain HTTP to a non-local server; use https:// or set PMI_ALLOW_INSECURE_HTTP=1');
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}

export function readCredentials(env?: NodeJS.ProcessEnv): CredentialsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(env), 'utf8')) as CredentialsFile;
    return { default: parsed.default, servers: parsed.servers ?? {} };
  } catch {
    return { servers: {} };
  }
}

export function writeCredentials(file: CredentialsFile, env?: NodeJS.ProcessEnv): void {
  const target = credentialsPath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

/** Token for a server: `PMI_TOKEN` wins, then the saved credential. */
export function tokenFor(server: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.PMI_TOKEN?.trim()) return env.PMI_TOKEN.trim();
  return readCredentials(env).servers[server]?.token;
}

export function projectLinkPath(projectRoot: string): string {
  return path.join(projectRoot, '.pmi', 'project.json');
}

export function readProjectLink(projectRoot: string): ProjectLink | undefined {
  try {
    const link = JSON.parse(fs.readFileSync(projectLinkPath(projectRoot), 'utf8')) as ProjectLink;
    return link.server && link.projectId && link.legacyProjectId ? link : undefined;
  } catch {
    return undefined;
  }
}

export function writeProjectLink(projectRoot: string, link: ProjectLink): void {
  const target = projectLinkPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(link, null, 2)}\n`);
}
