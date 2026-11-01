/**
 * Acceptance TEST 5 (Local mode): a repository with 5 new commits — a
 * dependency change, an API change, a deletion, a fix and a rename — is
 * analyzed incrementally. Exactly 5 commits are processed, the cursor moves,
 * memories appear per class, an inferred memory about the renamed file is
 * marked for review, a second run processes 0 commits, and git is only ever
 * asked about commits in cursor..HEAD.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyCommit, findStaleKnowledge, parseDependencyDiff } from '../../src/git/classify.js';
import { analyzeLocal, readLocalCursor, reconcileLocal } from '../../src/git/local-sink.js';
import { defaultGitRunner, type GitRunner } from '../../src/git/pipeline.js';
import { createBatonServer } from '../../src/server.js';
import { resetResolvedConfigCache } from '../../src/config/resolved-config.js';
import { resetTomlConfigCache } from '../../src/config/toml-loader.js';
import { getAllObservations, storeObservation } from '../../src/memory/observations.js';
import { resetDb } from '../../src/store/orama-store.js';
import { resetObservationStore } from '../../src/store/obs-store.js';
import { resetSessionStore } from '../../src/store/session-store.js';
import { closeAllDatabases } from '../../src/store/sqlite-db.js';

const originalDataDir = process.env.BATON_DATA_DIR;
let dataDir = '';
let repo = '';
const FUTURE = new Date(Date.now() + 3 * 86_400_000).toISOString();

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
}

async function write(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await fs.writeFile(path.join(repo, rel), content);
}

/** Commits dated after the seeded memories, so the staleness grace window does not apply. */
function commit(message: string): void {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: FUTURE, GIT_COMMITTER_DATE: FUTURE });
}

function recordingGit(calls: string[][]): GitRunner {
  const real = defaultGitRunner(repo);
  return (args) => {
    calls.push(args);
    return real(args);
  };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-git-data-'));
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-git-repo-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'dev@test.dev']);
  git(['config', 'user.name', 'Dev']);
  git(['remote', 'add', 'origin', 'https://github.com/acme/shop.git']);
  await write('package.json', JSON.stringify({ name: 'shop', version: '1.0.0', dependencies: { express: '^4.18.0' } }, null, 2) + '\n');
  await write('src/util.ts', 'export const round = (n: number) => Math.round(n);\n');
  await write('src/legacy.ts', 'export const legacy = true;\n');
  await write('src/cart.ts', 'export const cart = [];\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial']);
  process.env.BATON_DATA_DIR = dataDir;
  resetObservationStore();
  resetSessionStore();
  resetTomlConfigCache();
  resetResolvedConfigCache();
  await resetDb();
});

afterEach(async () => {
  closeAllDatabases();
  resetObservationStore();
  resetSessionStore();
  resetTomlConfigCache();
  resetResolvedConfigCache();
  await resetDb();
  if (originalDataDir === undefined) delete process.env.BATON_DATA_DIR;
  else process.env.BATON_DATA_DIR = originalDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(repo, { recursive: true, force: true });
});

