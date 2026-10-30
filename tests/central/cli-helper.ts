/**
 * Simulated developer machines for end-to-end tests: each has its own HOME,
 * Memorix data dir, PMI credentials and git clone, and drives the built
 * `pmi` CLI (and its stdio MCP server) as a separate process.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const CLI = path.resolve(__dirname, '../../dist/cli/index.js');
export const cliBuilt = existsSync(CLI);

export interface Machine {
  name: string;
  home: string;
  repo: string;
  env: Record<string, string>;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repository with an origin remote, and a clone of it for a second machine. */
export function createRepoPair(root: string, origin: string): [string, string] {
  const repoA = path.join(root, 'a-repo');
  mkdirSync(repoA);
  git(repoA, 'init', '-q', '-b', 'main');
  git(repoA, 'config', 'user.email', 'a@test.dev');
  git(repoA, 'config', 'user.name', 'A');
  git(repoA, 'remote', 'add', 'origin', origin);
  git(repoA, 'commit', '-q', '--allow-empty', '-m', 'root');
  const repoB = path.join(root, 'b-repo');
  git(root, 'clone', '-q', repoA, repoB);
  git(repoB, 'remote', 'set-url', 'origin', origin);
  return [repoA, repoB];
}

export function machine(root: string, name: string, repo: string): Machine {
  const home = path.join(root, name);
  mkdirSync(home, { recursive: true });
  return {
    name,
    home,
    repo,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      USERPROFILE: home,
      MEMORIX_DATA_DIR: path.join(home, 'data'),
      PMI_HOME: path.join(home, '.pmi'),
      MEMORIX_AUTO_UPDATE: 'off',
      MEMORIX_SYNC_DEVICE_FINGERPRINT: `test|${name}`,
    },
  };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

/** Async on purpose: test servers run in this process and must keep serving while the CLI waits. */
export function pmi(m: Machine, ...args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: m.repo, env: m.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      let json: any;
      try { json = JSON.parse(stdout); } catch { json = undefined; }
      resolve({ code: code ?? -1, stdout, stderr, json });
    });
  });
}

/** An agent's view: the real `pmi serve` stdio MCP server in the machine's repository. */
export async function connectAgent(m: Machine, agent: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'serve', '--cwd', m.repo],
    cwd: m.repo,
    env: { ...m.env, MEMORIX_MODE: 'full' },
    stderr: 'ignore',
  });
  const client = new Client({ name: agent, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

export function toolText(result: unknown): string {
  return ((result as { content?: Array<{ text?: string }> })?.content ?? []).map((item) => item.text ?? '').join('\n');
}
