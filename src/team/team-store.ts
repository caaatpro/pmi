/**
 * TeamStore - SQLite-backed registry of agent identities per project.
 *
 * An agent joins explicitly (team_manage join, session_start joinTeam or the
 * CLI identity commands); its agent_id attributes observations and decides
 * personal/team memory visibility. The former coordination features (tasks,
 * messages, file locks, roles, handoff artifacts) were removed in favour of
 * Baton sessions and handoff; their tables are left in place untouched.
 *
 * Provides:
 *   - Singleton init/get/reset pattern (same as SessionStore)
 *   - Shared DB handle via getDatabase()
 *   - Prepared statements for agent registration, heartbeat and watermark
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '../store/sqlite-db.js';

export const DEFAULT_TEAM_QUERY_LIMIT = 100;
export const MAX_TEAM_QUERY_LIMIT = 500;

function clampTeamQueryLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit == null) return DEFAULT_TEAM_QUERY_LIMIT;
  return Math.min(MAX_TEAM_QUERY_LIMIT, Math.max(1, Math.floor(limit)));
}

// ── Types ───────────────────────────────────────────────────────────

export interface TeamAgentRow {
  agent_id: string;
  project_id: string;
  agent_type: string;
  instance_id: string;
  name: string;
  role: string | null;
  capabilities: string | null; // JSON array
  status: 'active' | 'inactive';
  joined_at: number;
  last_heartbeat: number;
  left_at: number | null;
  last_seen_obs_generation: number;
}

/** Map agentType → default role */
export const AGENT_TYPE_ROLE_MAP: Record<string, string> = {
  'claude-code': 'engineer',
  'cursor': 'engineer',
  'codex': 'engineer',
  'windsurf': 'engineer',
  'opencode': 'engineer',
  'gemini-cli': 'researcher',
  'antigravity': 'researcher',
  'copilot': 'engineer',
  'kiro': 'engineer',
  'trae': 'engineer',
};

export interface WatermarkResult {
  lastSeenGeneration: number;
  currentGeneration: number;
  newObservationCount: number;
}

/** New-observation count since the agent's last session (session_start). */
export function computeWatermark(
  lastSeenGeneration: number,
  currentGeneration: number,
  newObservationCount: number,
): WatermarkResult {
  return { lastSeenGeneration, currentGeneration, newObservationCount };
}

// ── TeamStore ────────────────────────────────────────────────────────

export class TeamStore {
  private db: any = null;
  // ── Agent prepared statements
  private stmtAgentUpsert: any = null;
  private stmtAgentFindByInstance: any = null;
  private stmtAgentFindById: any = null;
  private stmtAgentListByProject: any = null;
  private stmtAgentUpdateHeartbeat: any = null;
  private stmtAgentLeave: any = null;
  private stmtAgentUpdateWatermark: any = null;

  async init(dataDir: string): Promise<void> {
    this.db = getDatabase(dataDir);
    this.prepareAgentStatements();
  }

  // ── Agent statements ──────────────────────────────────────────────

