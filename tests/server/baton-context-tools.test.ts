/**
 * Baton context tools on the local MCP server (Local mode, no Baton server),
 * including acceptance TEST 6 locally: a project with 500 memories and 200
 * sessions — session start plus context_build stay within budget and carry no
 * session history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { countTextTokens } from '../../src/compact/token-budget.js';
import { createBatonServer } from '../../src/server.js';
import { resetResolvedConfigCache } from '../../src/config/resolved-config.js';
import { resetTomlConfigCache } from '../../src/config/toml-loader.js';
import { getObservation, storeObservation } from '../../src/memory/observations.js';
import { LocalSessionStore } from '../../src/session/local-store.js';
import { finishSession, startSession as startBatonSession } from '../../src/session/service.js';
import { resetDb } from '../../src/store/orama-store.js';
import { resetObservationStore } from '../../src/store/obs-store.js';
import { resetSessionStore } from '../../src/store/session-store.js';
import { closeAllDatabases } from '../../src/store/sqlite-db.js';
import type { ObservationType } from '../../src/types.js';

const originalDataDir = process.env.BATON_DATA_DIR;
let dataDir = '';
let projectDir = '';

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-ctx-data-'));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-ctx-project-'));
  execFileSync('git', ['init', '-q', '-b', 'main', projectDir]);
  execFileSync('git', ['-C', projectDir, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git']);
  await fs.writeFile(path.join(projectDir, 'README.md'), `# Shop\n${'The shop backend sells things. '.repeat(400)}\n`);
  await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { pg: '^8' } }, null, 2));
  execFileSync('git', ['-C', projectDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.']);
  execFileSync('git', ['-C', projectDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
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
  await fs.rm(projectDir, { recursive: true, force: true });
});

function handler(server: any, name: string): (args: Record<string, unknown>) => Promise<any> {
  const fn = server._registeredTools?.[name]?.handler;
  expect(fn, name).toBeTypeOf('function');
  return fn;
}

function text(result: any): string {
  return (result?.content ?? []).map((item: any) => item?.text ?? '').join('\n');
}

describe('Baton context tools (Local mode)', () => {
  it('baton_session_start injects coding conventions, which replaced mini-skills', async () => {
    const { server, projectId } = await createBatonServer(projectDir, undefined, undefined, { toolProfile: 'lite' } as any);
    await storeObservation({
      entityName: 'http-client',
      type: 'how-it-works',
      title: 'Always pass a timeout',
      narrative: 'Pass `timeout` to every fetch call.',
      facts: ['default 5s'],
      category: 'coding_convention',
      projectId,
    });
    await storeObservation({ entityName: 'demo', type: 'how-it-works', title: 'Sandbox demo convention', narrative: 'noise', category: 'coding_convention', projectId });
    await storeObservation({ entityName: 'cart', type: 'decision', title: 'Cart totals are server-side', narrative: 'Decision, not a convention.', projectId });

    const card = text(await handler(server, 'baton_session_start')({ agent: 'claude-code' }));
    expect(card).toContain('Project Coding Conventions (1 active)');
    expect(card).toContain('### Always pass a timeout');
    expect(card).toContain('- default 5s');
    expect(card).not.toContain('Sandbox demo convention');
    expect(card).not.toContain('Mini-Skills');
  });

  it('TEST 6 locally: 500 memories and 200 sessions stay within budget, without session history', async () => {
    const { server, projectId } = await createBatonServer(projectDir, undefined, undefined, { toolProfile: 'lite' } as any);
    const types: ObservationType[] = ['how-it-works', 'decision', 'problem-solution', 'gotcha', 'discovery', 'what-changed', 'session-request', 'trade-off'];
    for (let i = 0; i < 496; i++) {
      await storeObservation({
        entityName: ['catalog', 'cart', 'checkout', 'payments'][i % 4],
        type: types[i % types.length],
        title: `Topic ${i}: ${['catalog', 'cart', 'checkout', 'payments'][i % 4]} detail ${i}`,
        narrative: `Narrative about item ${i}. `.repeat(25),
        projectId,
        topicKey: `seed-${i}`,
      });
    }
    await storeObservation({ entityName: 'payments', type: 'decision', title: 'Refunds are ledger entries', narrative: 'Refunds are recorded as ledger entries, never negative payments.', projectId, filesModified: ['src/payments/refund.ts'] });
    await storeObservation({ entityName: 'payments', type: 'problem-solution', title: 'Rounding drift on partial refunds', narrative: 'Fixed with banker rounding on integer cents.', projectId, filesModified: ['src/payments/refund.ts'] });
    await storeObservation({ entityName: 'shop', type: 'how-it-works', title: 'Money is integer cents', narrative: 'Never floats for money.', projectId, category: 'coding_convention' });
    await storeObservation({ entityName: 'shop', type: 'session-request', title: 'Old session asked about refunds UI', narrative: 'Session note.', projectId });
    const sessions = new LocalSessionStore(dataDir);
    for (let i = 0; i < 200; i++) {
      const old = startBatonSession(sessions, { projectId, projectRoot: projectDir, agent: 'codex', task: `Old task ${i}` });
      finishSession(sessions, old.id, { summary: `done ${i}` });
    }

    const card = text(await handler(server, 'baton_session_start')({ agent: 'claude-code', task: 'Fix rounding of partial refunds' }));
    const result = await handler(server, 'context_build')({ task: 'fix rounding of partial refunds', files: ['src/payments/refund.ts'] });
    expect(result.isError, text(result)).toBeFalsy();
    const receipt = result.structuredContent.receipt;
    expect(receipt.source).toBe('local');
    expect(receipt.tokensTotal).toBeLessThanOrEqual(2_300);
    expect(countTextTokens(card)).toBeLessThan(2_300);
    const pkg = text(result);
    expect(pkg).toContain('Refunds are ledger entries');
    expect(pkg).toContain('Rounding drift on partial refunds');
    expect(pkg).toContain('Money is integer cents');
    expect(pkg).not.toContain('Old session asked about refunds UI');
    expect(pkg).not.toContain('Old task');
    expect(pkg).not.toContain('## History');
    // Reading the project instead (README, manifest, the task's files, git log) costs more.
    expect(receipt.estimatedSavings.baselineTokens).toBeGreaterThan(receipt.tokensTotal);
    expect(receipt.estimatedSavings.savings).toBeGreaterThan(0);
  }, 120_000);

  it('saves knowledge with a category, never as confirmed, and links decisions to the session', async () => {
    const { server } = await createBatonServer(projectDir, undefined, undefined, { toolProfile: 'lite' } as any);
    await handler(server, 'baton_session_start')({ agent: 'codex', task: 'Payments' });
    const saved = await handler(server, 'memory_save')({ title: 'Provider sandbox needs test cards', content: 'Use the documented test cards; real cards are declined.', category: 'known_limitation', confidence: 'observed' });
    expect(saved.isError, text(saved)).toBeFalsy();
    const id = saved.structuredContent.id as string;
    const stored = getObservation(Number(id.replace('obs:', '')));
    expect(stored).toMatchObject({ category: 'known_limitation', confidence: 'observed', type: 'gotcha' });

    // The input schema has no "confirmed"; storeObservation clamps anything else an agent sends.
    const { storeObservation: store } = await import('../../src/memory/observations.js');
    const forced = await store({ entityName: 'x', type: 'decision', title: 'Agent tries to confirm', narrative: 'n', projectId: stored!.projectId, confidence: 'confirmed' });
    expect(forced.observation.confidence).toBe('proposed');

    const logged = await handler(server, 'decision_log')({ title: 'Webhooks are idempotent by event id', decision: 'Store processed event ids and skip repeats.', alternatives: ['Rely on provider dedupe'], consequences: 'A table of processed events.' });
    expect(logged.isError, text(logged)).toBeFalsy();
    const decision = getObservation(Number((logged.structuredContent.id as string).replace('obs:', '')))!;
    expect(decision).toMatchObject({ category: 'architecture_decision', confidence: 'proposed' });
    expect(decision.narrative).toContain('Alternatives considered: Rely on provider dedupe');

    const sessions = new LocalSessionStore(dataDir);
    const live = sessions.list({ statuses: ['in_progress', 'checkpointed'] })[0];
    expect(live.state.decisions.map((ref) => ref.title)).toContain('Webhooks are idempotent by event id');
    expect(sessions.checkpoints(live.id).at(-1)?.trigger).toBe('decision');

    const search = await handler(server, 'memory_search')({ query: 'webhooks idempotent event' });
    expect(text(search)).toContain('Webhooks are idempotent by event id');
    const detail = await handler(server, 'memory_get')({ id: logged.structuredContent.id });
    expect(text(detail)).toContain('Store processed event ids');
    const list = await handler(server, 'decision_log')({ action: 'list' });
    expect(text(list)).toContain('Webhooks are idempotent by event id');
    const overview = await handler(server, 'project_overview')({});
    expect(overview.isError, text(overview)).toBeFalsy();
  }, 60_000);
});
