/**
 * Compact Engine Tests
 *
 * Tests the 3-layer Progressive Disclosure workflow.
 * Based on claude-mem's proven architecture.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/embedding/provider.js', () => ({
  getEmbeddingProvider: async () => null,
  getEmbeddingRuntimeHealth: () => ({ status: 'disabled' }),
  isVectorSearchAvailable: async () => false,
  isEmbeddingExplicitlyDisabled: () => true,
  resetProvider: () => {},
}));
import { compactSearch, compactDetail } from '../../src/compact/engine.js';
import { storeObservation, initObservations } from '../../src/memory/observations.js';
import { resetDb } from '../../src/store/orama-store.js';
import { initAliasRegistry, registerAlias, resetAliasCache } from '../../src/project/aliases.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-compact-'));
  await resetDb();
  resetAliasCache();
  initAliasRegistry(testDir);
  await initObservations(testDir);
});

describe('Compact Engine', () => {
  describe('compactSearch (Layer 1)', () => {
    it('should return compact index entries', async () => {
      await storeObservation({
        entityName: 'port-config',
        type: 'gotcha',
        title: 'Port 3001 conflict fix',
        narrative: 'Port 3000 was already in use by another process',
        facts: ['Default port: 3000', 'Changed to: 3001'],
        projectId: 'test/project',
      });

      const result = await compactSearch({ query: 'port', projectId: 'test/project' });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].title).toBe('Port 3001 conflict fix');
      expect(result.entries[0].icon).toBe('[GOTCHA]');
      expect(result.entries[0].tokens).toBeGreaterThan(0);
    });

    it('returns a structured retrieval receipt with measured assembly time', async () => {
      const result = await compactSearch({ query: 'port', projectId: 'test/project' });

      expect(result.receipt).toMatchObject({
        version: '1',
        mode: expect.any(String),
        resultCount: 0,
        candidateCount: 0,
        selectedCount: 0,
        omittedCount: 0,
        omittedByTokenBudget: 0,
        fallbackUsed: false,
        derivedViews: expect.objectContaining({
          fts: expect.objectContaining({ freshness: expect.any(String), rebuildStatus: expect.any(String) }),
          orama: expect.objectContaining({ freshness: expect.any(String), rebuildStatus: expect.any(String) }),
          embedding: expect.objectContaining({ freshness: expect.any(String), rebuildStatus: expect.any(String) }),
        }),
        tokenCount: result.totalTokens,
        elapsedMs: expect.any(Number),
      });
      expect(result.receipt.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('preserves candidate and omission diagnostics across the compact boundary', async () => {
      for (const title of ['Port 3001 conflict fix', 'Port 3002 staging note', 'Port 3003 rollback note']) {
        await storeObservation({
          entityName: 'port-config',
          type: 'gotcha',
          title,
          narrative: 'The port configuration is relevant to the deployment boundary.',
          projectId: 'test/project',
        });
      }

      const result = await compactSearch({
        query: 'port',
        projectId: 'test/project',
        maxTokens: 1,
      });

      expect(result.receipt.candidateCount).toBeGreaterThanOrEqual(result.receipt.selectedCount);
      expect(result.receipt.omittedCount).toBeGreaterThan(0);
      expect(result.receipt.omittedByTokenBudget).toBe(result.receipt.omittedCount);
      expect(result.receipt.fallbackUsed).toBe(false);
    });

    it('should return formatted markdown table', async () => {
      await storeObservation({
        entityName: 'auth',
        type: 'decision',
        title: 'Use JWT for authentication',
        narrative: 'Decided to use JWT tokens for API auth',
        projectId: 'test/project',
      });

      const result = await compactSearch({ query: 'JWT', projectId: 'test/project' });
      expect(result.formatted).toContain('| Ref |');
      expect(result.formatted).toContain('JWT');
      expect(result.formatted).toContain(`obs:${result.entries[0].id}@test/project`);
      expect(result.formatted).toContain('Progressive Disclosure');
    });

    it('should return empty message when no results', async () => {
      await storeObservation({
        entityName: 'deploy',
        type: 'decision',
        title: 'Use Docker for deployment',
        narrative: 'Existing memory should keep empty search on the generic no-result path',
        projectId: 'test/project',
      });

      const result = await compactSearch({ query: 'nonexistent', projectId: 'test/project' });
      expect(result.entries).toHaveLength(0);
      expect(result.formatted).toContain('No memories found');
      expect(result.formatted).toContain('This project does have stored Baton memories');
      expect(result.formatted).not.toContain('fresh project');
    });

    it('should return a cold-start hint for a fresh project with no memories yet', async () => {
      const result = await compactSearch({ query: 'auth', projectId: 'fresh/project' });

      expect(result.entries).toHaveLength(0);
      expect(result.formatted).toContain('This project does not have any Baton memories yet.');
      expect(result.formatted).toContain('fresh project');
    });
  });

  describe('compactDetail (Layer 3)', () => {
    it('should return full observation details', async () => {
      const { observation: obs } = await storeObservation({
        entityName: 'timeout-config',
        type: 'gotcha',
        title: 'Hook timeout too short',
        narrative: 'Default 60s timeout insufficient for npm install',
        facts: ['Default: 60s', 'npm cold cache: 90s', 'Fix: set to 120s'],
        filesModified: ['hooks.json'],
        concepts: ['hooks', 'timeout', 'npm'],
        projectId: 'test/project',
      });

      const result = await compactDetail([obs.id]);
      expect(result.documents).toHaveLength(1);
      expect(result.formatted).toContain('Hook timeout too short');
      expect(result.formatted).toContain('60s');
      expect(result.formatted).toContain('hooks.json');
    });

    it('should return empty for non-existent IDs', async () => {
      const result = await compactDetail([99999]);
      expect(result.documents).toHaveLength(0);
    });

    it('should fall back to persisted observations when the in-process cache is behind', async () => {
      const persisted = {
        id: 4242,
        entityName: 'split-state',
        type: 'problem-solution' as const,
        title: 'Persisted detail fallback',
        narrative: 'The durable store has this observation even if the current cache missed it.',
        facts: ['Store fallback should open search refs'],
        filesModified: [],
        concepts: ['detail', 'freshness'],
        tokens: 12,
        createdAt: new Date().toISOString(),
        projectId: 'test/project',
        status: 'active' as const,
        source: 'agent' as const,
        sourceDetail: 'hook' as const,
      };
      const { setObservationStore } = await import('../../src/store/obs-store.js');
      setObservationStore({
        init: async () => {},
        loadAll: async () => [persisted],
        loadIdCounter: async () => persisted.id + 1,
        insert: async () => {},
        update: async () => {},
        remove: async () => {},
        bulkReplace: async () => {},
        bulkRemoveByIds: async () => {},
        saveIdCounter: async () => {},
        atomic: async (fn: any) => fn({
          loadAll: async () => [persisted],
          loadIdCounter: async () => persisted.id + 1,
          saveAll: async () => {},
          saveIdCounter: async () => {},
        }),
        ensureFresh: async () => false,
        getGeneration: () => 1,
        close: () => {},
        getBackendName: () => 'sqlite',
      });

      const result = await compactDetail([{ id: persisted.id, projectId: persisted.projectId }]);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].title).toBe('Persisted detail fallback');
      expect(result.formatted).toContain('durable store has this observation');
    });

    it('should fall back to the global index for cross-project detail lookups', async () => {
      const projectADir = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-compact-a-'));
      const projectBDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-compact-b-'));

      try {
        await initObservations(projectADir);
        await storeObservation({
          entityName: 'project-a',
          type: 'what-changed',
          title: 'Project A baseline',
          narrative: 'First observation in project A',
          projectId: 'test/project-a',
        });

        await storeObservation({
          entityName: 'project-a',
          type: 'decision',
          title: 'Cross-project detail target',
          narrative: 'This observation should still open after switching projects',
          facts: ['Project: A'],
          projectId: 'test/project-a',
        });

        await storeObservation({
          entityName: 'project-a',
          type: 'gotcha',
          title: 'Project A extra signal',
          narrative: 'Third observation to ensure the target id is absent in project B memory',
          projectId: 'test/project-a',
        });

        await initObservations(projectBDir);
        await storeObservation({
          entityName: 'project-b',
          type: 'what-changed',
          title: 'Project B baseline',
          narrative: 'Current in-memory project is now B',
          projectId: 'test/project-b',
        });
        await storeObservation({
          entityName: 'project-b',
          type: 'what-changed',
          title: 'Project B git evidence',
          narrative: 'This should not leak into project A detail rendering',
          projectId: 'test/project-b',
          source: 'git',
          sourceDetail: 'git-ingest',
          commitHash: 'deadbeef1234567',
        });

        const searchResult = await compactSearch({ query: 'Cross-project detail target' });
        const target = searchResult.entries.find((entry) => entry.title === 'Cross-project detail target');

        expect(target).toBeDefined();
        expect(target!.id).toBe(2);
        expect(target!.projectId).toBe('test/project-a');
        expect(searchResult.formatted).toContain('| Project |');

        const detailResult = await compactDetail([{ id: target!.id, projectId: target!.projectId }]);
        expect(detailResult.documents).toHaveLength(1);
        expect(detailResult.documents[0].title).toBe('Cross-project detail target');
        expect(detailResult.documents[0].projectId).toBe('test/project-a');
        expect(detailResult.formatted).toContain('Cross-project detail target');
        expect(detailResult.formatted).not.toContain('Repository-backed');
      } finally {
        const { resetObservationStore } = await import('../../src/store/obs-store.js');
        const { closeAllDatabases } = await import('../../src/store/sqlite-db.js');
        resetObservationStore();
        closeAllDatabases();
        await fs.rm(projectADir, { recursive: true, force: true });
        await fs.rm(projectBDir, { recursive: true, force: true });
      }
    }, 30000);

    it('should not attach repository evidence from another project with the same entity name', async () => {
      const { observation: reasoning } = await storeObservation({
        entityName: 'auth',
        type: 'reasoning',
        title: 'Project A auth reasoning',
        narrative: 'Project A reasoning should only cite project A git evidence.',
        projectId: 'test/project-a',
      });
      await storeObservation({
        entityName: 'auth',
        type: 'what-changed',
        title: 'Project A auth commit',
        narrative: 'Git evidence for project A',
        projectId: 'test/project-a',
        source: 'git',
        sourceDetail: 'git-ingest',
        commitHash: 'aaa1111bbbb2222',
      });
      await storeObservation({
        entityName: 'auth',
        type: 'what-changed',
        title: 'Project B auth commit',
        narrative: 'Git evidence for project B',
        projectId: 'test/project-b',
        source: 'git',
        sourceDetail: 'git-ingest',
        commitHash: 'bbb3333cccc4444',
      });

      const detailResult = await compactDetail([{ id: reasoning.id, projectId: 'test/project-a' }]);
      expect(detailResult.formatted).toContain('Evidence support:');
      expect(detailResult.formatted).toContain('Project A auth commit');
      expect(detailResult.formatted).not.toContain('Project B auth commit');
    });

    it('should not attach cited commit evidence from another project sharing the same commit hash', async () => {
      const { observation: reasoning } = await storeObservation({
        entityName: 'auth',
        type: 'reasoning',
        title: 'Project A commit analysis',
        narrative: 'Project A reasoning cites one commit.',
        relatedCommits: ['aaa1111bbbb2222'],
        projectId: 'test/project-a',
      });
      await storeObservation({
        entityName: 'auth',
        type: 'what-changed',
        title: 'Project A cited commit',
        narrative: 'Git evidence for project A cited commit',
        projectId: 'test/project-a',
        source: 'git',
        sourceDetail: 'git-ingest',
        commitHash: 'aaa1111bbbb2222',
      });
      await storeObservation({
        entityName: 'auth',
        type: 'what-changed',
        title: 'Project B same hash commit',
        narrative: 'Different project reusing the same hash string',
        projectId: 'test/project-b',
        source: 'git',
        sourceDetail: 'git-ingest',
        commitHash: 'aaa1111bbbb2222',
      });

      const detailResult = await compactDetail([{ id: reasoning.id, projectId: 'test/project-a' }]);
      expect(detailResult.formatted).toContain('Cited commits: aaa1111');
      expect(detailResult.formatted).toContain('Project A cited commit');
      expect(detailResult.formatted).not.toContain('Project B same hash commit');
    });

    it('should preserve evidence links across canonical project aliases', async () => {
      await registerAlias({
        id: 'local/baton',
        name: 'baton',
        rootPath: 'E:/repo/baton',
      }, testDir);
      await registerAlias({
        id: 'AVIDS2/baton',
        name: 'baton',
        rootPath: 'E:/repo/baton',
        gitRemote: 'https://github.com/AVIDS2/baton.git',
      }, testDir);

      const { observation: reasoning } = await storeObservation({
        entityName: 'auth',
        type: 'reasoning',
        title: 'Alias reasoning',
        narrative: 'Local alias reasoning should still see canonical git evidence.',
        projectId: 'local/baton',
      });
      await storeObservation({
        entityName: 'auth',
        type: 'what-changed',
        title: 'Canonical git evidence',
        narrative: 'Git evidence stored under canonical alias',
        projectId: 'AVIDS2/baton',
        source: 'git',
        sourceDetail: 'git-ingest',
        commitHash: 'ccc5555dddd6666',
      });

      const detailResult = await compactDetail([{ id: reasoning.id, projectId: 'local/baton' }]);
      expect(detailResult.formatted).toContain('Evidence support:');
      expect(detailResult.formatted).toContain('Canonical git evidence');
    });

    it('should accept typed ref strings for observations', async () => {
      const { observation: obs } = await storeObservation({
        entityName: 'typed-ref-test',
        type: 'decision',
        title: 'Typed ref obs test',
        narrative: 'Testing typed ref string path',
        projectId: 'test/project',
      });

      const result = await compactDetail([`obs:${obs.id}`]);
      expect(result.documents).toHaveLength(1);
      expect(result.formatted).toContain('Typed ref obs test');
    });

    it('opens the coding_convention memory a legacy skill:N ref was converted into', async () => {
      const { observation: convention } = await storeObservation({
        entityName: 'http-client',
        type: 'how-it-works',
        title: 'Always pass a timeout',
        narrative: 'Pass `timeout` to every fetch call.',
        topicKey: 'mini-skill/3/0123456789ab',
        category: 'coding_convention',
        projectId: 'test/project',
      });
      const { observation: obs } = await storeObservation({
        entityName: 'order-test',
        type: 'gotcha',
        title: 'Order test observation',
        narrative: 'This obs should appear SECOND',
        projectId: 'test/project',
      });

      const result = await compactDetail(['skill:3', `obs:${obs.id}`]);
      expect(result.documents).toHaveLength(2);
      expect(result.documents[0].observationId).toBe(convention.id);
      expect(result.documents[1].type).toBe('gotcha');
      expect(result.formatted.indexOf('Always pass a timeout')).toBeLessThan(result.formatted.indexOf('Order test observation'));

      const missing = await compactDetail(['skill:99']);
      expect(missing.documents).toHaveLength(0);
      expect(missing.formatted).toContain('Mini-skill S99 not found');
    });

    it('should throw on invalid typed ref strings', async () => {
      await expect(compactDetail(['not-a-ref'])).rejects.toThrow('Invalid memory ref(s)');
      await expect(compactDetail(['not-a-ref'])).rejects.toThrow('"not-a-ref"');
    });

    it('should throw listing all invalid refs in a mixed input', async () => {
      await expect(compactDetail(['obs:1', 'garbage', 'also:bad:format'])).rejects.toThrow('"garbage"');
      await expect(compactDetail(['obs:1', 'garbage', 'also:bad:format'])).rejects.toThrow('"also:bad:format"');
    });

    it('should not throw on valid bare numeric strings', async () => {
      // "42" is a valid legacy bare numeric ref — should not throw
      const result = await compactDetail(['42']);
      expect(result).toBeDefined();
      // May return empty docs (ID 42 doesn't exist) but should NOT throw
    });
  });

  describe('compactSearch Ref column format (Fix 2)', () => {
    it('should display canonical typed refs (obs:N) in the Ref column', async () => {
      const { observation: obs } = await storeObservation({
        entityName: 'ref-format-test',
        type: 'gotcha',
        title: 'Ref format test observation',
        narrative: 'Testing that Ref column shows obs:N',
        projectId: 'test/project',
      });

      const result = await compactSearch({ query: 'Ref format test', projectId: 'test/project' });
      expect(result.entries).toHaveLength(1);
      // The formatted table should contain obs:N, not #N
      expect(result.formatted).toContain(`obs:${obs.id}`);
      expect(result.formatted).not.toMatch(new RegExp(`\\| #${obs.id} \\|`));
    });

    it('hint text should reference typed ref format consistent with Ref column', async () => {
      await storeObservation({
        entityName: 'hint-check',
        type: 'gotcha',
        title: 'Hint consistency check',
        narrative: 'Checking hint text',
        projectId: 'test/project',
      });

      const result = await compactSearch({ query: 'hint', projectId: 'test/project' });
      // Hint should mention typed refs
      expect(result.formatted).toContain('obs:42');
      expect(result.formatted).not.toContain('skill:3');
    });
  });
});