  private prepareAgentStatements(): void {
    this.stmtAgentUpsert = this.db.prepare(`
      INSERT INTO team_agents
        (agent_id, project_id, agent_type, instance_id, name, role, capabilities, status, joined_at, last_heartbeat, left_at, last_seen_obs_generation)
      VALUES
        (@agent_id, @project_id, @agent_type, @instance_id, @name, @role, @capabilities, @status, @joined_at, @last_heartbeat, @left_at, @last_seen_obs_generation)
      ON CONFLICT(project_id, agent_type, instance_id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        capabilities = excluded.capabilities,
        status = excluded.status,
        last_heartbeat = excluded.last_heartbeat,
        left_at = excluded.left_at
    `);

    this.stmtAgentFindByInstance = this.db.prepare(
      `SELECT * FROM team_agents WHERE project_id = ? AND agent_type = ? AND instance_id = ?`
    );

    this.stmtAgentFindById = this.db.prepare(
      `SELECT * FROM team_agents WHERE agent_id = ?`
    );

    this.stmtAgentListByProject = this.db.prepare(
      `SELECT * FROM team_agents WHERE project_id = ? ORDER BY joined_at DESC`
    );

    this.stmtAgentUpdateHeartbeat = this.db.prepare(
      `UPDATE team_agents SET last_heartbeat = ? WHERE agent_id = ?`
    );

    this.stmtAgentLeave = this.db.prepare(
      `UPDATE team_agents SET status = 'inactive', left_at = ? WHERE agent_id = ?`
    );

    this.stmtAgentUpdateWatermark = this.db.prepare(
      `UPDATE team_agents SET last_seen_obs_generation = ?, last_heartbeat = ? WHERE agent_id = ?`
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Agent Operations
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Register or reactivate an agent.
   * If an agent with the same (project_id, agent_type, instance_id) exists,
   * reactivate it (preserving agent_id). Otherwise create a new one.
   */
  registerAgent(input: {
    projectId: string;
    agentType: string;
    instanceId?: string;
    name?: string;
    role?: string;
    capabilities?: string[];
  }): TeamAgentRow {
    const instanceId = input.instanceId || randomUUID();
    const now = Date.now();

    // Check for existing agent by instance key
    const existing = this.stmtAgentFindByInstance.get(
      input.projectId, input.agentType, instanceId
    ) as TeamAgentRow | undefined;

    if (existing) {
      // Reactivate — preserve agent_id, update heartbeat and metadata
      this.stmtAgentUpsert.run({
        agent_id: existing.agent_id,
        project_id: input.projectId,
        agent_type: input.agentType,
        instance_id: instanceId,
        name: input.name ?? existing.name,
        role: input.role ?? existing.role,
        capabilities: input.capabilities ? JSON.stringify(input.capabilities) : existing.capabilities,
        status: 'active',
        joined_at: existing.joined_at,
        last_heartbeat: now,
        left_at: null,
        last_seen_obs_generation: existing.last_seen_obs_generation,
      });
      const row = this.stmtAgentFindById.get(existing.agent_id) as TeamAgentRow;
      return row;
    }

    // New agent
    const agentId = randomUUID();
    this.stmtAgentUpsert.run({
      agent_id: agentId,
      project_id: input.projectId,
      agent_type: input.agentType,
      instance_id: instanceId,
      name: input.name || input.agentType,
      role: input.role ?? null,
      capabilities: input.capabilities ? JSON.stringify(input.capabilities) : null,
      status: 'active',
      joined_at: now,
      last_heartbeat: now,
      left_at: null,
      last_seen_obs_generation: 0,
    });
    const row = this.stmtAgentFindById.get(agentId) as TeamAgentRow;
    return row;
  }

  getAgent(agentId: string): TeamAgentRow | undefined {
    return this.stmtAgentFindById.get(agentId) as TeamAgentRow | undefined;
  }

  getAgentByInstance(projectId: string, agentType: string, instanceId: string): TeamAgentRow | undefined {
    return this.stmtAgentFindByInstance.get(projectId, agentType, instanceId) as TeamAgentRow | undefined;
  }

  listAgents(projectId: string, filter?: { status?: 'active' | 'inactive'; limit?: number }): TeamAgentRow[] {
    const limit = clampTeamQueryLimit(filter?.limit);
    if (filter?.status) {
      return this.db.prepare(
        `SELECT * FROM team_agents WHERE project_id = ? AND status = ? ORDER BY joined_at DESC LIMIT ?`,
      ).all(projectId, filter.status, limit) as TeamAgentRow[];
    }
    return this.db.prepare(
      `SELECT * FROM team_agents WHERE project_id = ? ORDER BY joined_at DESC LIMIT ?`,
    ).all(projectId, limit) as TeamAgentRow[];
  }

  heartbeat(agentId: string): boolean {
    const info = this.stmtAgentUpdateHeartbeat.run(Date.now(), agentId);
    return info.changes > 0;
  }

  leaveAgent(agentId: string): boolean {
    const info = this.stmtAgentLeave.run(Date.now(), agentId);
    return info.changes > 0;
  }

  updateWatermark(agentId: string, generation: number): void {
    this.stmtAgentUpdateWatermark.run(generation, Date.now(), agentId);
  }

  /**
   * Mark agents without a recent heartbeat inactive. Returns their IDs.
   */
  detectAndMarkStale(projectId: string, staleTtlMs: number): string[] {
    const threshold = Date.now() - staleTtlMs;
    const staleAgents = (this.stmtAgentListByProject.all(projectId) as TeamAgentRow[])
      .filter(a => a.status === 'active' && a.last_heartbeat < threshold);

    const staleIds: string[] = [];
    const now = Date.now();
    for (const agent of staleAgents) {
      this.stmtAgentLeave.run(now, agent.agent_id);
      staleIds.push(agent.agent_id);
    }
    return staleIds;
  }

  getActiveCount(projectId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM team_agents WHERE project_id = ? AND status = 'active'`,
    ).get(projectId) as { count: number };
    return Number(row?.count ?? 0);
  }

  // ── Accessor for raw DB (used by cross-process tests) ─────────────

  getDb(): any {
    return this.db;
  }
}

// ── Singleton access ────────────────────────────────────────────────

let _teamStore: TeamStore | null = null;
let _teamStoreDataDir: string | null = null;

export function getTeamStore(): TeamStore {
  if (!_teamStore) {
    throw new Error('[baton] TeamStore not initialized — call initTeamStore() first');
  }
  return _teamStore;
}

export function isTeamStoreInitialized(): boolean {
  return _teamStore !== null;
}

export async function initTeamStore(dataDir: string): Promise<TeamStore> {
  if (_teamStore && _teamStoreDataDir === dataDir) return _teamStore;

  _teamStore = null;
  _teamStoreDataDir = null;

  const store = new TeamStore();
  await store.init(dataDir);
  _teamStore = store;
  _teamStoreDataDir = dataDir;
  return store;
}

export function resetTeamStore(): void {
  _teamStore = null;
  _teamStoreDataDir = null;
}
