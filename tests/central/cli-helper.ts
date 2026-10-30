/**
 * Simulated developer machines for end-to-end tests: each has its own HOME,
 * Memorix data dir, PMI credentials and git clone, and drives the built
 * `pmi` CLI (and its stdio MCP server) as a separate process.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * `pmi` and `memorix` executables on PATH that run the built CLI, so agent
 * configs written by `pmi setup` (command "memorix") start this build.
 */
export function installCliShims(root: string): string {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['pmi', 'memorix']) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
    chmodSync(file, 0o755);
  }
  return bin;
}

export function machine(root: string, name: string, repo: string, extraEnv: Record<string, string> = {}): Machine {
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
      ...extraEnv,
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

/** Launch an MCP server the way an agent would, from the command/args in its config. */
export async function connectAgentWithCommand(m: Machine, agent: string, command: string, args: string[]): Promise<{ client: Client; pid: () => number | null }> {
  const transport = new StdioClientTransport({ command, args, cwd: m.repo, env: m.env, stderr: 'ignore' });
  const client = new Client({ name: agent, version: '1.0.0' });
  await client.connect(transport);
  return { client, pid: () => transport.pid };
}

export function toolText(result: unknown): string {
  return ((result as { content?: Array<{ text?: string }> })?.content ?? []).map((item) => item.text ?? '').join('\n');
}

/**
 * Stop the daemons agents start automatically in Connected mode. Run in every
 * end-to-end afterAll so no background process outlives the test.
 */
export async function stopDaemons(machines: Array<Machine | undefined>): Promise<void> {
  for (const m of machines) {
    if (!m) continue;
    await pmi(m, 'daemon', 'stop');
    const pidFile = path.join(m.env.MEMORIX_DATA_DIR, 'pmi-daemon.pid');
    try {
      const pid = Number(JSON.parse(readFileSync(pidFile, 'utf8')).pid);
      if (pid) process.kill(pid, 'SIGKILL');
    } catch { /* not running */ }
  }
}

