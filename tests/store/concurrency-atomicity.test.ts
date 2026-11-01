/**
 * Concurrency atomicity regression tests
 *
 * PR #60 review findings:
 * Concurrent startSession must leave exactly one active session per project
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initSessionStore, getSessionStore, resetSessionStore } from '../../src/store/session-store.js';
import { closeAllDatabases } from '../../src/store/sqlite-db.js';
import type { Observation } from '../../src/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-atomicity-'));
  resetSessionStore();
});

afterEach(async () => {
  resetSessionStore();
  closeAllDatabases();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Concurrent startSession — atomic rollover', () => {
  it('should leave exactly one active session after N concurrent starts of the same agent', async () => {
    await initSessionStore(tmpDir);
    const store = getSessionStore();

    const PROJECT_ID = 'org/concurrent-test';
    const N = 10;

    const promises = Array.from({ length: N }, (_, i) => {
      const session = {
        id: `sess-concurrent-${i}`,
        projectId: PROJECT_ID,
        startedAt: new Date().toISOString(),
        status: 'active' as const,
        agent: 'claude-code',
      };
      return store.atomicRolloverInsert(
        session,
        [PROJECT_ID],
        new Date().toISOString(),
      );
    });

    await Promise.all(promises);

    // Exactly one active session must remain
    const activeSessions = await store.loadActive(PROJECT_ID);
    expect(activeSessions).toHaveLength(1);

    // All N sessions should exist (N-1 completed + 1 active)
    const allSessions = await store.loadByProject(PROJECT_ID);
    expect(allSessions).toHaveLength(N);

    const activeCount = allSessions.filter(s => s.status === 'active').length;
    const completedCount = allSessions.filter(s => s.status === 'completed').length;
    expect(activeCount).toBe(1);
    expect(completedCount).toBe(N - 1);
  });

  it('keeps sessions of different agents active in parallel', async () => {
    await initSessionStore(tmpDir);
    const store = getSessionStore();

    const PROJECT_ID = 'org/parallel-agents';
    const agents = ['claude-code', 'codex', 'cursor'];

    await Promise.all(agents.map((agent) => store.atomicRolloverInsert(
      {
        id: `sess-${agent}`,
        projectId: PROJECT_ID,
        startedAt: new Date().toISOString(),
        status: 'active' as const,
        agent,
      },
      [PROJECT_ID],
      new Date().toISOString(),
    )));

    const active = await store.loadActive(PROJECT_ID);
    expect(active.map((session) => session.agent).sort()).toEqual([...agents].sort());

    // A restart of one agent closes only that agent's previous session.
    const completed = await store.atomicRolloverInsert(
      {
        id: 'sess-codex-restart',
        projectId: PROJECT_ID,
        startedAt: new Date().toISOString(),
        status: 'active' as const,
        agent: 'codex',
      },
      [PROJECT_ID],
      new Date().toISOString(),
    );
    expect(completed).toBe(1);
    const afterRestart = await store.loadActive(PROJECT_ID);
    expect(afterRestart.map((session) => session.id).sort()).toEqual(['sess-claude-code', 'sess-codex-restart', 'sess-cursor']);
  });

  it('should not affect sessions in other projects', async () => {
    await initSessionStore(tmpDir);
    const store = getSessionStore();

    const PROJECT_A = 'org/project-a';
    const PROJECT_B = 'org/project-b';

    // Insert an active session for project B
    await store.insert({
      id: 'sess-b-existing',
      projectId: PROJECT_B,
      startedAt: new Date().toISOString(),
      status: 'active',
      agent: 'windsurf',
    });

    // Concurrent starts for project A only
    const promises = Array.from({ length: 5 }, (_, i) => {
      const session = {
        id: `sess-a-${i}`,
        projectId: PROJECT_A,
        startedAt: new Date().toISOString(),
        status: 'active' as const,
        agent: 'windsurf',
      };
      return store.atomicRolloverInsert(session, [PROJECT_A], new Date().toISOString());
    });

    await Promise.all(promises);

    // Project A: exactly 1 active
    const activeA = await store.loadActive(PROJECT_A);
    expect(activeA).toHaveLength(1);

    // Project B: still 1 active, untouched
    const activeB = await store.loadActive(PROJECT_B);
    expect(activeB).toHaveLength(1);
    expect(activeB[0].id).toBe('sess-b-existing');
  });

  it('should handle project aliases in rollover', async () => {
    await initSessionStore(tmpDir);
    const store = getSessionStore();

    const ALIAS_1 = 'org/project-main';
    const ALIAS_2 = 'org/project-fork';

    // Insert active sessions under both aliases
    await store.insert({
      id: 'sess-alias-1',
      projectId: ALIAS_1,
      startedAt: new Date().toISOString(),
      status: 'active',
      agent: 'cursor',
    });
    await store.insert({
      id: 'sess-alias-2',
      projectId: ALIAS_2,
      startedAt: new Date().toISOString(),
      status: 'active',
      agent: 'cursor',
    });

    // Rollover with both aliases
    const newSession = {
      id: 'sess-new',
      projectId: ALIAS_1,
      startedAt: new Date().toISOString(),
      status: 'active' as const,
      agent: 'cursor',
    };
    const completed = await store.atomicRolloverInsert(
      newSession,
      [ALIAS_1, ALIAS_2],
      new Date().toISOString(),
    );

    expect(completed).toBe(2); // Both old sessions completed

    // Only the new session should be active
    const activeMain = await store.loadActive(ALIAS_1);
    expect(activeMain).toHaveLength(1);
    expect(activeMain[0].id).toBe('sess-new');

    // The alias-2 session should be completed
    const activeFork = await store.loadActive(ALIAS_2);
    expect(activeFork).toHaveLength(0);
  });
});
