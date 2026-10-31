/**
 * Acceptance TEST 3 and the negative checks of WORKSPACE_RECOVERY.md §10,
 * end to end: real CLI on two machines, pmi-server, Postgres.
 *
 * Alice's working copy has every kind of change (3 modified files, a deleted
 * one, an untracked one, a binary, a rename, staged + unstaged edits of one
 * file, an executable, a symlink, one unpushed commit, an ignored build
 * output and a .env with a key). Bob has a clean clone and a separate data
 * directory. After restore, every path matches byte for byte and `git
 * status`, `git diff --cached` and `git diff` are identical.
 */
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { createOrganization, createUser, issueToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import { ServerBlobStorage, applyRetention } from '../../src/server/central/snapshots-repo.js';
import { createWorkspaceFixture, git, workingCopy, write } from '../workspace-snapshot/fixture.js';
import { cliBuilt, machine, pmi, stopDaemons, type Machine } from './cli-helper.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

let root = '';
let pg: TestPostgres;
let db: Database;
let server: http.Server;
let serverUrl = '';
let blobDir = '';
let alice: Machine;
let bob: Machine;
let projectId = '';
const tokens: Record<string, string> = {};

async function api(pathname: string, init: { as: string; method?: string; body?: unknown; raw?: Buffer }) {
  const res = await fetch(`${serverUrl}${pathname}`, {
    method: init.method ?? (init.body || init.raw ? 'POST' : 'GET'),
    headers: {
      authorization: `Bearer ${tokens[init.as]}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.raw ? { 'content-type': 'application/octet-stream' } : {}),
    },
    body: init.raw ?? (init.body ? JSON.stringify(init.body) : undefined),
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* binary */ }
  return { status: res.status, body };
}

describe.skipIf(!pgAvailable || !cliBuilt)('workspace recovery end to end', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'pmi-workspace-'));
    blobDir = path.join(root, 'server-blobs');
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    for (const [name, role] of [['alice', 'admin'], ['bob', 'member'], ['vera', 'member'], ['eve', 'member']] as const) {
      await createUser(db, { email: `${name}@acme.test`, displayName: name, orgSlug: 'acme', role });
      tokens[name] = (await issueToken(db, { email: `${name}@acme.test`, name })).token;
    }
    server = createCentralServer({ db, version: 'test', log: () => undefined, blobDir });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const repos = createWorkspaceFixture(root, (repo) => git(repo, 'remote', 'set-url', '--push', 'origin', path.join(root, 'origin.git')));
    // Memorix identity comes from the origin URL; point both clones at the same canonical remote name.
    for (const repo of [repos.a, repos.b]) {
      git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/store.git');
      git(repo, 'remote', 'add', 'local', repos.origin);
      git(repo, 'fetch', '-q', 'local');
      // This team does not commit the PMI link file; keep it out of `git status` like any local config.
      fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.pmi/\n');
    }
    alice = machine(root, 'alice-home', repos.a, { PMI_DAEMON: 'off' });
    bob = machine(root, 'bob-home', repos.b, { PMI_DAEMON: 'off' });

    expect((await pmi(alice, 'login', serverUrl, '--token', tokens.alice)).code).toBe(0);
    expect((await pmi(bob, 'login', serverUrl, '--token', tokens.bob)).code).toBe(0);
    const linked = await pmi(alice, 'project', 'link', '--create', '--org', 'acme', '--slug', 'store', '--json');
    expect(linked.code, linked.stderr).toBe(0);
    projectId = linked.json.projectId;
    for (const [email, role] of [['bob@acme.test', 'developer'], ['vera@acme.test', 'viewer']]) {
      await api(`/v1/projects/${projectId}/grants`, { as: 'alice', method: 'PUT', body: { user: email, role } });
    }
    expect((await pmi(bob, 'project', 'link')).code).toBe(0);
  }, 180_000);

  afterAll(async () => {
    await stopDaemons([alice, bob]);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db?.close();
    await pg?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  let snapshotId = '';

  it('TEST 3: restores Alice\'s uncommitted work on Bob\'s machine byte for byte', async () => {
    const statusBefore = git(alice.repo, 'status', '--porcelain=v1');
    const snap = await pmi(alice, 'workspace', 'snapshot', '--json');
    expect(snap.code, snap.stderr).toBe(0);
    expect(git(alice.repo, 'status', '--porcelain=v1')).toBe(statusBefore);
    snapshotId = snap.json.snapshot.id;
    expect(snap.json.snapshot).toMatchObject({ files: 10, unpushedCommits: 1, excluded: [{ path: '.env', reason: 'secret' }] });
    expect(snap.json.upload.uploadedBlobs).toBeGreaterThan(10);

    const target = path.join(root, 'bob-restored');
    const restored = await pmi(bob, 'workspace', 'restore', snapshotId, '--worktree', target, '--json');
    expect(restored.code, restored.stderr + restored.stdout).toBe(0);
    expect(restored.json).toMatchObject({ verified: true, conflicts: [], importedCommits: 1 });

    const expected = workingCopy(alice.repo);
    delete expected['.env'];
    expect(workingCopy(target)).toEqual(expected);
    expect(git(target, 'rev-parse', 'HEAD')).toBe(git(alice.repo, 'rev-parse', 'HEAD'));
    expect(git(target, 'status', '--porcelain=v1')).toBe(statusBefore.replace('?? .env\n', ''));
    expect(git(target, 'diff', '--cached', '--binary')).toBe(git(alice.repo, 'diff', '--cached', '--binary'));
    expect(git(target, 'diff', '--binary')).toBe(git(alice.repo, 'diff', '--binary'));
    expect(git(bob.repo, 'status', '--porcelain=v1')).toBe('');

    const audit = await db.query("SELECT detail FROM core.audit_log WHERE action = 'snapshot.restore' AND target_id = $1", [snapshotId]);
    expect(audit).toHaveLength(1);
  }, 120_000);

  it('uploads only what changed: one modified file adds its blob and the patch', async () => {
    write(alice.repo, 'b.txt', 'b.txt changed again\n');
    const second = await pmi(alice, 'workspace', 'snapshot', '--json');
    expect(second.code, second.stderr).toBe(0);
    expect(second.json.upload.uploadedBlobs).toBe(2);
  }, 60_000);

  it('a large file is stored on the server volume and still restores exactly', async () => {
    const big = Buffer.alloc(600 * 1024, 7);
    write(alice.repo, 'assets/big.bin', big);
    const snap = await pmi(alice, 'workspace', 'snapshot', '--json');
    const sha = (await db.query<{ sha256: string }>("SELECT sha256 FROM work.blobs WHERE storage = 'fs'"))[0]?.sha256;
    expect(sha).toBeTruthy();
    expect(fs.existsSync(path.join(blobDir, sha.slice(0, 2), sha.slice(2, 4), sha))).toBe(true);
    const target = path.join(root, 'bob-big');
    const restored = await pmi(bob, 'workspace', 'restore', snap.json.snapshot.id, '--worktree', target, '--json');
    expect(restored.json?.verified, restored.stderr).toBe(true);
    expect(fs.readFileSync(path.join(target, 'assets/big.bin')).equals(big)).toBe(true);
    fs.rmSync(path.join(alice.repo, 'assets'), { recursive: true });
  }, 60_000);

  it('refuses a snapshot whose blob was corrupted on the server, without touching the disk', async () => {
    const snap = await pmi(alice, 'workspace', 'snapshot', '--json');
    const id = snap.json.snapshot.id;
    const [manifestRow] = await db.query<{ manifest: any }>('SELECT manifest FROM work.snapshots WHERE id = $1', [id]);
    const victim = manifestRow.manifest.files.find((f: { path: string }) => f.path === 'a.txt').sha256;
    await db.query("UPDATE work.blobs SET data = convert_to('tampered', 'UTF8') WHERE sha256 = $1 AND storage = 'inline'", [victim]);
    // A fresh machine without the blob in its local cache.
    const carol = machine(root, 'carol-home', bob.repo, { PMI_DAEMON: 'off' });
    expect((await pmi(carol, 'login', serverUrl, '--token', tokens.bob)).code).toBe(0);
    const target = path.join(root, 'carol-restored');
    const refused = await pmi(carol, 'workspace', 'restore', id, '--worktree', target);
    expect(refused.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(git(bob.repo, 'status', '--porcelain=v1')).toBe('');
  }, 60_000);

  it('refuses in place on a dirty working copy (exit 2) and leaves it alone', async () => {
    write(bob.repo, 'a.txt', 'bob is editing\n');
    const refused = await pmi(bob, 'workspace', 'restore', snapshotId, '--in-place');
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('dirty');
    expect(fs.readFileSync(path.join(bob.repo, 'a.txt'), 'utf8')).toBe('bob is editing\n');
    git(bob.repo, 'checkout', '--', 'a.txt');
  }, 60_000);

  it('hands off a session with its working copy: resume restores it into a new worktree', async () => {
    write(alice.repo, 'feature/flag.ts', 'export const enabled = true;\n');
    const start = await pmi(alice, 'session', 'start', '--agent', 'claude-code', '--task', 'Feature flags', '--json');
    expect(start.code, start.stderr).toBe(0);
    const handoff = await pmi(alice, 'session', 'handoff', '--next', 'Wire the flag into checkout', '--json');
    expect(handoff.code, handoff.stderr).toBe(0);
    const sessionId = start.json.pmi.sessionId;
    const [pinned] = await db.query<{ pinned: boolean }>('SELECT pinned FROM work.snapshots WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1', [sessionId]);
    expect(pinned.pinned).toBe(true);

    const target = path.join(root, 'bob-session');
    const resume = await pmi(bob, 'session', 'resume', sessionId, '--agent', 'codex', '--worktree', target, '--json');
    expect(resume.code, resume.stderr + resume.stdout).toBe(0);
    expect(resume.json.snapshot.id).toMatch(/^snap_/);
    expect(resume.json.restore).toMatchObject({ verified: true, target });
    expect(fs.readFileSync(path.join(target, 'feature/flag.ts'), 'utf8')).toBe('export const enabled = true;\n');
    expect(fs.readFileSync(path.join(target, 'mixed.txt'), 'utf8')).toBe('mixed staged\nplus unstaged\n');
    const text = await pmi(bob, 'workspace', 'list');
    expect(text.stdout).toContain(resume.json.snapshot.id);
  }, 120_000);

  describe('server rules', () => {
    it('does not reveal blobs of other projects and refuses manifests with unknown blobs', async () => {
      const someSha = (await db.query<{ sha256: string }>('SELECT sha256 FROM work.project_blobs LIMIT 1'))[0].sha256;
      // Eve has no grant: the project does not exist for her.
      expect((await api(`/v1/projects/${projectId}/blobs/missing`, { as: 'eve', body: { sha256: [someSha] } })).status).toBe(404);
      expect((await api(`/v1/projects/${projectId}/blobs/${someSha}`, { as: 'eve' })).status).toBe(404);
      // A viewer may not read working-copy content.
      const viewerRead = await api(`/v1/projects/${projectId}/blobs/${someSha}`, { as: 'vera' });
      expect(viewerRead.status, JSON.stringify(viewerRead.body)).toBe(403);
      // Snapshot rows are invisible to viewers under RLS, so the id itself is unknown to them.
      expect((await api(`/v1/snapshots/${snapshotId}`, { as: 'vera' })).status).toBe(404);
      expect((await api(`/v1/projects/${projectId}/snapshots`, { as: 'vera' })).status).toBe(403);
    });

    it('rejects uploads whose body does not match the hash, and manifests that do not match theirs', async () => {
      const wrong = await api(`/v1/projects/${projectId}/blobs/${'a'.repeat(64)}`, { as: 'bob', method: 'PUT', raw: Buffer.from('not that') });
      expect(wrong).toMatchObject({ status: 422, body: { error: { code: 'blob_hash_mismatch' } } });
      const { body } = await api(`/v1/snapshots/${snapshotId}`, { as: 'bob' });
      const manifest = { ...body.snapshot.manifest, id: 'snap_forged', files: [...body.snapshot.manifest.files, { path: 'x', status: 'U', staged: false, sha256: 'b'.repeat(64) }] };
      const mismatch = await api(`/v1/projects/${projectId}/snapshots`, { as: 'bob', body: { device_id: 'dev_x', manifest, manifest_sha256: body.snapshot.manifestSha256 } });
      expect(mismatch.status).toBe(422);
      const { manifestSha256 } = await import('../../src/workspace-snapshot/snapshot.js');
      const missing = await api(`/v1/projects/${projectId}/snapshots`, { as: 'bob', body: { device_id: 'dev_x', manifest, manifest_sha256: manifestSha256(manifest) } });
      expect(missing).toMatchObject({ status: 412, body: { error: { code: 'blobs_missing', details: { missing: ['b'.repeat(64)] } } } });
    });

    it('retention keeps pinned and recent snapshots and collects unused blobs', async () => {
      const before = await db.query<{ id: string }>('SELECT id FROM work.snapshots');
      const storage = new ServerBlobStorage(blobDir);
      const none = await applyRetention(db, storage);
      expect(none).toEqual({ snapshots: 0, projectBlobs: 0, blobs: 0 });
      // Age every unpinned snapshot beyond the retention window.
      await db.query("UPDATE work.snapshots SET created_at = now() - interval '40 days' WHERE NOT pinned");
      await db.query("UPDATE work.project_blobs SET created_at = now() - interval '40 days'");
      await db.query("UPDATE work.blobs SET created_at = now() - interval '40 days'");
      const report = await applyRetention(db, storage);
      const after = await db.query<{ id: string; pinned: boolean }>('SELECT id, pinned FROM work.snapshots');
      expect(report.snapshots).toBeGreaterThan(0);
      expect(after.length).toBeLessThan(before.length);
      // Pinned (handoff) snapshots and the newest snapshot of the unfinished resumed session stay.
      expect(after.some((row) => row.pinned)).toBe(true);
      const [{ dangling }] = await db.query<{ dangling: number }>(
        `SELECT count(*)::int AS dangling FROM work.snapshot_blobs sb
          WHERE NOT EXISTS (SELECT 1 FROM work.blobs b WHERE b.sha256 = sb.sha256)`,
      );
      expect(dangling).toBe(0);
    });
  });
});

describe.skipIf(pgAvailable && cliBuilt)('workspace recovery end to end', () => {
  it.skip(`${pgSkipReason}; also requires \`npm run build\``, () => undefined);
});
