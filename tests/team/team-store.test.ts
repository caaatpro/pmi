/**
 * TeamStore - SQLite-backed agent identity registry tests.
 *
 * Covers: agent registration, reactivation, heartbeat, stale detection and
 * the observation watermark.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TeamStore } from '../../src/team/team-store.js';
import { closeDatabase } from '../../src/store/sqlite-db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'baton-team-test-'));
}

function cleanup(dir: string): void {
  closeDatabase(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('TeamStore', () => {
  let store: TeamStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new TeamStore();
    await store.init(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ═════════════════════════════════════════════════════════════════
  // Agent Registration
  // ═════════════════════════════════════════════════════════════════

  describe('Agent Registration', () => {
    it('should register a new agent and return stable agent_id', async () => {
      const agent = store.registerAgent({
        projectId: 'proj1',
        agentType: 'windsurf',
        instanceId: 'inst-1',
        name: 'Cascade',
      });
      expect(agent.agent_id).toBeTruthy();
      expect(agent.agent_type).toBe('windsurf');
      expect(agent.instance_id).toBe('inst-1');
      expect(agent.name).toBe('Cascade');
      expect(agent.status).toBe('active');
    });

    it('should reactivate existing agent by (project_id, agent_type, instance_id)', async () => {
      const first = store.registerAgent({
        projectId: 'proj1',
        agentType: 'windsurf',
        instanceId: 'inst-1',
        name: 'Cascade',
      });
      // Simulate leave
      store.leaveAgent(first.agent_id);

      const second = store.registerAgent({
        projectId: 'proj1',
        agentType: 'windsurf',
        instanceId: 'inst-1',
        name: 'Cascade v2', // name can change
      });

      expect(second.agent_id).toBe(first.agent_id); // same durable identity
      expect(second.name).toBe('Cascade v2');
      expect(second.status).toBe('active');
    });

    it('should NOT merge two agents with same type+name but different instance_id', async () => {
      const a = store.registerAgent({
        projectId: 'proj1',
        agentType: 'windsurf',
        instanceId: 'window-1',
        name: 'Cascade',
      });
      const b = store.registerAgent({
        projectId: 'proj1',
        agentType: 'windsurf',
        instanceId: 'window-2',
        name: 'Cascade', // same name!
      });

      expect(a.agent_id).not.toBe(b.agent_id); // distinct identities
      expect(store.getActiveCount('proj1')).toBe(2);
    });

    it('should auto-generate instance_id when not provided', async () => {
      const agent = store.registerAgent({
        projectId: 'proj1',
        agentType: 'cursor',
      });
      expect(agent.instance_id).toBeTruthy();
      expect(agent.instance_id.length).toBeGreaterThan(10); // UUID
    });

    it('should list agents filtered by status', async () => {
      const a = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'i1' });
      store.registerAgent({ projectId: 'proj1', agentType: 'cursor', instanceId: 'i2' });
      store.leaveAgent(a.agent_id);

      const active = store.listAgents('proj1', { status: 'active' });
      const inactive = store.listAgents('proj1', { status: 'inactive' });
      expect(active.length).toBe(1);
      expect(inactive.length).toBe(1);
      expect(inactive[0].agent_id).toBe(a.agent_id);
    });

    it('should update heartbeat', async () => {
      const agent = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'i1' });
      const before = store.getAgent(agent.agent_id)!.last_heartbeat;

      // Small delay to ensure different timestamp
      await new Promise(r => setTimeout(r, 15));
      store.heartbeat(agent.agent_id);

      const after = store.getAgent(agent.agent_id)!.last_heartbeat;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('should detect and mark stale agents', async () => {
      const agent = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'i1' });
      // Force old heartbeat
      store.getDb().prepare('UPDATE team_agents SET last_heartbeat = ? WHERE agent_id = ?')
        .run(Date.now() - 60000, agent.agent_id);

      const stale = store.detectAndMarkStale('proj1', 30000); // 30s threshold
      expect(stale).toContain(agent.agent_id);

      const updated = store.getAgent(agent.agent_id)!;
      expect(updated.status).toBe('inactive');
    });
  });


  describe('Watermark', () => {
    it('should update and read agent watermark', () => {
      const agent = store.registerAgent({ projectId: 'proj1', agentType: 'windsurf', instanceId: 'i1' });
      expect(agent.last_seen_obs_generation).toBe(0);

      store.updateWatermark(agent.agent_id, 42);
      const updated = store.getAgent(agent.agent_id)!;
      expect(updated.last_seen_obs_generation).toBe(42);
    });
  });
});
