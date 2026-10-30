/**
 * Reads the working copy for session state, without the agent's help
 * (SESSION_CONTINUITY.md §2: git.* is filled by the daemon).
 *
 * The fingerprint changes when HEAD moves, when the set of changed paths
 * changes, or when any changed file's size or mtime changes — cheap enough to
 * poll every few seconds, precise enough to avoid empty checkpoints.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { FileChange, GitState } from '../domain/session.js';

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-c', 'safe.directory=*', '-c', 'core.quotepath=off', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** Parse `git status --porcelain=v1 -z` output. */
export function parsePorcelain(output: string): FileChange[] {
  const entries = output.split('\0').filter(Boolean);
  const changes: FileChange[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (code === '??') {
      changes.push({ path: filePath, status: 'U' });
    } else if (code.includes('R') || code.includes('C')) {
      // In -z mode the original path follows as a separate entry.
      changes.push({ path: filePath, status: 'R', oldPath: entries[++index] });
    } else if (code.includes('D')) {
      changes.push({ path: filePath, status: 'D' });
    } else if (code.includes('A')) {
      changes.push({ path: filePath, status: 'A' });
    } else {
      changes.push({ path: filePath, status: 'M' });
    }
  }
  return changes;
}

export interface WorkspaceReading {
  git: GitState;
  fingerprint: string;
}

export function readWorkspace(root: string): WorkspaceReading | undefined {
  if (!fs.existsSync(root)) return undefined;
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status === undefined) return undefined;
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() || null;
  const branchRaw = git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])?.trim();
  const modifiedFiles = parsePorcelain(status);
  let unpushedCommits: string[] = [];
  if (head) {
    const upstream = git(root, ['rev-list', '--max-count=50', '@{upstream}..HEAD']);
    const unpushed = upstream ?? git(root, ['rev-list', '--max-count=50', 'HEAD', '--not', '--remotes']);
    unpushedCommits = (unpushed ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  }

  const hash = createHash('sha256').update(`${head ?? ''}\n${branchRaw ?? ''}\n`);
  for (const change of [...modifiedFiles].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${change.status} ${change.path}`);
    try {
      const stat = fs.statSync(path.join(root, change.path));
      hash.update(` ${stat.size} ${stat.mtimeMs}`);
    } catch {
      hash.update(' -');
    }
    hash.update('\n');
  }

  return {
    git: { branch: branchRaw || null, head, unpushedCommits, dirty: modifiedFiles.length > 0, modifiedFiles },
    fingerprint: hash.digest('hex'),
  };
}
