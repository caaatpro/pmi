/**
 * Acceptance TEST 8 — offline buffering and recovery.
 *
 * Two developers' machines (separate HOME, data dir and clone) use the real
 * `baton` CLI against a real baton-server on real Postgres:
 * client A writes while the server is down → its changes wait locally →
 * the server comes back → `baton sync` uploads them → client B receives them.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { createOrganization, createUser, issueToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import { cliBuilt, createRepoPair, machine, baton, type Machine, stopDaemons } from './cli-helper.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

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

describe.skipIf(!pgAvailable || !cliBuilt)('TEST 8: offline client buffers and catches up (real CLI, server, Postgres)', () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'baton-test8-'));
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    await createUser(db, { email: 'lead@acme.test', displayName: 'Lead', orgSlug: 'acme', role: 'admin' });
    token = (await issueToken(db, { email: 'lead@acme.test', name: 'test8' })).token;
    await startServer();

    const [repoA, repoB] = createRepoPair(root, 'https://github.com/acme/billing.git');
    a = machine(root, 'machine-a', repoA);
    b = machine(root, 'machine-b', repoB);
  }, 180_000);

  afterAll(async () => {
    await stopDaemons([a, b]);
    await stopServer();
    await db?.close();
    await pg?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('links both clones to one server project', async () => {
    const server = `http://127.0.0.1:${port}`;
    for (const m of [a, b]) {
      const login = await baton(m, 'login', server, '--token', token, '--json');
      expect(login.code, login.stderr).toBe(0);
      expect(login.json.user.email).toBe('lead@acme.test');
    }
    const linkA = await baton(a, 'project', 'link', '--create', '--org', 'acme', '--slug', 'billing', '--json');
    expect(linkA.code, linkA.stderr).toBe(0);
    expect(linkA.json).toMatchObject({ created: true, slug: 'billing', legacyProjectId: 'acme/billing' });
    const linkB = await baton(b, 'project', 'link', '--json');
    expect(linkB.code, linkB.stderr).toBe(0);
    expect(linkB.json.projectId).toBe(linkA.json.projectId);

    // .baton/project.json is meant to be committed: linking again to the same project leaves it untouched.
    const linkFile = path.join(a.repo, '.baton', 'project.json');
    const before = readFileSync(linkFile, 'utf8');
    expect((await baton(a, 'project', 'link', '--json')).code).toBe(0);
    expect(readFileSync(linkFile, 'utf8')).toBe(before);
  }, 120_000);

  it('keeps writes made while the server is down and delivers them after it returns', async () => {
    await stopServer();

    for (const [title, text] of [
      ['Invoices are immutable', 'Corrections are issued as credit notes; an invoice row is never updated after issue.'],
      ['Currency stored in minor units', 'Amounts are integers in minor units to avoid floating point rounding.'],
    ]) {
      const stored = await baton(a, 'memory', 'store', '--title', title, '--text', text, '--type', 'decision', '--entity', 'billing', '--json');
      expect(stored.code, stored.stderr).toBe(0);
    }

    const offlineStatus = await baton(a, 'sync', 'status', '--json');
    expect(offlineStatus.code).toBe(3);
    expect(offlineStatus.json).toMatchObject({ offline: true });
    expect(offlineStatus.json.pushed).toBe(2);

    const offlineSync = await baton(a, 'sync', '--json');
    expect(offlineSync.code).toBe(3);
    expect(offlineSync.stderr).toContain('unreachable');
    const local = await baton(a, 'memory', 'search', '--query', 'credit notes', '--json');
    expect(local.stdout).toContain('Invoices are immutable');

    await startServer();

    const pushed = await baton(a, 'sync', '--json');
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(pushed.json.pushed).toBe(2);
    const rows = await db.query<{ title: string; category: string; confidence: string }>(
      "SELECT title, category, confidence FROM memory.memories WHERE deleted_at IS NULL ORDER BY title",
    );
    expect(rows).toEqual([
      { title: 'Currency stored in minor units', category: 'architecture_decision', confidence: 'proposed' },
      { title: 'Invoices are immutable', category: 'architecture_decision', confidence: 'proposed' },
    ]);

    const pulled = await baton(b, 'sync', '--json');
    expect(pulled.code, pulled.stderr).toBe(0);
    expect(pulled.json.applied).toBe(2);
    const onB = await baton(b, 'memory', 'search', '--query', 'minor units', '--json');
    expect(onB.stdout).toContain('Currency stored in minor units');

    const again = await baton(a, 'sync', '--json');
    expect(again.json).toMatchObject({ pushed: 0, applied: 0 });
  }, 180_000);
});

describe.skipIf(pgAvailable && cliBuilt)('TEST 8', () => {
  it.skip(`${pgSkipReason}; also requires \`npm run build\``, () => undefined);
});
