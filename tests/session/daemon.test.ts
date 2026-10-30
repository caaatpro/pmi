import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { daemonTick, isProcessAlive, type DaemonSettings } from '../../src/session/daemon.js';
import { parsePorcelain, readWorkspace } from '../../src/session/git-state.js';
import { LocalSessionStore } from '../../src/session/local-store.js';
import { applyUpdate, checkpointSession, flushOutbox, handoffSession, startSession, updateSession } from '../../src/session/service.js';
import { closeAllDatabases } from '../../src/store/sqlite-db.js';
import { emptySessionState } from '../../src/domain/session.js';

let root = '';
let repo = '';
let store: LocalSessionStore;

const settings: DaemonSettings = { tickMs: 10, debounceMs: 0, intervalMs: 60_000, agentIdleMs: 60_000, heartbeatMs: 60_000 };
const env = { PMI_HOME: '' } as NodeJS.ProcessEnv;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pmi-daemon-'));
  repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 't@test.dev');
  git('config', 'user.name', 'T');
  writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  env.PMI_HOME = path.join(root, 'pmi-home');
  store = new LocalSessionStore(path.join(root, 'data'));
});

afterEach(() => {
  closeAllDatabases();
  rmSync(root, { recursive: true, force: true });
});

describe('git state', () => {
  it('parses porcelain status including renames and untracked files', () => {
    expect(parsePorcelain(' M src/a.ts\0R  new.ts\0old.ts\0?? notes.md\0D  gone.ts\0A  added.ts\0')).toEqual([
      { path: 'src/a.ts', status: 'M' },
      { path: 'new.ts', status: 'R', oldPath: 'old.ts' },
      { path: 'notes.md', status: 'U' },
      { path: 'gone.ts', status: 'D' },
      { path: 'added.ts', status: 'A' },
    ]);
  });

  it('changes the fingerprint when a changed file changes again', () => {
    writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
    const first = readWorkspace(repo)!;
    writeFileSync(path.join(repo, 'a.ts'), 'export const a = 30;\n');
    const second = readWorkspace(repo)!;
    expect(first.git).toMatchObject({ branch: 'main', dirty: true, modifiedFiles: [{ path: 'a.ts', status: 'M' }] });
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });
});

describe('session updates', () => {
  it('moves completed steps out of pending', () => {
    const state = { ...emptySessionState({ sessionId: 's', projectId: 'p', deviceId: 'd' }), pendingSteps: [{ id: '1', text: 'Write tests', at: 'x' }, { id: '2', text: 'Ship', at: 'x' }] };
    const next = applyUpdate(state, { completed: ['write tests'], next: 'Ship it' });
    expect(next.completedSteps.map((step) => step.text)).toEqual(['write tests']);
    expect(next.pendingSteps.map((step) => step.text)).toEqual(['Ship']);
    expect(next.nextAction).toBe('Ship it');
  });
});

