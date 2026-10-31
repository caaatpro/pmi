/**
 * Several processes (the CLI, the daemon, the MCP server) write checkpoints
 * into one local session store. A write transaction that starts as a reader
 * and upgrades to a writer gets SQLITE_BUSY at once when another process
 * committed in between (busy_timeout does not apply), so `baton session
 * checkpoint` failed with exit 1 next to a busy daemon. Write transactions
 * take the write lock up front instead.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cliBuilt, createRepoPair, machine, baton, stopDaemons, type Machine } from '../central/cli-helper.js';

describe.skipIf(!cliBuilt)('concurrent checkpoints from separate processes', () => {
  let root = '';
  let dev: Machine;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'baton-concurrent-checkpoint-'));
    const [repo] = createRepoPair(root, 'https://github.com/acme/race.git');
    // No daemon: the test itself supplies the concurrent writers.
    dev = machine(root, 'dev', repo, { BATON_DAEMON: 'off' });
  });

  afterAll(async () => {
    await stopDaemons([dev]);
    if (root) rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it('every process saves its checkpoint with its own sequence number', async () => {
    const start = await baton(dev, 'session', 'start', '--agent', 'claude-code', '--task', 'race', '--json');
    expect(start.code, start.stderr).toBe(0);
    const sessionId = start.json.baton.sessionId as string;

    const writers = 8;
    const results = await Promise.all(Array.from({ length: writers }, (_, i) =>
      baton(dev, 'session', 'checkpoint', '--sessionId', sessionId, '--done', `step ${i}`, '--json')));
    for (const result of results) expect(result.code, result.stderr || result.stdout).toBe(0);

    const seqs = results.map((result) => result.json.checkpoint.seq as number).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(writers);

    const show = await baton(dev, 'session', 'show', '--sessionId', sessionId, '--json');
    expect(show.code, show.stderr).toBe(0);
    expect(show.json.checkpoints).toHaveLength(writers);
  }, 120_000);
});
