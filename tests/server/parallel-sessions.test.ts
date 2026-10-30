import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemorixServer } from '../../src/server.js';
import { resetResolvedConfigCache } from '../../src/config/resolved-config.js';
import { resetTomlConfigCache } from '../../src/config/toml-loader.js';
import { getObservation } from '../../src/memory/observations.js';
import { resetDb } from '../../src/store/orama-store.js';
import { resetObservationStore } from '../../src/store/obs-store.js';
import { getSessionStore, resetSessionStore } from '../../src/store/session-store.js';
import { closeAllDatabases } from '../../src/store/sqlite-db.js';

const originalDataDir = process.env.MEMORIX_DATA_DIR;
let dataDir = '';
let projectDir = '';

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmi-parallel-data-'));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmi-parallel-project-'));
  await fs.mkdir(path.join(projectDir, '.git'));
  process.env.MEMORIX_DATA_DIR = dataDir;
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
  if (originalDataDir === undefined) delete process.env.MEMORIX_DATA_DIR;
  else process.env.MEMORIX_DATA_DIR = originalDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

function handler(server: any, name: string): (args: Record<string, unknown>) => Promise<any> {
  const fn = server._registeredTools?.[name]?.handler;
  expect(fn).toBeTypeOf('function');
  return fn;
}

function text(result: any): string {
  return (result?.content ?? []).map((item: any) => item?.text ?? '').join('\n');
}

describe('parallel agent sessions in one project', () => {
  it('keeps both sessions active and attributes memory to the connection that opened the session', async () => {
    const claude = await createMemorixServer(projectDir, undefined, undefined, { toolProfile: 'lite' } as any);
    const codex = await createMemorixServer(projectDir, undefined, undefined, { toolProfile: 'lite' } as any);
    expect(codex.projectId).toBe(claude.projectId);

    const claudeStart = text(await handler(claude.server, 'memorix_session_start')({ agent: 'claude-code' }));
    const claudeSessionId = claudeStart.match(/Session started: (\S+)/)?.[1];
    const codexStart = text(await handler(codex.server, 'memorix_session_start')({ agent: 'codex' }));
    const codexSessionId = codexStart.match(/Session started: (\S+)/)?.[1];
    expect(claudeSessionId).toBeTruthy();
    expect(codexSessionId).toBeTruthy();

    const active = await getSessionStore().loadActive(claude.projectId);
    expect(active.map((session) => session.id).sort()).toEqual([claudeSessionId, codexSessionId].sort());

    // Codex started last, so "most recent active session" would be wrong here.
    const stored = text(await handler(claude.server, 'memorix_store')({
      entityName: 'session-routing',
      type: 'decision',
      title: 'Claude keeps its own session attribution',
      narrative: 'Observations written through one MCP connection belong to the session that connection opened.',
    }));
    const observationId = Number(stored.match(/observation #(\d+)/)?.[1]);
    expect(observationId).toBeGreaterThan(0);
    expect(getObservation(observationId)?.sessionId).toBe(claudeSessionId);
  }, 30_000);
});
