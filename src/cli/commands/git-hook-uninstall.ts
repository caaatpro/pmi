/**
 * CLI Command: baton git-hook uninstall
 *
 * Removes the baton post-commit hook from the git repository.
 * If the hook file contains other content, only the baton section is removed.
 */

import { defineCommand } from 'citty';
import * as p from '@clack/prompts';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolveHooksDir } from '../../git/hooks-path.js';

const HOOK_MARKER = '# [baton-git-hook]';

export default defineCommand({
  meta: {
    name: 'git-hook-uninstall',
    description: 'Remove baton git post-commit hook',
  },
  args: {
    cwd: {
      type: 'string',
      description: 'Project directory (default: current directory)',
      required: false,
    },
  },
  run: async ({ args }) => {
    const projectDir = args.cwd || process.cwd();

    p.intro('Uninstall Git post-commit hook');

    const resolved = resolveHooksDir(projectDir);
    if (!resolved) {
      p.log.warn('No .git found (checked both directory and worktree file).');
      p.outro('Nothing to uninstall.');
      return;
    }
    const { hookPath } = resolved;

    if (!existsSync(hookPath)) {
      p.log.warn('No post-commit hook found.');
      p.outro('Nothing to uninstall.');
      return;
    }

    const content = readFileSync(hookPath, 'utf-8');

    if (!content.includes(HOOK_MARKER)) {
      p.log.warn('Post-commit hook exists but does not contain baton hook.');
      p.outro('Nothing to uninstall.');
      return;
    }

    // Remove the baton section (from marker to next blank line or EOF)
    const lines = content.split('\n');
    const filtered: string[] = [];
    let inBatonBlock = false;

    for (const line of lines) {
      if (line.includes(HOOK_MARKER)) {
        inBatonBlock = true;
        continue;
      }
      if (inBatonBlock) {
        // End of baton block: empty line or next shebang/marker
        if (line.trim() === '' || line.startsWith('#!') || line.startsWith('# [')) {
          if (line.trim() !== '') filtered.push(line);
          inBatonBlock = false;
        }
        continue;
      }
      filtered.push(line);
    }

    const remaining = filtered.join('\n').trim();

    if (!remaining || remaining === '#!/bin/sh') {
      // Hook file only contained baton content — delete it
      unlinkSync(hookPath);
      p.log.success('Git post-commit hook removed.');
    } else {
      // Other hook content remains — keep it
      writeFileSync(hookPath, remaining + '\n', 'utf-8');
      p.log.success('Baton section removed from post-commit hook.');
      p.log.info('Other hook content was preserved.');
    }

    // The installer also added the same block to post-merge and post-checkout.
    const { join, dirname } = await import('node:path');
    for (const name of ['post-merge', 'post-checkout']) {
      const extra = join(dirname(hookPath), name);
      if (!existsSync(extra)) continue;
      const kept = removeMarkedBlock(readFileSync(extra, 'utf-8'));
      if (!kept || kept === '#!/bin/sh') unlinkSync(extra);
      else writeFileSync(extra, kept + '\n', 'utf-8');
    }

    p.outro('Done.');
  },
});

function removeMarkedBlock(content: string): string {
  const filtered: string[] = [];
  let inBlock = false;
  for (const line of content.split('\n')) {
    if (line.includes(HOOK_MARKER)) { inBlock = true; continue; }
    if (inBlock) {
      if (line.trim() === '' || line.startsWith('#!') || line.startsWith('# [')) {
        if (line.trim() !== '') filtered.push(line);
        inBlock = false;
      }
      continue;
    }
    filtered.push(line);
  }
  return filtered.join('\n').trim();
}
