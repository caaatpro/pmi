import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const mockedOs = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => mockedOs.home;
  return {
    ...actual,
    homedir,
    default: { ...actual.default, homedir },
  };
});

import { createMemoryClient } from '../../src/sdk.js';
import { resetConfigCache } from '../../src/config.js';
import { resetProvider } from '../../src/embedding/provider.js';
import { resetObservationRuntime } from '../../src/memory/observations.js';
import { resetObservationStore } from '../../src/store/obs-store.js';
import { resetDb } from '../../src/store/orama-store.js';
import { closeAllDatabases } from '../../src/store/sqlite-db.js';

describe('SDK default data-directory contract', () => {
  const originalDataDir = process.env.BATON_DATA_DIR;
  const originalEmbedding = process.env.BATON_EMBEDDING;
  let sandbox = '';
  let client: Awaited<ReturnType<typeof createMemoryClient>> | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'baton-sdk-default-data-'));
    mockedOs.home = path.join(sandbox, 'home');
    delete process.env.BATON_DATA_DIR;
    process.env.BATON_EMBEDDING = 'off';
    resetConfigCache();
    resetProvider();

    const projectRoot = path.join(sandbox, 'project');
    execFileSync('git', ['init', '--quiet', projectRoot], { windowsHide: true });
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    resetObservationStore();
    resetObservationRuntime();
    await resetDb();
    closeAllDatabases();
    resetProvider();
    resetConfigCache();
    if (originalDataDir === undefined) delete process.env.BATON_DATA_DIR;
    else process.env.BATON_DATA_DIR = originalDataDir;
    if (originalEmbedding === undefined) delete process.env.BATON_EMBEDDING;
    else process.env.BATON_EMBEDDING = originalEmbedding;
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  it('uses the same flat default directory as CLI, hooks, and MCP', async () => {
    const projectRoot = path.join(sandbox, 'project');
    const expected = path.join(mockedOs.home, '.baton', 'data');

    client = await createMemoryClient({ projectRoot, silent: true });

    expect(client.dataDir).toBe(expected);
    expect(client.dataDir).not.toContain(`${path.sep}local${path.sep}`);
  });
});
