/**
 * Acceptance TEST 8 — offline buffering and recovery.
 *
 * Two developers' machines (separate HOME, data dir and clone) use the real
 * `pmi` CLI against a real pmi-server on real Postgres:
 * client A writes while the server is down → its changes wait locally →
 * the server comes back → `pmi sync` uploads them → client B receives them.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { createOrganization, createUser, issueToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

const CLI = path.resolve(__dirname, '../../dist/cli/index.js');
const cliBuilt = existsSync(CLI);

interface Machine {
  home: string;
  repo: string;
  env: NodeJS.ProcessEnv;
}

let root = '';
let pg: TestPostgres;
let db: Database;
let server: http.Server | undefined;
let port = 0;
let token = '';
let a: Machine;
let b: Machine;

async function startServer(): Promise<void> {
  server = createCentralServer({ db, version: 'test', log: () => undefined });
  await new Promise<void>((resolve) => server!.listen(port, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}

async function stopServer(): Promise<void> {
  if (!server) return;
  const closing = new Promise<void>((resolve) => server!.close(() => resolve()));
  server.closeAllConnections();
  await closing;
  server = undefined;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function machine(name: string, repo: string): Machine {
  const home = path.join(root, name);
  mkdirSync(home, { recursive: true });
  return {
    home,
    repo,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      MEMORIX_DATA_DIR: path.join(home, 'data'),
      PMI_HOME: path.join(home, '.pmi'),
      MEMORIX_AUTO_UPDATE: 'off',
      MEMORIX_SYNC_DEVICE_FINGERPRINT: `test|${name}`,
    },
  };
}

/** Async on purpose: the server runs in this process and must keep serving while the CLI waits. */
function pmi(m: Machine, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string; json: any }> {
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

describe.skipIf(!pgAvailable || !cliBuilt)('TEST 8: offline client buffers and catches up (real CLI, server, Postgres)', () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'pmi-test8-'));
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    await createUser(db, { email: 'lead@acme.test', displayName: 'Lead', orgSlug: 'acme', role: 'admin' });
    token = (await issueToken(db, { email: 'lead@acme.test', name: 'test8' })).token;
    await startServer();

    const repoA = path.join(root, 'a-repo');
    mkdirSync(repoA);
    git(repoA, 'init', '-q', '-b', 'main');
    git(repoA, 'config', 'user.email', 'lead@acme.test');
    git(repoA, 'config', 'user.name', 'Lead');
    git(repoA, 'remote', 'add', 'origin', 'https://github.com/acme/billing.git');
    git(repoA, 'commit', '-q', '--allow-empty', '-m', 'root');
    const repoB = path.join(root, 'b-repo');
    git(root, 'clone', '-q', repoA, repoB);
    git(repoB, 'remote', 'set-url', 'origin', 'https://github.com/acme/billing.git');
    a = machine('machine-a', repoA);
    b = machine('machine-b', repoB);
  }, 180_000);

  afterAll(async () => {
    await stopServer();
    await db?.close();
    await pg?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('links both clones to one server project', async () => {
    const server = `http://127.0.0.1:${port}`;
    for (const m of [a, b]) {
      const login = await pmi(m, 'login', server, '--token', token, '--json');
      expect(login.code, login.stderr).toBe(0);
      expect(login.json.user.email).toBe('lead@acme.test');
    }
    const linkA = await pmi(a, 'project', 'link', '--create', '--org', 'acme', '--slug', 'billing', '--json');
    expect(linkA.code, linkA.stderr).toBe(0);
    expect(linkA.json).toMatchObject({ created: true, slug: 'billing', legacyProjectId: 'acme/billing' });
    const linkB = await pmi(b, 'project', 'link', '--json');
    expect(linkB.code, linkB.stderr).toBe(0);
    expect(linkB.json.projectId).toBe(linkA.json.projectId);
  }, 120_000);

  it('keeps writes made while the server is down and delivers them after it returns', async () => {
    await stopServer();

    for (const [title, text] of [
      ['Invoices are immutable', 'Corrections are issued as credit notes; an invoice row is never updated after issue.'],
      ['Currency stored in minor units', 'Amounts are integers in minor units to avoid floating point rounding.'],
    ]) {
      const stored = await pmi(a, 'memory', 'store', '--title', title, '--text', text, '--type', 'decision', '--entity', 'billing', '--json');
      expect(stored.code, stored.stderr).toBe(0);
    }

    const offlineStatus = await pmi(a, 'sync', 'status', '--json');
    expect(offlineStatus.code).toBe(3);
    expect(offlineStatus.json).toMatchObject({ offline: true });
    expect(offlineStatus.json.pushed).toBe(2);

    const offlineSync = await pmi(a, 'sync', '--json');
    expect(offlineSync.code).toBe(3);
    expect(offlineSync.stderr).toContain('unreachable');
    const local = await pmi(a, 'memory', 'search', '--query', 'credit notes', '--json');
    expect(local.stdout).toContain('Invoices are immutable');

    await startServer();

    const pushed = await pmi(a, 'sync', '--json');
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(pushed.json.pushed).toBe(2);
    const rows = await db.query<{ title: string; category: string; confidence: string }>(
      "SELECT title, category, confidence FROM memory.memories WHERE deleted_at IS NULL ORDER BY title",
    );
    expect(rows).toEqual([
      { title: 'Currency stored in minor units', category: 'architecture_decision', confidence: 'proposed' },
      { title: 'Invoices are immutable', category: 'architecture_decision', confidence: 'proposed' },
    ]);

    const pulled = await pmi(b, 'sync', '--json');
    expect(pulled.code, pulled.stderr).toBe(0);
    expect(pulled.json.applied).toBe(2);
    const onB = await pmi(b, 'memory', 'search', '--query', 'minor units', '--json');
    expect(onB.stdout).toContain('Currency stored in minor units');

    const again = await pmi(a, 'sync', '--json');
    expect(again.json).toMatchObject({ pushed: 0, applied: 0 });
  }, 180_000);
});

describe.skipIf(pgAvailable && cliBuilt)('TEST 8', () => {
  it.skip(`${pgSkipReason}; also requires \`npm run build\``, () => undefined);
});
