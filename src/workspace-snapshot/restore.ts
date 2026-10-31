/**
 * Restore a workspace snapshot (WORKSPACE_RECOVERY.md §5–§6).
 *
 * Order guarantees no partial damage: every blob is fetched and verified
 * before the disk is touched; the base commit (plus unpushed commits from the
 * bundle) must be present; only then files are written. The default target
 * is a new git worktree, which cannot collide with anyone's work. In place
 * is allowed only on a clean working copy at the snapshot's HEAD, and even
 * then a file that differs from the snapshot's base is never overwritten:
 * the snapshot version is written next to it as `<file>.pmi-<snapshot>`.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sha256Hex } from './blob-store.js';
import { manifestBlobs, manifestSha256, type SnapshotFile, type SnapshotManifest } from './snapshot.js';

export class RestoreRefused extends Error {
  constructor(readonly code: 'blob' | 'manifest' | 'base_missing' | 'dirty' | 'head_mismatch' | 'target_exists' | 'unsafe_path', message: string) {
    super(message);
  }
}

export interface RestoreOptions {
  /** Any working copy of the repository on this machine. */
  repoRoot: string;
  mode: 'worktree' | 'in-place';
  worktreePath?: string;
  /** Branch for the new worktree; defaults to the snapshot's branch, or pmi/<session> when that exists. */
  branchName?: string;
  dryRun?: boolean;
  expectedManifestSha256?: string;
  /** Returns verified content for a blob id (throws if missing or corrupted). */
  getBlob: (sha: string) => Buffer;
}

export interface RestoreReport {
  snapshotId: string;
  target: string;
  branch: string | null;
  mode: 'worktree' | 'in-place';
  dryRun: boolean;
  written: string[];
  deleted: string[];
  conflicts: Array<{ path: string; savedAs: string | null; reason: string }>;
  excluded: SnapshotManifest['excluded'];
  importedCommits: number;
  verified: boolean;
  mismatches: string[];
}

function git(cwd: string, args: string[], input?: Buffer): Buffer {
  return execFileSync('git', ['-c', 'safe.directory=*', '-c', 'core.quotepath=off', ...args], {
    cwd,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 1024,
  });
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/** Paths come from a manifest made elsewhere: refuse anything that could escape the target. */
function safeJoin(root: string, relPath: string): string {
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]/).some((part) => part === '..' || part === '.git')) {
    throw new RestoreRefused('unsafe_path', `refusing unsafe path in manifest: ${relPath}`);
  }
  const full = path.resolve(root, relPath);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new RestoreRefused('unsafe_path', `refusing path outside the working copy: ${relPath}`);
  return full;
}

/**
 * Refuse to go through a symlink inside the target: an entry "dir" -> /etc
 * followed by "dir/passwd" would otherwise write outside the working copy.
 */
function assertNoSymlinkParents(root: string, relPath: string): void {
  const parts = relPath.split(/[\\/]/).slice(0, -1);
  let current = path.resolve(root);
  for (const part of parts) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return; // the rest does not exist yet and will be created as directories
    }
    if (stat.isSymbolicLink()) throw new RestoreRefused('unsafe_path', `refusing to write through the symlink ${path.relative(root, current)}`);
  }
}

const ALLOWED_MODES = new Set(['100644', '100755', '120000']);

/** Manifest-level checks that need no disk access: modes, and no entry below a symlink entry. */
function validateManifestPaths(root: string, manifest: SnapshotManifest): void {
  const symlinks = new Set<string>();
  for (const file of manifest.files) {
    safeJoin(root, file.path);
    if (file.oldPath) safeJoin(root, file.oldPath);
    if (file.mode !== undefined && !ALLOWED_MODES.has(file.mode)) throw new RestoreRefused('unsafe_path', `unsupported file mode ${file.mode} for ${file.path}`);
    if (file.index && !ALLOWED_MODES.has(file.index.mode)) throw new RestoreRefused('unsafe_path', `unsupported index mode ${file.index.mode} for ${file.path}`);
    if (file.mode === '120000') symlinks.add(file.path);
  }
  for (const file of manifest.files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (symlinks.has(parts.slice(0, i).join('/'))) throw new RestoreRefused('unsafe_path', `${file.path} lies below the symlink ${parts.slice(0, i).join('/')}`);
    }
  }
}

/** Git blob id of what is at `relPath` now, or null when nothing is there. */
function currentBlobId(root: string, relPath: string): string | null {
  const full = safeJoin(root, relPath);
  assertNoSymlinkParents(root, relPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return null;
  }
  const content = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full), 'utf8') : fs.readFileSync(full);
  return gitBlobId(root, relPath, content);
}

