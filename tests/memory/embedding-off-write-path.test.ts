/**
 * Ordinary store must stay on the lexical path when embeddings are off.
 * generateEmbedding() used to run on every write and pulled config + provider
 * init into the hot path even for BATON_EMBEDDING=off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetConfigCache } from '../../src/config.js';
import { resetProvider } from '../../src/embedding/provider.js';
import {
  initObservations,
  resetObservationRuntime,
  storeObservation,
} from '../../src/memory/observations.js';
import { initObservationStore, resetObservationStore } from '../../src/store/obs-store.js';
import * as oramaStore from '../../src/store/orama-store.js';
import { closeAllDatabases } from '../../src/store/sqlite-db.js';

describe('embedding-off write path', () => {
  let sandbox = '';
  let previousEmbedding: string | undefined;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'baton-embed-off-write-'));
    previousEmbedding = process.env.BATON_EMBEDDING;
    process.env.BATON_EMBEDDING = 'off';
    resetConfigCache();
    resetProvider();
    resetObservationRuntime();
    await initObservationStore(path.join(sandbox, 'data'));
    await initObservations(path.join(sandbox, 'data'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetObservationStore();
    resetObservationRuntime();
    await oramaStore.resetDb();
    closeAllDatabases();
    resetProvider();
    if (previousEmbedding === undefined) delete process.env.BATON_EMBEDDING;
    else process.env.BATON_EMBEDDING = previousEmbedding;
    resetConfigCache();
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = '';
  });

  it('does not call generateEmbedding on ordinary store', async () => {
    const generate = vi.spyOn(oramaStore, 'generateEmbedding');
    await storeObservation({
      entityName: 'embed-off',
      type: 'discovery',
      title: 'Lexical write only',
      narrative: 'Embedding is disabled so the write path must not start a provider.',
      projectId: 'test/embed-off',
    });
    expect(generate).not.toHaveBeenCalled();
  });
});
