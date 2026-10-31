/**
 * Git hooks drive the incremental analysis: `pmi git-hook` installs the same
 * block into post-commit, post-merge and post-checkout, and a commit made in
 * the repository moves the analysis cursor by itself (real CLI, Local mode).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cliBuilt, git, installCliShims, machine, pmi, type Machine } from '../central/cli-helper.js';

let root = '';
let m: Machine;

describe.skipIf(!cliBuilt || process.platform === 'win32')('git hooks run pmi git analyze', () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'pmi-hooks-'));
    const repo = path.join(root, 'repo');
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 't@test.dev');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/hooks.git');
    writeFileSync(path.join(repo, 'a.ts'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial');
    const bin = installCliShims(root);
    m = machine(root, 'home', repo, { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, PMI_DAEMON: 'off' });
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('installs three hooks and a commit analyzes itself', async () => {
    const installed = await pmi(m, 'git-hook', '--force');
    expect(installed.code, installed.stderr).toBe(0);
    for (const name of ['post-commit', 'post-merge', 'post-checkout']) {
      const file = path.join(m.repo, '.git', 'hooks', name);
      expect(existsSync(file), name).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain('memorix git analyze --auto');
    }

    const before = await pmi(m, 'git', 'analyze', '--json');
    expect(before.json.commitsAnalyzed).toBe(1);

    writeFileSync(path.join(m.repo, 'b.ts'), 'b\n');
    git(m.repo, 'add', '-A');
    execGit(['commit', '-q', '-m', 'feat: b']);
    const head = git(m.repo, 'rev-parse', 'HEAD');
    // The hook runs in the background; wait until it has moved the cursor to the new commit.
    const deadline = Date.now() + 30_000;
    let report: any;
    for (;;) {
      report = (await pmi(m, 'git', 'analyze', '--json')).json;
      if (report.cursor.to === head && report.commitsAnalyzed === 0) break;
      if (Date.now() > deadline) throw new Error(`hook did not analyze the commit: ${JSON.stringify(report)}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(report.cursor.from).toBe(head);

    const removed = await pmi(m, 'git-hook-uninstall');
    expect(removed.code, removed.stderr).toBe(0);
    for (const name of ['post-commit', 'post-merge', 'post-checkout']) expect(existsSync(path.join(m.repo, '.git', 'hooks', name)), name).toBe(false);
  }, 120_000);
});

/** Commit with the machine's PATH so the hook finds the `memorix` shim. */
function execGit(args: string[]): void {
  execFileSync('git', args, { cwd: m.repo, env: { ...process.env, ...m.env }, stdio: 'pipe' });
}
