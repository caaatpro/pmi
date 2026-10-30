/**
 * Snapshot → restore round trip (TEST 3 at module level) and the protection
 * rules of WORKSPACE_RECOVERY.md §6/§10. Real git repositories: a bare
 * origin, developer A's clone with every kind of change, and developer B's
 * clean clone that receives the snapshot.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlobStore } from '../../src/workspace-snapshot/blob-store.js';
import { LocalSnapshots } from '../../src/workspace-snapshot/local.js';
import { RestoreRefused, restoreSnapshot } from '../../src/workspace-snapshot/restore.js';
import { manifestBlobs } from '../../src/workspace-snapshot/snapshot.js';
import { closeAllDatabases } from '../../src/store/sqlite-db.js';

let root = '';
let origin = '';
let a = '';
let b = '';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(repo: string, rel: string, content: string | Buffer, mode?: number): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  if (mode) fs.chmodSync(full, mode);
}

/** Every path git can see (tracked + untracked, not ignored) with type, mode and content. */
function workingCopy(repo: string): Record<string, string> {
  const listed = git(repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
  const out: Record<string, string> = {};
  for (const rel of [...new Set(listed)].sort()) {
    const full = path.join(repo, rel);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(full); } catch { out[rel] = '<absent>'; continue; }
    if (stat.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`;
    else out[rel] = `${stat.mode & 0o111 ? 'x' : '-'}:${fs.readFileSync(full).toString('base64')}`;
  }
  return out;
}

function setupRepos(): void {
  origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  a = path.join(root, 'alice');
  git(root, 'clone', '-q', origin, a);
  git(a, 'config', 'user.email', 'a@test.dev');
  git(a, 'config', 'user.name', 'A');
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'del.txt', 'old-name.txt', 'mixed.txt']) write(a, name, `${name} v1\n`);
  write(a, 'image.bin', randomBytes(4096));
  write(a, '.gitignore', 'build/\n');
  git(a, 'add', '.');
  git(a, 'commit', '-q', '-m', 'initial');
  git(a, 'push', '-q', 'origin', 'main');

  // One commit that is not pushed.
  write(a, 'c.txt', 'c.txt v2 (committed, not pushed)\n');
  git(a, 'commit', '-q', '-am', 'unpushed change');

  // Every kind of uncommitted change.
  write(a, 'a.txt', 'a.txt changed\n');
  write(a, 'b.txt', 'b.txt changed\n');
  write(a, 'c.txt', 'c.txt v3 (uncommitted)\n');
  fs.rmSync(path.join(a, 'del.txt'));
  git(a, 'mv', 'old-name.txt', 'new-name.txt');
  write(a, 'image.bin', randomBytes(4096));
  write(a, 'mixed.txt', 'mixed staged\n');
  git(a, 'add', 'mixed.txt');
  write(a, 'mixed.txt', 'mixed staged\nplus unstaged\n');
  write(a, 'tools/run.sh', '#!/bin/sh\necho run\n', 0o755);
  git(a, 'add', 'tools/run.sh');
  write(a, 'notes/untracked.md', '# notes\n');
  fs.symlinkSync('a.txt', path.join(a, 'link-to-a'));
  write(a, 'build/output.js', 'ignored\n');
  write(a, '.env', 'API_KEY=sk_live_abcdefghijklmnop1234\n');

  b = path.join(root, 'bob');
  git(root, 'clone', '-q', origin, b);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'pmi-snapshot-'));
  setupRepos();
});

afterEach(() => {
  closeAllDatabases();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('TEST 3: workspace snapshot round trip', () => {
  it('restores every change byte for byte in a clean clone on another machine', () => {
    const aliceSnapshots = new LocalSnapshots(path.join(root, 'alice-data'));
    const statusBefore = git(a, 'status', '--porcelain=v1');
    const { snapshot } = aliceSnapshots.take({ root: a, projectId: 'acme/shop', sessionId: 'ses_1' });
    expect(git(a, 'status', '--porcelain=v1')).toBe(statusBefore);

    const manifest = snapshot.manifest;
    expect(manifest.git.bundle?.commits).toHaveLength(1);
    expect(manifest.excluded).toEqual([{ path: '.env', reason: 'secret' }]);
    expect(manifest.files.map((f) => `${f.status} ${f.path}`)).toEqual([
      'M a.txt', 'M b.txt', 'M c.txt', 'D del.txt', 'M image.bin', 'U link-to-a', 'M mixed.txt',
      'R new-name.txt', 'U notes/untracked.md', 'A tools/run.sh',
    ]);
    const mixed = manifest.files.find((f) => f.path === 'mixed.txt')!;
    expect(mixed.staged).toBe(true);
    expect(mixed.index?.sha256).not.toBe(mixed.sha256);

    // Bob's machine has only the manifest and the blobs, nothing of Alice's repo.
    const bobBlobs = new BlobStore(path.join(root, 'bob-data'));
    for (const sha of manifestBlobs(manifest)) bobBlobs.putVerified(sha, aliceSnapshots.blobs.get(sha));
    const report = restoreSnapshot(manifest, {
      repoRoot: b,
      mode: 'worktree',
      expectedManifestSha256: snapshot.manifestSha256,
      getBlob: (sha) => bobBlobs.get(sha),
    });

    expect(report).toMatchObject({ verified: true, conflicts: [], mismatches: [], importedCommits: 1, branch: 'pmi/ses_1' });
    // Bob already has a local main, so the restore gets its own branch instead of moving his.
    const target = report.target;
    const expected = workingCopy(a);
    delete expected['.env'];
    expect(workingCopy(target)).toEqual(expected);
    expect(git(target, 'rev-parse', 'HEAD')).toBe(git(a, 'rev-parse', 'HEAD'));
    expect(git(target, 'status', '--porcelain=v1')).toBe(git(a, 'status', '--porcelain=v1').replace('?? .env\n', ''));
    expect(git(target, 'diff', '--cached', '--binary')).toBe(git(a, 'diff', '--cached', '--binary'));
    expect(git(target, 'diff', '--binary')).toBe(git(a, 'diff', '--binary'));
    expect(fs.existsSync(path.join(target, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'build/output.js'))).toBe(false);
    // Bob's own working copy was not touched.
    expect(git(b, 'status', '--porcelain=v1')).toBe('');
  });

  it('stores an unchanged working copy once and only new content after a one-file change', () => {
    const snaps = new LocalSnapshots(path.join(root, 'alice-data'));
    const first = snaps.take({ root: a, projectId: 'acme/shop', sessionId: 'ses_1' });
    const again = snaps.take({ root: a, projectId: 'acme/shop', sessionId: 'ses_1' });
    expect(again).toMatchObject({ reused: true, snapshot: { id: first.snapshot.id } });

    write(a, 'b.txt', 'b.txt changed again\n');
    const second = snaps.take({ root: a, projectId: 'acme/shop', sessionId: 'ses_1' });
    expect(second.reused).toBe(false);
    expect(second.snapshot.manifest.parent).toBe(first.snapshot.id);
    const before = new Set(manifestBlobs(first.snapshot.manifest));
    const fresh = manifestBlobs(second.snapshot.manifest).filter((sha) => !before.has(sha));
    // b.txt itself plus the worktree patch that mentions it.
    expect(fresh.length).toBe(2);
    expect(fresh).toContain(second.snapshot.manifest.files.find((f) => f.path === 'b.txt')!.sha256);
  });
});

describe('restore protections', () => {
  function snapshotAndBlobs() {
    const snaps = new LocalSnapshots(path.join(root, 'alice-data'));
    const { snapshot } = snaps.take({ root: a, projectId: 'acme/shop', sessionId: 'ses_1' });
    return { snaps, snapshot };
  }

  it('refuses a corrupted blob before touching the disk', () => {
    const { snaps, snapshot } = snapshotAndBlobs();
    const victim = snapshot.manifest.files.find((f) => f.path === 'a.txt')!.sha256!;
    const target = path.join(root, 'restore-target');
    expect(() => restoreSnapshot(snapshot.manifest, {
      repoRoot: b,
      mode: 'worktree',
      worktreePath: target,
      getBlob: (sha) => (sha === victim ? Buffer.from('tampered') : snaps.blobs.get(sha)),
    })).toThrow(RestoreRefused);
    expect(fs.existsSync(target)).toBe(false);
    expect(git(b, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('refuses in place on a dirty working copy and leaves it unchanged', () => {
    const { snaps, snapshot } = snapshotAndBlobs();
    write(b, 'a.txt', 'bob is editing\n');
    let error: unknown;
    try {
      restoreSnapshot(snapshot.manifest, { repoRoot: b, mode: 'in-place', getBlob: (sha) => snaps.blobs.get(sha) });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RestoreRefused);
    expect((error as RestoreRefused).code).toBe('dirty');
    expect(fs.readFileSync(path.join(b, 'a.txt'), 'utf8')).toBe('bob is editing\n');
  });

  it('refuses in place when HEAD differs from the snapshot', () => {
    const { snaps, snapshot } = snapshotAndBlobs();
    expect(() => restoreSnapshot(snapshot.manifest, { repoRoot: b, mode: 'in-place', getBlob: (sha) => snaps.blobs.get(sha) }))
      .toThrow(/restore into a new worktree/);
  });

  it('never overwrites a file that differs from the snapshot base: writes the snapshot version beside it', () => {
    const { snaps, snapshot } = snapshotAndBlobs();
    // Bob is at the snapshot HEAD with a clean copy, but an ignored local file sits where the snapshot adds one.
    restoreSnapshot(snapshot.manifest, { repoRoot: b, mode: 'worktree', worktreePath: path.join(root, 'scratch'), getBlob: (sha) => snaps.blobs.get(sha) });
    git(b, 'checkout', '-q', snapshot.manifest.git.head);
    write(b, '.git/info/exclude', 'notes/\n');
    write(b, 'notes/untracked.md', 'bob private notes\n');
    // A manifest whose base for a.txt is not what Bob has (another base with the same HEAD).
    const tampered = structuredClone(snapshot.manifest);
    tampered.files.find((f) => f.path === 'a.txt')!.baseBlob = 'f'.repeat(40);

    const report = restoreSnapshot(tampered, { repoRoot: b, mode: 'in-place', getBlob: (sha) => snaps.blobs.get(sha) });
    const suffix = `.pmi-${snapshot.manifest.id.slice(-8)}`;
    expect(report.conflicts.map((c) => [c.path, c.savedAs])).toEqual([
      ['a.txt', `a.txt${suffix}`],
      ['notes/untracked.md', `notes/untracked.md${suffix}`],
    ]);
    expect(fs.readFileSync(path.join(b, 'notes/untracked.md'), 'utf8')).toBe('bob private notes\n');
    expect(fs.readFileSync(path.join(b, 'a.txt'), 'utf8')).toBe('a.txt v1\n');
    expect(fs.readFileSync(path.join(b, `a.txt${suffix}`), 'utf8')).toBe('a.txt changed\n');
    expect(fs.readFileSync(path.join(b, 'b.txt'), 'utf8')).toBe('b.txt changed\n');
    expect(report.verified).toBe(false);
  });

  it('dry run checks everything and changes nothing', () => {
    const { snaps, snapshot } = snapshotAndBlobs();
    const target = path.join(root, 'dry');
    const report = restoreSnapshot(snapshot.manifest, { repoRoot: b, mode: 'worktree', worktreePath: target, dryRun: true, getBlob: (sha) => snaps.blobs.get(sha) });
    expect(report).toMatchObject({ dryRun: true, written: [], conflicts: [] });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('rejects manifests with paths that escape the working copy', () => {
    const { snaps, snapshot } = snapshotAndBlobs();
    const evil = structuredClone(snapshot.manifest);
    evil.files[0].path = '../outside.txt';
    expect(() => restoreSnapshot(evil, { repoRoot: b, mode: 'worktree', getBlob: (sha) => snaps.blobs.get(sha) })).toThrow(/unsafe path/);
    evil.files[0].path = '.git/hooks/post-checkout';
    expect(() => restoreSnapshot(evil, { repoRoot: b, mode: 'worktree', getBlob: (sha) => snaps.blobs.get(sha) })).toThrow(/unsafe path/);
  });

  it('includes secrets only when asked', () => {
    const snaps = new LocalSnapshots(path.join(root, 'alice-data'));
    const { snapshot } = snaps.take({ root: a, projectId: 'acme/shop', includeSecrets: true });
    expect(snapshot.manifest.excluded).toEqual([]);
    expect(snapshot.manifest.files.map((f) => f.path)).toContain('.env');
  });
});
