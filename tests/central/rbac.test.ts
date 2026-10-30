/**
 * Phase 5 access control, including acceptance TEST 9: a user without a
 * grant is refused on every project surface (REST, search, MCP), and the
 * database itself returns no rows under that user's identity.
 */
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { addTeamMember, createOrganization, createTeam, createUser, issueToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import { contentHash } from '../../src/sync/journal.js';
import { syncNamespace } from '../../src/sync/namespace.js';
import type { ChangeBatch, ChangeEntry } from '../../src/sync/types.js';
import type { Observation } from '../../src/types.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

const LEGACY = 'acme/payments';
let pg: TestPostgres;
let db: Database;
let server: http.Server;
let base = '';
let projectId = '';
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
let sequence = 0;

async function call(path: string, init: { method?: string; as?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      ...(init.as ? { authorization: `Bearer ${tokens[init.as]}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

function obs(id: number, extra: Partial<Observation> = {}): Observation {
  return {
    id,
    entityName: 'payments',
    type: 'decision',
    title: `Refunds go through the ledger ${id}`,
    narrative: 'Refunds are recorded as ledger entries, never as negative payments.',
    facts: [],
    filesModified: ['src/ledger.ts'],
    concepts: [],
    tokens: 15,
    createdAt: '2026-10-31T09:00:00.000Z',
    projectId: LEGACY,
    ...extra,
  };
}

function upsert(syncKey: string, row: Observation, revision: number, writer: string): ChangeEntry {
  return { syncKey, kind: 'upsert', version: { revision, writer }, contentHash: contentHash(row), row };
}

function push(as: string, entries: ChangeEntry[], deviceId = `dev_${as}`) {
  sequence++;
  const batch: ChangeBatch = { formatVersion: 3, namespace: syncNamespace(LEGACY), projectId: LEGACY, deviceId, sequence, producedAt: new Date().toISOString(), entries };
  return call('/v1/sync/push', { as, body: { project_id: projectId, batch } });
}

async function mcpClient(as?: string): Promise<Client> {
  const client = new Client({ name: 'rbac-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: as ? { headers: { authorization: `Bearer ${tokens[as]}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

function toolText(result: any): string {
  return (result?.content ?? []).map((item: any) => item.text ?? '').join('\n');
}

/** Run SQL the way the server does for a request: as pmi_app with app.user_id set. */
async function asUserSql<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.asUser(userId, (tx) => tx.query<T>(sql, params));
}

describe.skipIf(!pgAvailable)('RBAC and row-level security (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    await createOrganization(db, 'rival', 'Rival');
    const people: Array<[string, string, 'owner' | 'admin' | 'member']> = [
      ['owner', 'acme', 'owner'],
      ['maint', 'acme', 'member'],
      ['dev', 'acme', 'member'],
      ['viewer', 'acme', 'member'],
      ['teammate', 'acme', 'member'],
      ['nogrant', 'acme', 'member'],
      ['stranger', 'rival', 'owner'],
    ];
    for (const [name, org, role] of people) {
      const user = await createUser(db, { email: `${name}@test.dev`, displayName: name, orgSlug: org, role });
      ids[name] = user.id;
      tokens[name] = (await issueToken(db, { email: `${name}@test.dev`, name: 'test' })).token;
    }
    const team = await createTeam(db, 'acme', 'platform');
    await addTeamMember(db, team.id, ids.teammate);

    server = createCentralServer({ db, version: 'test', log: (l) => { if (l.level === 'error') console.error(l.error); } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const created = await call('/v1/projects/resolve', { as: 'owner', body: { legacy_project_id: LEGACY, create: { org: 'acme', slug: 'payments' } } });
    expect(created.status).toBe(201);
    projectId = created.body.project.id;
    for (const [email, role] of [['maint@test.dev', 'maintainer'], ['dev@test.dev', 'developer'], ['viewer@test.dev', 'viewer']]) {
      expect((await call(`/v1/projects/${projectId}/grants`, { method: 'PUT', as: 'owner', body: { user: email, role } })).status).toBe(200);
    }
    expect((await call(`/v1/projects/${projectId}/grants`, { method: 'PUT', as: 'maint', body: { team: 'platform', role: 'developer' } })).status).toBe(200);

    expect((await push('dev', [upsert('p:acme%2Fpayments:u:dev_dev:1', obs(1), 1, 'dev_dev')])).body.results[0].outcome).toBe('applied');
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db?.close();
    await pg?.stop();
  });

  it('reports each user\'s effective role', async () => {
    const roles: Record<string, string | undefined> = {};
    for (const name of ['owner', 'maint', 'dev', 'viewer', 'teammate', 'nogrant', 'stranger']) {
      const me = await call('/v1/me', { as: name });
      roles[name] = me.body.projects.find((p: { id: string }) => p.id === projectId)?.role;
    }
    expect(roles).toEqual({ owner: 'admin', maint: 'maintainer', dev: 'developer', viewer: 'viewer', teammate: 'developer', nogrant: undefined, stranger: undefined });
  });

  it('enforces the role matrix', async () => {
    // viewer: read only
    expect((await call(`/v1/projects/${projectId}/memories`, { as: 'viewer' })).body.memories).toHaveLength(1);
    expect((await push('viewer', [upsert('p:acme%2Fpayments:u:dev_viewer:1', obs(2), 1, 'dev_viewer')])).status).toBe(403);
    const memoryId = encodeURIComponent('p:acme%2Fpayments:u:dev_dev:1');
    expect((await call(`/v1/memories/${memoryId}/confirm`, { as: 'viewer', body: {} })).status).toBe(403);
    expect((await call(`/v1/projects/${projectId}/grants`, { method: 'PUT', as: 'viewer', body: { user: 'nogrant@test.dev', role: 'viewer' } })).status).toBe(403);
    // developer (direct or via team): write, but no grant management
    expect((await push('teammate', [upsert('p:acme%2Fpayments:u:dev_teammate:1', obs(3), 1, 'dev_teammate')])).body.results[0].outcome).toBe('applied');
    expect((await call(`/v1/projects/${projectId}/grants`, { method: 'PUT', as: 'dev', body: { user: 'nogrant@test.dev', role: 'viewer' } })).status).toBe(403);
    // grants only for principals inside the organization
    expect((await call(`/v1/projects/${projectId}/grants`, { method: 'PUT', as: 'maint', body: { user: 'stranger@test.dev', role: 'viewer' } })).status).toBe(422);
    const denied = await db.query("SELECT action FROM core.audit_log WHERE action = 'access.denied' AND project_id = $1", [projectId]);
    expect(denied.length).toBeGreaterThanOrEqual(3);
  });

  it('revoking a team grant removes access for its members', async () => {
    expect((await call(`/v1/projects/${projectId}/grants`, { method: 'PUT', as: 'maint', body: { team: 'platform', role: null } })).status).toBe(200);
    expect((await call(`/v1/projects/${projectId}`, { as: 'teammate' })).status).toBe(404);
    expect((await call(`/v1/projects/${projectId}/grants`, { method: 'PUT', as: 'maint', body: { team: 'platform', role: 'developer' } })).status).toBe(200);
    expect((await call(`/v1/projects/${projectId}`, { as: 'teammate' })).status).toBe(200);
  });

  describe('TEST 9: a user without a grant sees nothing', () => {
    const memoryPath = () => `/v1/memories/${encodeURIComponent('p:acme%2Fpayments:u:dev_dev:1')}`;

    for (const who of ['nogrant', 'stranger']) {
      it(`${who}: REST project surfaces answer 404`, async () => {
        const responses = await Promise.all([
          call(`/v1/projects/${projectId}`, { as: who }),
          call(`/v1/projects/${projectId}/memories`, { as: who }),
          call(`/v1/projects/${projectId}/changes?legacy=${encodeURIComponent(LEGACY)}`, { as: who }),
          call(`/v1/projects/${projectId}/conflicts`, { as: who }),
          call(`/v1/projects/${projectId}/search`, { as: who, body: { query: 'refunds' } }),
          call(memoryPath(), { as: who }),
          call(`${memoryPath()}/confirm`, { as: who, body: {} }),
          push(who, [upsert(`p:acme%2Fpayments:u:dev_${who}:1`, obs(9), 1, `dev_${who}`)]),
          call(`/v1/projects/${projectId}/grants`, { method: 'PUT', as: who, body: { user: `${who}@test.dev`, role: 'maintainer' } }),
        ]);
        expect(responses.map((r) => r.status)).toEqual(Array(responses.length).fill(404));
        expect((await call('/v1/projects/resolve', { as: who, body: { legacy_project_id: LEGACY } })).status).toBe(404);
      });

      it(`${who}: cross-project search returns nothing from the project`, async () => {
        const result = await call('/v1/search', { as: who, body: { query: 'refunds ledger' } });
        expect(result.status).toBe(200);
        expect(result.body.results).toEqual([]);
        const allowed = await call('/v1/search', { as: 'viewer', body: { query: 'refunds ledger' } });
        expect(allowed.body.results.length).toBeGreaterThan(0);
      });

      it(`${who}: MCP tools refuse the project`, async () => {
        const client = await mcpClient(who);
        try {
          const list = await client.callTool({ name: 'project_list', arguments: {} });
          expect(JSON.stringify(list.structuredContent)).not.toContain(projectId);
          const scoped = await client.callTool({ name: 'memory_search', arguments: { query: 'refunds', project_id: projectId } });
          expect(scoped.isError).toBe(true);
          expect(toolText(scoped)).toContain('project_not_found');
          const global = await client.callTool({ name: 'memory_search', arguments: { query: 'refunds' } });
          expect((global.structuredContent as { results: unknown[] }).results).toEqual([]);
          const get = await client.callTool({ name: 'memory_get', arguments: { id: 'p:acme%2Fpayments:u:dev_dev:1' } });
          expect(get.isError).toBe(true);
        } finally {
          await client.close();
        }
      });

      it(`${who}: direct SQL under their app.user_id returns no rows`, async () => {
        for (const table of ['memory.memories', 'memory.memory_versions', 'memory.conflicts', 'work.changes', 'work.project_seq']) {
          const [row] = await asUserSql<{ n: number }>(ids[who], `SELECT count(*)::int AS n FROM ${table}`);
          expect(row.n, table).toBe(0);
        }
        await expect(asUserSql(ids[who], 'UPDATE memory.memories SET title = $1 RETURNING id', ['hijacked'])).resolves.toEqual([]);
        await expect(asUserSql(ids[who],
          `INSERT INTO memory.memories (id, project_id, legacy_project_id, category, confidence, revision, writer, created_at, updated_at, server_seq)
           VALUES ('x', $1, 'acme/payments', 'component', 'observed', 1, 'x', now(), now(), 1)`, [projectId]))
          .rejects.toThrow(/row-level security/);
        await expect(asUserSql(ids[who], 'DELETE FROM core.audit_log')).rejects.toThrow(/permission denied/);
      });
    }

    it('the same SQL returns rows for a granted user, so the check above is meaningful', async () => {
      const [row] = await asUserSql<{ n: number }>(ids.viewer, 'SELECT count(*)::int AS n FROM memory.memories');
      expect(row.n).toBeGreaterThan(0);
      await expect(asUserSql(ids.viewer, 'UPDATE memory.memories SET title = $1 RETURNING id', ['hijacked'])).resolves.toEqual([]);
    });

    it('MCP without a token is rejected with 401', async () => {
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(401);
    });
  });

  it('serves granted users over MCP', async () => {
    const client = await mcpClient('viewer');
    try {
      const found = await client.callTool({ name: 'memory_search', arguments: { query: 'refunds', project_id: projectId } });
      expect(found.isError).toBeFalsy();
      expect(toolText(found)).toContain('Refunds go through the ledger');
      const detail = await client.callTool({ name: 'memory_get', arguments: { id: 'p:acme%2Fpayments:u:dev_dev:1', versions: true } });
      expect(toolText(detail)).toContain('never as negative payments');
    } finally {
      await client.close();
    }
  });

  describe('confidence protection', () => {
    const key = 'p:acme%2Fpayments:u:dev_dev:1';

    it('rejects confirmation through sync', async () => {
      const result = await push('dev', [upsert('p:acme%2Fpayments:u:dev_dev:50', obs(50, { confidence: 'confirmed' }), 1, 'dev_dev')]);
      expect(result.body.results[0]).toMatchObject({ outcome: 'rejected', reason: 'confirmation requires an explicit confirm by a person' });
    });

    it('lets a developer confirm, publishes it in the feed, and freezes the memory for sync', async () => {
      const confirmed = await call(`/v1/memories/${encodeURIComponent(key)}/confirm`, { as: 'dev', body: { reason: 'agreed in review' } });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.memory).toMatchObject({ confidence: 'confirmed', version: 2 });

      const feed = await call(`/v1/projects/${projectId}/changes?after=0&legacy=${encodeURIComponent(LEGACY)}`, { as: 'viewer' });
      const change = feed.body.changes.find((c: { entry: { syncKey: string } }) => c.entry.syncKey === key);
      expect(change.entry.version).toEqual({ revision: 2, writer: 'pmi-server' });
      expect(change.entry.row.confidence).toBe('confirmed');
      expect(change.entry.contentHash).toBe(contentHash(change.entry.row));

      const edit = await push('dev', [upsert(key, { ...change.entry.row, narrative: 'Agent rewrite.' }, 3, 'dev_dev')]);
      expect(edit.body.results[0]).toMatchObject({ outcome: 'rejected' });
      expect(edit.body.results[0].reason).toContain('confirmed knowledge');
      const tombstone = await push('dev', [{ syncKey: key, kind: 'tombstone', version: { revision: 3, writer: 'dev_dev' }, contentHash: '' }]);
      expect(tombstone.body.results[0].outcome).toBe('rejected');

      const audit = await db.query<{ action: string }>("SELECT action FROM core.audit_log WHERE action = 'memory.confirm' AND target_id = $1", [key]);
      expect(audit).toHaveLength(1);
    });

    it('lets a person deprecate confirmed knowledge', async () => {
      const deprecated = await call(`/v1/memories/${encodeURIComponent(key)}/deprecate`, { as: 'maint', body: { reason: 'replaced by refund service' } });
      expect(deprecated.body.memory).toMatchObject({ confidence: 'deprecated', version: 3 });
      const versions = await call(`/v1/memories/${encodeURIComponent(key)}?include=versions`, { as: 'viewer' });
      expect(versions.body.versions.map((v: { reason: string }) => v.reason)).toEqual(['deprecate: replaced by refund service', 'confirm: agreed in review', 'sync']);
    });
  });
});

describe.skipIf(!pgAvailable)('upgrade from the Phase 4 schema', () => {
  it('keeps the access organization members had before grants existed', async () => {
    const local = await startPostgres();
    const legacyDb = await openDatabase(local.url);
    try {
      await migrate(legacyDb, { until: '0001-core-memory' });
      await createOrganization(legacyDb, 'acme', 'Acme');
      const member = await createUser(legacyDb, { email: 'member@test.dev', displayName: 'm', orgSlug: 'acme', role: 'member' });
      const [org] = await legacyDb.query<{ id: string }>("SELECT id FROM core.organizations WHERE slug = 'acme'");
      const [project] = await legacyDb.query<{ id: string }>(
        "INSERT INTO core.projects (org_id, slug, name, legacy_project_ids) VALUES ($1, 'app', 'app', ARRAY['acme/app']) RETURNING id",
        [org.id],
      );
      expect((await migrate(legacyDb)).applied).toEqual(['0002-rbac-rls']);
      const [role] = await legacyDb.query<{ role: string }>('SELECT core.project_role_of($1, $2) AS role', [project.id, member.id]);
      expect(role.role).toBe('developer');
    } finally {
      await legacyDb.close();
      await local.stop();
    }
  }, 120_000);
});

describe.skipIf(pgAvailable)('RBAC', () => {
  it.skip(pgSkipReason, () => undefined);
});
