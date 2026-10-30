/**
 * A shared fixture for workspace recovery tests: a bare origin, developer A's
 * clone with every kind of change WORKSPACE_RECOVERY.md §10 lists, and helpers
 * to compare two working copies byte for byte.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function write(repo: string, rel: string, content: string | Buffer, mode?: number): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  if (mode) fs.chmodSync(full, mode);
}

/** Every path git can see (tracked + untracked, not ignored) with type, mode and content. */
export function workingCopy(repo: string): Record<string, string> {
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

/**
 * origin (bare) ← A (pushed history + 1 unpushed commit + every kind of
 * uncommitted change) and B (a clean clone). Returns their paths.
 */
export function createWorkspaceFixture(root: string, configure?: (repo: string) => void): { origin: string; a: string; b: string } {
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const a = path.join(root, 'alice');
  git(root, 'clone', '-q', origin, a);
  git(a, 'config', 'user.email', 'a@test.dev');
  git(a, 'config', 'user.name', 'A');
  configure?.(a);
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

  const b = path.join(root, 'bob');
  git(root, 'clone', '-q', origin, b);
  return { origin, a, b };
}
