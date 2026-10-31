import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/embedding/provider.js', () => ({
  getEmbeddingProvider: async () => null,
  isVectorSearchAvailable: async () => false,
  isEmbeddingExplicitlyDisabled: () => true,
  resetProvider: () => {},
}));

vi.mock('../../src/llm/provider.js', () => ({
  initLLM: () => null,
  isLLMEnabled: () => false,
  getLLMConfig: () => null,
  setLLMConfig: () => {},
}));

vi.mock('../../src/config.js', () => ({
  getLLMApiKey: () => null,
  getLLMProvider: () => 'openai',
  getLLMModel: (fallback?: string) => fallback ?? 'gpt-4.1-nano',
  getLLMBaseUrl: (fallback?: string) => fallback ?? 'https://api.openai.com/v1',
}));

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemorixServer } from '../../src/server.js';
import { resetDb } from '../../src/store/orama-store.js';
import { resetObservationStore } from '../../src/store/obs-store.js';
import { closeAllDatabases } from '../../src/store/sqlite-db.js';
import { resetResolvedConfigCache } from '../../src/config/resolved-config.js';
import { resetTomlConfigCache } from '../../src/config/toml-loader.js';

function getHandler(server: any, name: string): (args: Record<string, unknown>) => Promise<any> {
  const handler = server._registeredTools?.[name]?.handler;
  expect(handler).toBeTypeOf('function');
  return handler;
}

function text(result: any): string {
  return (result?.content ?? [])
    .filter((item: any) => item?.type === 'text')
    .map((item: any) => item.text)
    .join('\n');
}

function agentId(result: any): string {
  const match = text(result).match(/Agent ID: (\S+)/);
  expect(match).toBeTruthy();
  return match![1];
}

describe('MCP observation visibility boundary', () => {
  it('keeps personal memories readable and writable only by their owner', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memorix-visibility-data-'));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memorix-visibility-project-'));
    const previousDataDir = process.env.MEMORIX_DATA_DIR;
    process.env.MEMORIX_DATA_DIR = dataDir;
    await fs.mkdir(path.join(projectDir, '.git'));
    resetTomlConfigCache();
    resetResolvedConfigCache();
    resetObservationStore();
    await resetDb();

    try {
      const first = await createMemorixServer(projectDir, undefined, undefined, { toolProfile: 'team' } as any);
      const second = await createMemorixServer(projectDir, undefined, undefined, { toolProfile: 'team' } as any);
      const third = await createMemorixServer(projectDir, undefined, undefined, { toolProfile: 'team' } as any);

      const startA = getHandler(first.server as any, 'memorix_session_start');
      const startB = getHandler(second.server as any, 'memorix_session_start');
      const startC = getHandler(third.server as any, 'memorix_session_start');
      const idA = agentId(await startA({ agent: 'visibility-a', agentType: 'codex', joinTeam: true }));
      agentId(await startB({ agent: 'visibility-b', agentType: 'claude-code', joinTeam: true }));
      agentId(await startC({ agent: 'visibility-c', agentType: 'windsurf', joinTeam: true }));

      const storeA = getHandler(first.server as any, 'memorix_store');
      const privateSessionMemory = await storeA({
        entityName: 'private-session',
        type: 'gotcha',
        title: 'Owner-only session context',
        narrative: 'This private observation must never be injected into another agent session.',
        visibility: 'personal',
      });
      expect(privateSessionMemory.isError).not.toBe(true);

      const foreignSession = text(await startC({
        agent: 'visibility-c',
        agentType: 'windsurf',
        joinTeam: true,
      }));
      expect(foreignSession).not.toContain('Owner-only session context');

      const ownerSession = text(await startA({
        agent: 'visibility-a',
        agentType: 'codex',
        joinTeam: true,
      }));
      expect(ownerSession).toContain('Owner-only session context');

      const searchB = getHandler(second.server as any, 'memorix_search');
      const searchC = getHandler(third.server as any, 'memorix_search');
      const personal = await storeA({
        entityName: 'private-topic',
        type: 'decision',
        title: 'Owner-only keyed decision',
        narrative: 'Only agent A may read or update this keyed personal memory.',
        topicKey: `personal:visibility:${idA}`,
        visibility: 'personal',
      });
      expect(personal.isError).not.toBe(true);
      expect(text(await searchB({ query: 'Owner-only keyed decision' }))).not.toContain('Owner-only keyed decision');
      expect(text(await searchC({ query: 'Owner-only keyed decision' }))).not.toContain('Owner-only keyed decision');

      // Another agent must not be able to mutate the owner's memory by
      // guessing its topic key.
      const overwrite = await getHandler(third.server as any, 'memorix_store')({
        entityName: 'private-topic',
        type: 'decision',
        title: 'Overwrite keyed decision',
        narrative: 'A third agent must not be able to mutate a personal memory by guessing its topic key.',
        topicKey: `personal:visibility:${idA}`,
      });
      expect(overwrite.isError).toBe(true);
      expect(text(overwrite)).toContain('write scope');
    } finally {
      if (previousDataDir === undefined) delete process.env.MEMORIX_DATA_DIR;
      else process.env.MEMORIX_DATA_DIR = previousDataDir;
      resetTomlConfigCache();
      resetResolvedConfigCache();
      resetObservationStore();
      await resetDb();
      closeAllDatabases();
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  }, 90_000);
});
