/**
 * CLI Command: baton ingest
 *
 * Parent command for Git→Memory ingestion.
 */

import { defineCommand } from 'citty';

export default defineCommand({
  meta: {
    name: 'ingest',
    description: 'Ingest engineering knowledge from Git',
  },
  subCommands: {
    commit: () => import('./ingest-commit.js').then((module) => module.default),
    log: () => import('./ingest-log.js').then((module) => module.default),
  },
  run: async ({ args }) => {
    const action = (args._ as string[])?.[0] || '';
    if (action === 'commit') {
      const module = await import('./ingest-commit.js');
      await module.default.run?.({ args: { ...args, _: [] }, rawArgs: [], cmd: module.default } as any);
      return;
    }
    if (action === 'log') {
      const module = await import('./ingest-log.js');
      await module.default.run?.({ args: { ...args, _: [] }, rawArgs: [], cmd: module.default } as any);
      return;
    }

    console.log('Baton Ingest Commands');
    console.log('');
    console.log('Usage:');
    console.log('  baton ingest commit [--ref HEAD]');
    console.log('  baton ingest log [--count 10]');
  },
});