describe('daemon tick (no agent help)', () => {
  it('does nothing while the working copy is unchanged since start', async () => {
    startSession(store, { projectId: 'acme/app', projectRoot: repo, agent: 'codex', agentPid: process.pid });
    const report = await daemonTick(store, settings, env);
    expect(report.checkpoints).toEqual([]);
  });

  it('checkpoints file changes and commits by itself', async () => {
    const session = startSession(store, { projectId: 'acme/app', projectRoot: repo, agent: 'codex', agentPid: process.pid });
    writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
    expect((await daemonTick(store, settings, env)).checkpoints).toEqual([{ sessionId: session.id, trigger: 'fs_change' }]);
    expect((await daemonTick(store, settings, env)).checkpoints).toEqual([]);

    git('add', '.');
    git('commit', '-q', '-m', 'add b');
    expect((await daemonTick(store, settings, env)).checkpoints).toEqual([{ sessionId: session.id, trigger: 'commit' }]);

    const checkpoints = store.checkpoints(session.id);
    expect(checkpoints.map((c) => c.trigger)).toEqual(['fs_change', 'commit']);
    expect(checkpoints[0].state.git?.modifiedFiles).toEqual([{ path: 'b.ts', status: 'U' }]);
    expect(checkpoints[1].state.git?.dirty).toBe(false);
  });

  it('waits for changes to settle before checkpointing', async () => {
    const session = startSession(store, { projectId: 'acme/app', projectRoot: repo, agentPid: process.pid });
    writeFileSync(path.join(repo, 'c.ts'), '1');
    const slow = { ...settings, debounceMs: 1_000 };
    expect((await daemonTick(store, slow, env)).checkpoints).toEqual([]);
    expect((await daemonTick(store, slow, env, Date.now() + 1_500)).checkpoints).toEqual([{ sessionId: session.id, trigger: 'fs_change' }]);
  });

  it('when the agent process dies: final exit checkpoint and the session becomes resumable', async () => {
    const session = startSession(store, { projectId: 'acme/app', projectRoot: repo, agent: 'claude-code', agentPid: deadPid() });
    updateSession(store, session.id, { task: 'Refunds', completed: ['refund table'], next: 'refund endpoint' });
    writeFileSync(path.join(repo, 'refund.ts'), 'export {};\n');
    const report = await daemonTick(store, settings, env);
    expect(report.released).toEqual([session.id]);
    expect(report.checkpoints).toEqual([{ sessionId: session.id, trigger: 'exit' }]);
    const after = store.get(session.id)!;
    expect(after.status).toBe('resumable');
    expect(after.state.completedSteps.map((step) => step.text)).toEqual(['refund table']);
    expect(store.checkpoints(session.id).at(-1)!.state.git?.modifiedFiles.map((f) => f.path)).toEqual(['refund.ts']);
    expect(store.pendingOps().map((op) => op.kind)).toEqual(['session.upsert', 'snapshot', 'checkpoint', 'release']);
    expect(after.state.workspaceSnapshotId).toMatch(/^snap_/);
  });

  it('releases an idle session without a checkpoint as interrupted', async () => {
    const session = startSession(store, { projectId: 'acme/app', projectRoot: repo, agentPid: process.pid });
    const report = await daemonTick(store, settings, env, Date.now() + 120_000);
    expect(report.released).toEqual([session.id]);
    expect(store.get(session.id)!.status).toBe('interrupted');
  });

  it('ignores sessions that are not live', async () => {
    const session = startSession(store, { projectId: 'acme/app', projectRoot: repo, agentPid: deadPid() });
    checkpointSession(store, session.id, 'manual', { next: 'continue' });
    handoffSession(store, session.id);
    writeFileSync(path.join(repo, 'later.ts'), '1');
    expect(await daemonTick(store, settings, env)).toMatchObject({ checkpoints: [], released: [] });
  });
});

describe('outbox', () => {
  it('keeps everything queued in Local mode and in order', async () => {
    const session = startSession(store, { projectId: 'acme/app', projectRoot: repo, agentPid: process.pid });
    checkpointSession(store, session.id, 'manual', { completed: ['a'] });
    const result = handoffSession(store, session.id, { next: 'b' });
    expect(result.brief).toContain('## Next action\nb');
    const flush = await flushOutbox(store, env);
    expect(flush).toMatchObject({ sent: 0, pending: 6 });
    // The repository has no remote, so its commit counts as unpushed and is snapshotted once;
    // the handoff re-registers the same snapshot to pin it.
    expect(store.pendingOps().map((op) => op.kind)).toEqual(['session.upsert', 'snapshot', 'checkpoint', 'snapshot', 'checkpoint', 'handoff']);
    expect(store.checkpoints(session.id).map((c) => c.seq)).toEqual([1, 2]);
  });

  it('refuses status changes the state machine forbids', () => {
    const session = startSession(store, { projectId: 'acme/app', projectRoot: repo, agentPid: process.pid });
    store.setStatus(session.id, 'completed');
    expect(() => checkpointSession(store, session.id, 'manual')).toThrow(/cannot move from completed/);
  });
});

describe('process liveness', () => {
  it('detects a dead pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(deadPid())).toBe(false);
  });
});
