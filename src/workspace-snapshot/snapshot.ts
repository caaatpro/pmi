/**
 * Workspace snapshots (WORKSPACE_RECOVERY.md §2–§3): everything git sees in a
 * working copy that is not in the remote — changed, deleted, renamed and
 * untracked files with their full content, the staged (index) state, and a
 * bundle of unpushed commits — so another machine can rebuild it byte for
 * byte. Nothing in the working copy is modified while snapshotting.
 *
 * `git status --porcelain=v2` gives, per path, the blob id in HEAD (the
 * base used for conflict checks on restore) and the blob id in the index;
 * staged content is read from the index, so "staged + further unstaged
 * edits" in one file round-trips exactly.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { containsCredential } from '../memory/secret-filter.js';
import { BlobStore, sha256Hex } from './blob-store.js';

export type SnapshotFileStatus = 'A' | 'M' | 'D' | 'R' | 'U';

export interface SnapshotFile {
  path: string;
  status: SnapshotFileStatus;
  oldPath?: string;
  /** Working-tree mode: 100644, 100755 or 120000 (symlink). Absent for deletions. */
  mode?: string;
  sha256?: string;
  size?: number;
  /** Git blob id of the path in HEAD; the recipient's copy must still match it to be overwritten in place. */
  baseBlob?: string;
  /** Staged state differs from HEAD. */
  staged: boolean;
  /** Staged content (when staged and not a staged deletion). */
  index?: { mode: string; sha256: string };
  /** The path is removed from the index (staged deletion or the source of a staged rename). */
  indexDeleted?: boolean;
}

export interface SnapshotExcluded {
  path: string;
  reason: 'secret' | 'size' | 'submodule' | 'unreadable';
}

export interface SnapshotManifest {
  schema: 1;
  id: string;
  parent: string | null;
  projectId: string;
  sessionId: string | null;
  createdAt: string;
  createdBy: { device: string; user?: string | null };
  git: {
    head: string;
    branch: string | null;
    remoteBase: string | null;
    bundle: { sha256: string; commits: string[] } | null;
  };
  files: SnapshotFile[];
  patches: { worktree: string | null; index: string | null };
  excluded: SnapshotExcluded[];
  totals: { files: number; bytes: number };
}

export const MAX_FILE_BYTES_DEFAULT = 50 * 1024 * 1024;
const ZERO_OID = /^0+$/;
const SECRET_NAME = /(^|\/)(\.env(\..*)?|.*\.pem|id_rsa.*|id_ed25519.*|.*\.key|\.netrc|\.npmrc|credentials\.json)$/i;

function git(root: string, args: string[], input?: Buffer): Buffer {
  return execFileSync('git', ['-c', 'safe.directory=*', '-c', 'core.quotepath=off', ...args], {
    cwd: root,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 1024,
  });
}

function gitText(root: string, args: string[]): string {
  return git(root, args).toString('utf8');
}

function tryGitText(root: string, args: string[]): string | undefined {
  try {
    return gitText(root, args);
  } catch {
    return undefined;
  }
}