function writeEntry(root: string, relPath: string, mode: string, content: Buffer): void {
  const full = safeJoin(root, relPath);
  assertNoSymlinkParents(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  try {
    if (fs.lstatSync(full).isDirectory()) throw new RestoreRefused('target_exists', `${relPath} is a directory`);
    fs.rmSync(full, { force: true });
  } catch (error) {
    if (error instanceof RestoreRefused) throw error;
  }
  if (mode === '120000') {
    fs.symlinkSync(content.toString('utf8'), full);
    return;
  }
  const tmp = `${full}.pmi-tmp-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode: mode === '100755' ? 0o755 : 0o644 });
  fs.renameSync(tmp, full);
  fs.chmodSync(full, mode === '100755' ? 0o755 : 0o644);
}

function readEntry(root: string, relPath: string): Buffer | null {
  const full = safeJoin(root, relPath);
  assertNoSymlinkParents(root, relPath);
  try {
    const stat = fs.lstatSync(full);
    return stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full), 'utf8') : fs.readFileSync(full);
  } catch {
    return null;
  }
}

/** Make the snapshot's HEAD (and any unpushed commits from its bundle) available in the repository. */
function ensureBase(repoRoot: string, manifest: SnapshotManifest, getBlob: (sha: string) => Buffer, dryRun: boolean): number {
  const hasHead = () => gitOk(repoRoot, ['cat-file', '-e', `${manifest.git.head}^{commit}`]);
  if (hasHead()) return 0;
  if (!manifest.git.bundle) {
    gitOk(repoRoot, ['fetch', '--all', '-q']);
    if (hasHead()) return 0;
    throw new RestoreRefused('base_missing', `commit ${manifest.git.head.slice(0, 12)} is not available here or in the remotes; push it or snapshot with the bundle`);
  }
  const tmp = path.join(os.tmpdir(), `pmi-restore-${randomBytes(6).toString('hex')}.bundle`);
  try {
    fs.writeFileSync(tmp, getBlob(manifest.git.bundle.sha256));
    if (!gitOk(repoRoot, ['bundle', 'verify', '-q', tmp])) {
      // The bundle needs the remote history it was cut from.
      gitOk(repoRoot, ['fetch', '--all', '-q']);
      if (!gitOk(repoRoot, ['bundle', 'verify', '-q', tmp])) {
        throw new RestoreRefused('base_missing', 'the unpushed commits need history this repository does not have; fetch from the remote first');
      }
    }
    if (dryRun) return manifest.git.bundle.commits.length;
    git(repoRoot, ['fetch', '-q', tmp, `HEAD:refs/pmi/snapshots/${manifest.id}`]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  if (!hasHead()) throw new RestoreRefused('base_missing', 'the bundle did not contain the snapshot HEAD');
  return manifest.git.bundle.commits.length;
}

function chooseBranch(repoRoot: string, manifest: SnapshotManifest, requested?: string): string {
  const exists = (name: string) => gitOk(repoRoot, ['show-ref', '--verify', '-q', `refs/heads/${name}`]);
  if (requested) {
    if (exists(requested)) throw new RestoreRefused('target_exists', `branch ${requested} already exists`);
    return requested;
  }
  if (manifest.git.branch && !exists(manifest.git.branch)) return manifest.git.branch;
  const base = `pmi/${(manifest.sessionId ?? manifest.id).replace(/[^A-Za-z0-9._-]/g, '-')}`;
  let name = base;
  for (let n = 2; exists(name); n++) name = `${base}-${n}`;
  return name;
}

function conflictReason(root: string, file: SnapshotFile, snapshotContent: Buffer | null): string | null {
  const current = currentBlobId(root, file.path);
  if (file.status === 'M' || file.status === 'D') {
    if (current === (file.baseBlob ?? null)) return null;
    if (current && snapshotContent && current === gitBlobId(root, file.path, snapshotContent)) return null;
    return current ? 'the file changed here since the snapshot base' : 'the file was deleted here';
  }
  // A, U, R (new path): must not exist yet, unless it already holds the snapshot content.
  if (current === null) return null;
  if (snapshotContent && current === gitBlobId(root, file.path, snapshotContent)) return null;
  return 'a different file already exists at this path';
}

/**
 * Blob id as git would store `content` at `relPath`: with the path, git
 * applies the same clean filters (core.autocrlf, .gitattributes) it uses for
 * `git add`, so a CRLF checkout of an unchanged file still matches its base.
 */
function gitBlobId(root: string, relPath: string, content: Buffer): string {
  return git(root, ['hash-object', '--path', relPath, '--stdin'], content).toString('utf8').trim();
}

export function restoreSnapshot(manifest: SnapshotManifest, options: RestoreOptions): RestoreReport {
  if (manifest.schema !== 1) throw new RestoreRefused('manifest', `unsupported manifest schema ${manifest.schema}`);
  if (options.expectedManifestSha256 && manifestSha256(manifest) !== options.expectedManifestSha256) {
    throw new RestoreRefused('manifest', 'the manifest does not match its recorded SHA-256');
  }
  validateManifestPaths(options.repoRoot, manifest);

  // 1. Every blob verified before anything on disk changes.
  const blobs = new Map<string, Buffer>();
  for (const sha of manifestBlobs(manifest)) {
    try {
      const content = options.getBlob(sha);
      if (sha256Hex(content) !== sha) throw new Error('hash mismatch');
      blobs.set(sha, content);
    } catch (error) {
      throw new RestoreRefused('blob', `blob ${sha.slice(0, 12)} is missing or corrupted (${(error as Error).message}); nothing was changed`);
    }
  }

  // 2. Base commit and unpushed commits.
  const importedCommits = ensureBase(options.repoRoot, manifest, (sha) => blobs.get(sha)!, Boolean(options.dryRun));

  // 3. Target working copy.
  let target: string;
  let branch: string | null = null;
  if (options.mode === 'in-place') {
    target = git(options.repoRoot, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
    if (git(target, ['status', '--porcelain=v1', '--untracked-files=all']).toString('utf8').trim()) {
      throw new RestoreRefused('dirty', 'the working copy has uncommitted changes; restore into a new worktree instead (default)');
    }
    const head = git(target, ['rev-parse', 'HEAD']).toString('utf8').trim();
    if (head !== manifest.git.head) {
      throw new RestoreRefused('head_mismatch', `the working copy is at ${head.slice(0, 12)}, the snapshot at ${manifest.git.head.slice(0, 12)}; restore into a new worktree instead`);
    }
    try {
      branch = git(target, ['symbolic-ref', '--short', '-q', 'HEAD']).toString('utf8').trim() || null;
    } catch {
      branch = null; // detached HEAD
    }
  } else {
    const repoTop = git(options.repoRoot, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
    target = path.resolve(options.worktreePath ?? `${repoTop}-pmi-${manifest.id.slice(-8)}`);
    if (fs.existsSync(target)) throw new RestoreRefused('target_exists', `${target} already exists; pass --worktree <new path>`);
    branch = chooseBranch(options.repoRoot, manifest, options.branchName);
    if (!options.dryRun) git(options.repoRoot, ['worktree', 'add', '-q', '-b', branch, target, manifest.git.head]);
  }

  const report: RestoreReport = {
    snapshotId: manifest.id, target, branch, mode: options.mode, dryRun: Boolean(options.dryRun),
    written: [], deleted: [], conflicts: [], excluded: manifest.excluded, importedCommits, verified: false, mismatches: [],
  };
  const checkRoot = options.mode === 'worktree' && options.dryRun ? null : target;

  // 4. Files, each checked against the base before it is touched.
  const conflicted = new Set<string>();
  for (const file of manifest.files) {
    const content = file.sha256 ? blobs.get(file.sha256)! : null;
    const reason = checkRoot ? conflictReason(checkRoot, file, content) : null;
    const oldReason = checkRoot && file.status === 'R' && file.oldPath
      ? conflictReason(checkRoot, { path: file.oldPath, status: 'D', staged: false, baseBlob: file.baseBlob }, null)
      : null;
    if (reason || oldReason) {
      conflicted.add(file.path);
      let savedAs: string | null = null;
      if (content && !options.dryRun) {
        savedAs = `${file.path}.pmi-${manifest.id.slice(-8)}`;
        writeEntry(target, savedAs, file.mode ?? '100644', content);
      }
      report.conflicts.push({ path: file.path, savedAs, reason: reason ?? `rename source ${file.oldPath}: ${oldReason}` });
      continue;
    }
    if (options.dryRun) continue;
    if (file.status === 'D') {
      assertNoSymlinkParents(target, file.path);
      fs.rmSync(safeJoin(target, file.path), { force: true });
      report.deleted.push(file.path);
      continue;
    }
    if (file.status === 'R' && file.oldPath) {
      assertNoSymlinkParents(target, file.oldPath);
      fs.rmSync(safeJoin(target, file.oldPath), { force: true });
      report.deleted.push(file.oldPath);
    }
    if (content) {
      writeEntry(target, file.path, file.mode ?? '100644', content);
      report.written.push(file.path);
    }
  }

  // 5. Index (staged state), exactly as it was.
  if (!options.dryRun) {
    for (const file of manifest.files) {
      if (!file.staged || conflicted.has(file.path)) continue;
      if (file.status === 'R' && file.oldPath) git(target, ['update-index', '--force-remove', '--', file.oldPath]);
      if (file.indexDeleted) {
        git(target, ['update-index', '--force-remove', '--', file.path]);
      } else if (file.index) {
        const oid = git(target, ['hash-object', '-w', '--stdin'], blobs.get(file.index.sha256)!).toString('utf8').trim();
        git(target, ['update-index', '--add', '--cacheinfo', `${file.index.mode},${oid},${file.path}`]);
      }
    }
  }

  // 6. Verification: every restored file must hash to the manifest.
  if (!options.dryRun) {
    for (const file of manifest.files) {
      if (conflicted.has(file.path)) continue;
      const onDisk = readEntry(target, file.path);
      if (file.status === 'D') {
        if (onDisk !== null) report.mismatches.push(file.path);
      } else if (!onDisk || sha256Hex(onDisk) !== file.sha256) {
        report.mismatches.push(file.path);
      }
    }
  }
  report.verified = !options.dryRun && report.mismatches.length === 0 && report.conflicts.length === 0;
  return report;
}
