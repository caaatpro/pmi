/**
 * CLI Command: baton git-hook install
 *
 * Installs a git post-commit hook that automatically ingests commits as memories.
 * This is the Git→Memory automation — every commit becomes a searchable memory.
 *
 * Cross-platform: generates both bash (Unix) and PowerShell (Windows) hooks.
 */

import { defineCommand } from 'citty';
import * as p from '@clack/prompts';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { ensureHooksDir } from '../../git/hooks-path.js';

const HOOK_MARKER = '# [baton-git-hook]';

export default defineCommand({
  meta: {
    name: 'git-hook-install',
    description: 'Install git post-commit hook for automatic memory capture',
  },
  args: {
    cwd: {
      type: 'string',
      description: 'Project directory (default: current directory)',
      required: false,
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing hook without asking',
      required: false,
    },
  },
  run: async ({ args }) => {
    const projectDir = args.cwd || process.cwd();

    p.intro('Install Git post-commit hook');

    // 1. Resolve git hooks directory (handles normal repos and worktrees)
    const resolved = ensureHooksDir(projectDir);
    if (!resolved) {
      p.log.error(`No .git found in ${projectDir} (checked both directory and worktree file)`);
      p.outro('Run this command from a git repository root.');
      return;
    }

    const { hookPath } = resolved;

    // 3. Check for existing hook
    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, 'utf-8');

      if (existing.includes(HOOK_MARKER)) {
        p.log.warn('Baton git hook is already installed.');
        p.outro('Use `baton git-hook uninstall` to remove it first.');
        return;
      }

      // Existing non-baton hook — ask to append
      if (!args.force) {
        const action = await p.select({
          message: 'A post-commit hook already exists. What would you like to do?',
          options: [
            { value: 'append', label: 'Append', hint: 'Add baton hook after existing content' },
            { value: 'skip', label: 'Skip', hint: 'Do not modify the existing hook' },
          ],
        });

        if (p.isCancel(action) || action === 'skip') {
          p.outro('Installation cancelled.');
          return;
        }
      }

      // Append to existing hook
      const appended = existing.trimEnd() + '\n\n' + generateHookScript();
      writeFileSync(hookPath, appended, 'utf-8');
      try { chmodSync(hookPath, 0o755); } catch { /* Windows doesn't need chmod */ }

      p.log.success('Baton hook appended to existing post-commit hook.');
    } else {
      // Create new hook
      const script = '#!/bin/sh\n' + generateHookScript();
      writeFileSync(hookPath, script, 'utf-8');
      try { chmodSync(hookPath, 0o755); } catch { /* Windows doesn't need chmod */ }

      p.log.success('Git post-commit hook installed.');
    }

    // Pulls, merges and checkouts bring commits the post-commit hook never
    // saw; the same incremental analysis catches them up from the cursor.
    const { join, dirname } = await import('node:path');
    for (const name of ['post-merge', 'post-checkout']) {
      const extra = join(dirname(hookPath), name);
      if (existsSync(extra)) {
        const content = readFileSync(extra, 'utf-8');
        if (!content.includes(HOOK_MARKER)) writeFileSync(extra, content.trimEnd() + '\n\n' + generateHookScript(), 'utf-8');
      } else {
        writeFileSync(extra, '#!/bin/sh\n' + generateHookScript(), 'utf-8');
      }
      try { chmodSync(extra, 0o755); } catch { /* Windows doesn't need chmod */ }
    }

    p.log.info(`Hook path: ${hookPath} (+ post-merge, post-checkout)`);
    p.log.info('New commits are analyzed incrementally from the last analyzed commit (baton git analyze).');
    p.log.info('Memories are tagged with source="git" and include the commit hash.');
    p.outro('Done! Try making a commit to see it in action.');
  },
});

/**
 * Generate the hook script content: incremental analysis of cursor..HEAD,
 * in the background so commits, merges and checkouts are not slowed down.
 */
export function generateHookScript(): string {
  return `${HOOK_MARKER}
# Baton: analyze new commits incrementally (baton git analyze)
# Runs in background — does not block your git workflow.
# To remove: baton git-hook uninstall
if command -v baton >/dev/null 2>&1; then
  baton git analyze --auto >/dev/null 2>&1 &
fi
`;
}