export function newSnapshotId(): string {
  return `snap_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
}

/** Canonical JSON (sorted keys) — the input of `manifest_sha256`. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function manifestSha256(manifest: SnapshotManifest): string {
  return sha256Hex(canonicalJson(manifest));
}

/** Every blob a manifest references (file and index contents, bundle, patches). */
export function manifestBlobs(manifest: SnapshotManifest): string[] {
  const shas = new Set<string>();
  for (const file of manifest.files) {
    if (file.sha256) shas.add(file.sha256);
    if (file.index) shas.add(file.index.sha256);
  }
  if (manifest.git.bundle) shas.add(manifest.git.bundle.sha256);
  if (manifest.patches.worktree) shas.add(manifest.patches.worktree);
  if (manifest.patches.index) shas.add(manifest.patches.index);
  return [...shas];
}

interface StatusEntry {
  kind: '1' | '2' | 'u' | '?';
  xy: string;
  sub: string;
  modeHead?: string;
  modeIndex?: string;
  modeWorktree?: string;
  hashHead?: string;
  hashIndex?: string;
  path: string;
  origPath?: string;
}

/** Parse `git status --porcelain=v2 -z --untracked-files=all`. */
export function parsePorcelainV2(output: string): StatusEntry[] {
  const records = output.split('\0');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const kind = record[0];
    if (kind === '?') {
      entries.push({ kind: '?', xy: '??', sub: 'N...', path: record.slice(2) });
    } else if (kind === '1') {
      const parts = record.split(' ');
      entries.push({ kind: '1', xy: parts[1], sub: parts[2], modeHead: parts[3], modeIndex: parts[4], modeWorktree: parts[5], hashHead: parts[6], hashIndex: parts[7], path: parts.slice(8).join(' ') });
    } else if (kind === '2') {
      const parts = record.split(' ');
      entries.push({ kind: '2', xy: parts[1], sub: parts[2], modeHead: parts[3], modeIndex: parts[4], modeWorktree: parts[5], hashHead: parts[6], hashIndex: parts[7], path: parts.slice(9).join(' '), origPath: records[++index] });
    } else if (kind === 'u') {
      const parts = record.split(' ');
      entries.push({ kind: 'u', xy: parts[1], sub: parts[2], path: parts.slice(10).join(' ') });
    }
  }
  return entries;
}

function readWorktreeEntry(root: string, relPath: string): { mode: string; content: Buffer } | undefined {
  const full = path.join(root, relPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink()) return { mode: '120000', content: Buffer.from(fs.readlinkSync(full), 'utf8') };
  if (!stat.isFile()) return undefined;
  return { mode: stat.mode & 0o111 ? '100755' : '100644', content: fs.readFileSync(full) };
}

function looksSecret(relPath: string, content: Buffer | undefined): boolean {
  if (SECRET_NAME.test(relPath)) return true;
  if (!content || content.length > 1024 * 1024 || content.includes(0)) return false;
  return containsCredential(content.toString('utf8'));
}

export interface BuildSnapshotInput {
  root: string;
  projectId: string;
  sessionId?: string | null;
  deviceId: string;
  parent?: string | null;
  includeSecrets?: boolean;
  maxFileBytes?: number;
}

export interface BuiltSnapshot {
  manifest: SnapshotManifest;
  manifestSha256: string;
  totalBytes: number;
}

export function buildSnapshot(store: BlobStore, input: BuildSnapshotInput): BuiltSnapshot {
  const root = input.root;
  const head = tryGitText(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim();
  if (!head) throw new Error('[baton] the repository has no commit yet; commit once before taking a workspace snapshot');
  const branch = tryGitText(root, ['symbolic-ref', '--short', '-q', 'HEAD'])?.trim() || null;
  const maxFileBytes = input.maxFileBytes ?? (Number(process.env.BATON_SNAPSHOT_MAX_FILE) || MAX_FILE_BYTES_DEFAULT);

  const files: SnapshotFile[] = [];
  const excluded: SnapshotExcluded[] = [];
  let bytes = 0;
  const putContent = (content: Buffer) => {
    bytes += content.length;
    return store.put(content);
  };

  for (const entry of parsePorcelainV2(gitText(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']))) {
    if (entry.sub.startsWith('S')) {
      excluded.push({ path: entry.path, reason: 'submodule' });
      continue;
    }
    if (entry.kind === 'u') {
      // Unmerged paths: keep the working-tree content (with conflict markers) so nothing is lost.
      const current = readWorktreeEntry(root, entry.path);
      if (current) files.push({ path: entry.path, status: 'M', mode: current.mode, sha256: putContent(current.content), size: current.content.length, staged: false });
      continue;
    }
    const x = entry.xy[0];
    const current = readWorktreeEntry(root, entry.path);
    if (current && current.content.length > maxFileBytes) {
      excluded.push({ path: entry.path, reason: 'size' });
      continue;
    }
    if (!input.includeSecrets && looksSecret(entry.path, current?.content)) {
      excluded.push({ path: entry.path, reason: 'secret' });
      continue;
    }

    const baseBlob = entry.hashHead && !ZERO_OID.test(entry.hashHead) ? entry.hashHead : undefined;
    let status: SnapshotFileStatus;
    if (entry.kind === '?') status = 'U';
    else if (!current) status = 'D';
    else if (entry.kind === '2') status = 'R';
    else if (x === 'A' || !baseBlob) status = 'A';
    else status = 'M';

    const file: SnapshotFile = { path: entry.path, status, staged: entry.kind !== '?' && x !== '.' };
    if (entry.origPath) file.oldPath = entry.origPath;
    if (baseBlob) file.baseBlob = baseBlob;
    if (current) {
      // Git's own view of the mode where it has one: on Windows (core.filemode
      // false) the file system cannot tell an executable or a symlink apart.
      file.mode = entry.modeWorktree && /^1(00644|00755|20000)$/.test(entry.modeWorktree) ? entry.modeWorktree : current.mode;
      file.sha256 = putContent(current.content);
      file.size = current.content.length;
    }
    if (file.staged) {
      if (x === 'D') {
        file.indexDeleted = true;
      } else if (entry.hashIndex && !ZERO_OID.test(entry.hashIndex)) {
        const indexContent = git(root, ['cat-file', 'blob', entry.hashIndex]);
        file.index = { mode: entry.modeIndex ?? '100644', sha256: putContent(indexContent) };
      }
    }
    files.push(file);
  }

  // Unpushed commits travel as a bundle; the recipient needs only what the remote has.
  const unpushed = (tryGitText(root, ['rev-list', 'HEAD', '--not', '--remotes']) ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  let bundle: SnapshotManifest['git']['bundle'] = null;
  let remoteBase: string | null = head;
  if (unpushed.length) {
    const tmp = path.join(os.tmpdir(), `baton-bundle-${randomBytes(6).toString('hex')}.bundle`);
    try {
      const hasRemotes = Boolean(tryGitText(root, ['for-each-ref', '--count=1', 'refs/remotes'])?.trim());
      git(root, ['bundle', 'create', '-q', tmp, 'HEAD', ...(hasRemotes ? ['--not', '--remotes'] : [])]);
      bundle = { sha256: putContent(fs.readFileSync(tmp)), commits: unpushed };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    remoteBase = tryGitText(root, ['rev-parse', '-q', '--verify', `${unpushed.at(-1)}^`])?.trim() || null;
  }

  // Human-readable patches, kept for review (`baton workspace show --patch`); restore uses the file contents.
  // Excluded paths (secrets, oversized files) must not leak through the patches either.
  const pathspec = ['--', '.', ...excluded.map((item) => `:(exclude,literal)${item.path}`)];
  const worktreePatch = git(root, ['diff', '--binary', 'HEAD', ...pathspec]);
  const indexPatch = git(root, ['diff', '--binary', '--cached', 'HEAD', ...pathspec]);

  const manifest: SnapshotManifest = {
    schema: 1,
    id: newSnapshotId(),
    parent: input.parent ?? null,
    projectId: input.projectId,
    sessionId: input.sessionId ?? null,
    createdAt: new Date().toISOString(),
    createdBy: { device: input.deviceId },
    git: { head, branch, remoteBase, bundle },
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    patches: {
      worktree: worktreePatch.length ? putContent(worktreePatch) : null,
      index: indexPatch.length ? putContent(indexPatch) : null,
    },
    excluded: excluded.sort((a, b) => a.path.localeCompare(b.path)),
    totals: { files: files.length, bytes },
  };
  return { manifest, manifestSha256: manifestSha256(manifest), totalBytes: bytes };
}

/** Whether a working copy has anything a snapshot would carry (changes or unpushed commits). */
export function workspaceHasState(root: string): boolean {
  const status = tryGitText(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status && status.trim()) return true;
  const unpushed = tryGitText(root, ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes']);
  return Boolean(unpushed?.trim());
}
