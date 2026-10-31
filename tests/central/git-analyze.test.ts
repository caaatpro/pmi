/**
 * Acceptance TEST 5 in Connected mode: real CLI on two machines, pmi-server,
 * Postgres. The cursor is shared by the team: 5 new commits are analyzed
 * exactly once even when both machines run the analysis at the same time;
 * the resulting knowledge and the review mark on outdated knowledge reach
 * the other machine through sync.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { createOrganization, createUser, issueToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import { cliBuilt, git, machine, pmi, stopDaemons, type Machine } from './cli-helper.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

const FUTURE = new Date(Date.now() + 3 * 86_400_000).toISOString();
let root = '';
let pg: TestPostgres;
let db: Database;
let server: http.Server;
let serverUrl = '';
let alice: Machine;
let bob: Machine;
let origin = '';

function commitAll(repo: string, message: string): void {
  git(repo, 'add', '-A');
  // Dated after the seeded memory, so the staleness grace window does not hide the change.
  process.env.GIT_AUTHOR_DATE = FUTURE;
  process.env.GIT_COMMITTER_DATE = FUTURE;
  try {
    git(repo, 'commit', '-q', '-m', message);
  } finally {
    delete process.env.GIT_AUTHOR_DATE;
    delete process.env.GIT_COMMITTER_DATE;
  }
}

function put(repo: string, rel: string, content: string): void {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), content);
}

describe.skipIf(!pgAvailable || !cliBuilt)('TEST 5: incremental git analysis shared through the server', () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'pmi-git-e2e-'));
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    const tokens: Record<string, string> = {};
    for (const [name, role] of [['alice', 'admin'], ['bob', 'admin']] as const) {
      await createUser(db, { email: `${name}@acme.test`, displayName: name, orgSlug: 'acme', role });
      tokens[name] = (await issueToken(db, { email: `${name}@acme.test`, name })).token;
    }
    server = createCentralServer({ db, version: 'test', log: () => undefined });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    origin = path.join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    const repoA = path.join(root, 'a');
    git(root, 'clone', '-q', origin, repoA);
    git(repoA, 'config', 'user.email', 'a@test.dev');
    git(repoA, 'config', 'user.name', 'A');
    put(repoA, 'package.json', JSON.stringify({ name: 'shop', dependencies: { express: '^4.18.0' } }, null, 2) + '\n');
    put(repoA, 'src/util.ts', 'export const round = (n: number) => Math.round(n);\n');
    put(repoA, 'src/legacy.ts', 'export const legacy = 1;\n');
    put(repoA, 'src/cart.ts', 'export const cart = [];\n');
    git(repoA, 'add', '-A');
    git(repoA, 'commit', '-q', '-m', 'initial');
    git(repoA, 'push', '-q', 'origin', 'main');
    const repoB = path.join(root, 'b');
    git(root, 'clone', '-q', origin, repoB);
    git(repoB, 'config', 'user.email', 'b@test.dev');
    git(repoB, 'config', 'user.name', 'B');
    for (const repo of [repoA, repoB]) {
      git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/shop.git');
      git(repo, 'remote', 'add', 'local', origin);
      git(repo, 'config', 'branch.main.remote', 'local');
      // The link file stays local in this team (not committed).
      writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.pmi/\n');
    }
    alice = machine(root, 'alice-home', repoA, { PMI_DAEMON: 'off' });
    bob = machine(root, 'bob-home', repoB, { PMI_DAEMON: 'off' });
    expect((await pmi(alice, 'login', serverUrl, '--token', tokens.alice)).code).toBe(0);
    expect((await pmi(bob, 'login', serverUrl, '--token', tokens.bob)).code).toBe(0);
    expect((await pmi(alice, 'project', 'link', '--create', '--org', 'acme', '--slug', 'shop')).code).toBe(0);
    expect((await pmi(bob, 'project', 'link')).code).toBe(0);
  }, 180_000);

  afterAll(async () => {
    await stopDaemons([alice, bob]);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db?.close();
    await pg?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('analyzes the first window once, then exactly the 5 new commits, once for the whole team', async () => {
    const first = await pmi(alice, 'git', 'analyze', '--json');
    expect(first.code, first.stderr).toBe(0);
    expect(first.json).toMatchObject({ mode: 'server', commitsAnalyzed: 1, initial: true });

    // Knowledge Bob wrote earlier about src/util.ts, synced to the server.
    const note = await pmi(bob, 'memory', 'store', '--type', 'how-it-works', '--entity', 'util', '--title', 'Rounding helper lives in src/util.ts', '--text', 'round() is for display only.', '--files', 'src/util.ts', '--json');
    expect(note.code, note.stderr).toBe(0);
    expect((await pmi(bob, 'sync', '--json')).code).toBe(0);

    const a = alice.repo;
    put(a, 'package.json', JSON.stringify({ name: 'shop', dependencies: { express: '^4.19.2', zod: '^3.24.0' } }, null, 2) + '\n');
    commitAll(a, 'chore: add zod and update express');
    put(a, 'src/routes/orders.ts', 'export const listOrders = () => [];\n');
    commitAll(a, 'feat: orders endpoint');
    rmSync(path.join(a, 'src/legacy.ts'));
    commitAll(a, 'refactor: drop legacy module');
    put(a, 'src/cart.ts', 'export const cart: number[] = [];\n');
    commitAll(a, 'fix: handle empty cart (fixes #42)');
    git(a, 'mv', 'src/util.ts', 'src/helpers.ts');
    commitAll(a, 'refactor: rename util to helpers');
    git(a, 'push', '-q', 'local', 'main');
    git(bob.repo, 'pull', '-q', 'local', 'main');

    // Both machines analyze at the same time; the shared cursor lets only one of them do the work.
    const [ra, rb] = await Promise.all([pmi(alice, 'git', 'analyze', '--json'), pmi(bob, 'git', 'analyze', '--json')]);
    expect(ra.code, ra.stderr).toBe(0);
    expect(rb.code, rb.stderr).toBe(0);
    expect(ra.json.commitsAnalyzed + rb.json.commitsAnalyzed).toBe(5);
    const [{ n }] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM work.git_commits');
    expect(n).toBe(6);
    const [cursor] = await db.query<{ last_analyzed_commit: string }>('SELECT last_analyzed_commit FROM work.git_cursors');
    expect(cursor.last_analyzed_commit).toBe(git(a, 'rev-parse', 'HEAD'));

    const rows = await db.query<{ topic_key: string; category: string; confidence: string; facts: string[]; writer: string }>(
      "SELECT topic_key, category, confidence, facts, writer FROM memory.memories WHERE topic_key LIKE 'git%'",
    );
    const kinds = rows.map((row) => row.topic_key.split(':')[0]);
    expect(kinds.filter((kind) => kind === 'git')).toHaveLength(6);
    for (const kind of ['git-dependencies', 'git-api', 'git-removed', 'git-fix']) expect(kinds, kind).toContain(kind);
    expect(rows.every((row) => row.writer === 'pmi-server')).toBe(true);
    expect(rows.find((row) => row.facts.includes('Added zod@^3.24.0'))).toMatchObject({ category: 'dependency', confidence: 'inferred' });
    const links = await db.query("SELECT 1 FROM memory.memory_links WHERE kind = 'derived_from'");
    expect(links.length).toBeGreaterThanOrEqual(4);

    const [stale] = await db.query<{ status: string; body: any }>("SELECT status, body FROM memory.memories WHERE title = 'Rounding helper lives in src/util.ts'");
    expect(stale.status).toBe('needs_review');
    expect(stale.body.review.reason).toMatch(/all related files were deleted or moved/);

    // Nothing new: 0 commits, from either machine.
    expect((await pmi(alice, 'git', 'analyze', '--json')).json.commitsAnalyzed).toBe(0);
    expect((await pmi(bob, 'git', 'analyze', '--json')).json.commitsAnalyzed).toBe(0);

    // Bob's machine receives the commit knowledge and the review mark by sync.
    const pulled = await pmi(bob, 'sync', '--json');
    expect(pulled.code, pulled.stderr).toBe(0);
    const search = await pmi(bob, 'memory', 'search', '--query', 'zod', '--json');
    expect(search.stdout).toContain('Dependencies changed');
  }, 180_000);

  it('a full reconcile marks knowledge whose files are gone', async () => {
    const note = await pmi(alice, 'memory', 'store', '--type', 'discovery', '--entity', 'x', '--title', 'Notes about src/nowhere.ts', '--text', 'n', '--files', 'src/nowhere.ts', '--json');
    expect(note.code, note.stderr).toBe(0);
    expect((await pmi(alice, 'sync', '--json')).code).toBe(0);
    const full = await pmi(alice, 'git', 'analyze', '--full', '--json');
    expect(full.code, full.stderr).toBe(0);
    expect(full.json.reconcile.marked).toBeGreaterThanOrEqual(1);
    const [row] = await db.query<{ status: string }>("SELECT status FROM memory.memories WHERE title = 'Notes about src/nowhere.ts'");
    expect(row.status).toBe('needs_review');
    const [cursor] = await db.query<{ last_full_reconcile_at: string | null }>('SELECT last_full_reconcile_at FROM work.git_cursors');
    expect(cursor.last_full_reconcile_at).not.toBeNull();
  }, 120_000);
});

describe.skipIf(pgAvailable && cliBuilt)('TEST 5 (server)', () => {
  it.skip(`${pgSkipReason}; also requires \`npm run build\``, () => undefined);
});