describe('TEST 5: incremental git analysis (Local mode)', () => {
  it('analyzes exactly the new commits, classifies them, marks outdated knowledge, and is idempotent', async () => {
    const { projectId } = await createBatonServer(repo, undefined, undefined, { toolProfile: 'lite' } as any);
    const first = await analyzeLocal({ dataDir, projectId, root: repo });
    expect(first).toMatchObject({ commitsAnalyzed: 1, initial: true });
    const base = git(['rev-parse', 'HEAD']);
    expect(first.cursor.to).toBe(base);

    // Knowledge an agent wrote earlier about src/util.ts.
    const { observation: utilNote } = await storeObservation({
      entityName: 'util', type: 'how-it-works', title: 'Rounding helper lives in src/util.ts',
      narrative: 'round() is used for display only.', projectId, filesModified: ['src/util.ts'],
    });

    await write('package.json', JSON.stringify({ name: 'shop', version: '1.0.0', dependencies: { express: '^4.19.2', zod: '^3.24.0' } }, null, 2) + '\n');
    commit('chore: add zod and update express');
    await write('src/routes/orders.ts', 'export const listOrders = () => [];\n');
    commit('feat: orders endpoint');
    await fs.rm(path.join(repo, 'src/legacy.ts'));
    commit('refactor: drop legacy module');
    await write('src/cart.ts', 'export const cart: number[] = [];\n');
    commit('fix: handle empty cart (fixes #42)');
    git(['mv', 'src/util.ts', 'src/helpers.ts']);
    commit('refactor: rename util to helpers');
    const head = git(['rev-parse', 'HEAD']);
    const range = git(['rev-list', `${base}..${head}`]).split('\n');
    expect(range).toHaveLength(5);

    const calls: string[][] = [];
    const report = await analyzeLocal({ dataDir, projectId, root: repo, git: recordingGit(calls) });
    expect(report).toMatchObject({ commitsAnalyzed: 5, cursor: { from: base, to: head }, rewritten: false, initial: false, staleMarked: 1 });
    expect(report.classes).toMatchObject({ dependencies: 1, api: 1, removed: 1, fix: 1 });
    expect(readLocalCursor(dataDir, git(['rev-list', '--max-parents=0', 'HEAD']), 'main')).toBe(head);

    // Git was asked only about cursor..HEAD: no unbounded log or rev-list, every commit argument is in range or its parent.
    const allowed = new Set([...range, base, head]);
    for (const args of calls) {
      if (args[0] === 'log') expect(args.filter((arg) => /^[0-9a-f]{40}$/.test(arg)).every((sha) => range.includes(sha)), args.join(' ')).toBe(true);
      if (args[0] === 'rev-list') expect(args, args.join(' ')).toContain(`${base}..${head}`);
      for (const arg of args) if (/^[0-9a-f]{40}$/.test(arg)) expect(allowed.has(arg), args.join(' ')).toBe(true);
    }

    const memories = getAllObservations().filter((obs) => obs.projectId === projectId);
    const byTopic = (prefix: string) => memories.filter((obs) => obs.topicKey?.startsWith(prefix));
    expect(byTopic('git:')).toHaveLength(6);
    // The initial commit added express; the new one adds zod and updates express.
    const depChange = byTopic('git-dependencies:').find((obs) => obs.facts.includes('Added zod@^3.24.0'))!;
    expect(depChange).toMatchObject({ category: 'dependency', confidence: 'inferred', source: 'git' });
    expect(depChange.facts).toEqual(expect.arrayContaining(['Added zod@^3.24.0', 'Updated express ^4.18.0 -> ^4.19.2']));
    expect(byTopic('git-api:')[0]).toMatchObject({ category: 'architecture', filesModified: ['src/routes/orders.ts'] });
    expect(byTopic('git-removed:')[0].facts).toContain('Deleted src/legacy.ts');
    expect(byTopic('git-fix:')[0]).toMatchObject({ category: 'solution' });
    expect(byTopic('git-fix:')[0].facts).toContain('Fixes #42');
    const renameHistory = byTopic('git:').find((obs) => obs.title === 'refactor: rename util to helpers')!;
    expect(renameHistory.narrative).toContain('R src/util.ts -> src/helpers.ts');

    const note = memories.find((obs) => obs.id === utilNote.id)!;
    expect(note.review?.reason).toMatch(/all related files were deleted or moved/);
    expect(note.review?.commit).toBe(head);

    // Nothing new: nothing analyzed, and git is not asked for history.
    const again: string[][] = [];
    const second = await analyzeLocal({ dataDir, projectId, root: repo, git: recordingGit(again) });
    expect(second).toMatchObject({ commitsAnalyzed: 0, memoriesWritten: 0 });
    expect(again.some((args) => args[0] === 'log')).toBe(false);
    expect(again.some((args) => args.includes('--max-parents=0'))).toBe(false);
  }, 60_000);

  it('handles a rewritten history from the merge base, and a full reconcile finds deleted files', async () => {
    const { projectId } = await createBatonServer(repo, undefined, undefined, { toolProfile: 'lite' } as any);
    await write('src/a.ts', 'a\n');
    commit('feat: a');
    await analyzeLocal({ dataDir, projectId, root: repo });
    git(['reset', '-q', '--hard', 'HEAD~1']);
    await write('src/b.ts', 'b\n');
    commit('feat: b instead');
    const report = await analyzeLocal({ dataDir, projectId, root: repo });
    expect(report).toMatchObject({ rewritten: true, commitsAnalyzed: 1 });

    await storeObservation({ entityName: 'x', type: 'discovery', title: 'Notes on src/gone.ts', narrative: 'n', projectId, filesModified: ['src/gone.ts'] });
    const reconcile = await reconcileLocal({ dataDir, projectId, root: repo });
    expect(reconcile.marked).toBe(1);
    expect(getAllObservations().find((obs) => obs.title === 'Notes on src/gone.ts')?.review?.reason).toContain('no longer exist');
  }, 60_000);
});

describe('classifiers', () => {
  it('parses dependency changes across ecosystems', () => {
    expect(parseDependencyDiff([
      'diff --git a/package.json b/package.json', '--- a/package.json', '+++ b/package.json',
      '   "dependencies": {', '-    "express": "^4.18.0"', '+    "express": "^4.19.2",', '+    "zod": "^3.24.0"',
      'diff --git a/requirements.txt b/requirements.txt', '--- a/requirements.txt', '+++ b/requirements.txt', '-flask==2.0', '+fastapi==0.110',
    ].join('\n'))).toEqual({ added: ['zod@^3.24.0', 'fastapi@==0.110'], removed: ['flask@==2.0'], updated: [{ name: 'express', from: '^4.18.0', to: '^4.19.2' }] });
  });

  it('never marks confirmed knowledge directly and ignores fresh notes', () => {
    const commit = { sha: 'c'.repeat(40), parents: ['p'.repeat(40)], author: 'a', committedAt: '2026-10-31T00:00:00Z', subject: 'edit', body: '', changes: [{ path: 'src/x.ts', status: 'M' as const, additions: 1, deletions: 1 }] };
    const findings = findStaleKnowledge(commit, [
      { id: '1', category: 'architecture', confidence: 'confirmed', relatedFiles: ['src/x.ts'], updatedAt: '2026-01-01T00:00:00Z' },
      { id: '2', category: 'architecture', confidence: 'inferred', relatedFiles: ['src/x.ts'], updatedAt: '2026-10-30T23:00:00Z' },
      { id: '3', category: 'git_history', confidence: 'observed', relatedFiles: ['src/x.ts'], updatedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(findings).toEqual([expect.objectContaining({ id: '1', action: 'review_task' })]);
  });

  it('skips classifiers for merges and detects new top-level parts', () => {
    expect(classifyCommit({ sha: 'm', parents: ['a', 'b'], author: '', committedAt: '', subject: 'Merge', body: '', changes: [{ path: 'Dockerfile', status: 'M', additions: 1, deletions: 0 }] })).toEqual({ merge: true });
    expect(classifyCommit({ sha: 'x', parents: ['a'], author: '', committedAt: '', subject: 'feat: worker', body: '', newTopLevelDirs: ['worker'], changes: [{ path: 'worker/main.go', status: 'A', additions: 10, deletions: 0 }, { path: '.nvmrc', status: 'M', additions: 1, deletions: 1 }] }))
      .toMatchObject({ architecture: ['worker/'], constraints: ['.nvmrc'] });
  });
});
