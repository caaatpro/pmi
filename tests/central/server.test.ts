import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { addOrgMember, createOrganization, createUser, issueToken } from '../../src/server/central/identity.js';
import { PG_MIGRATIONS, migrate, pendingMigrations } from '../../src/server/central/migrations.js';
import { contentHash } from '../../src/sync/journal.js';
import { syncNamespace } from '../../src/sync/namespace.js';
import type { ChangeBatch, ChangeEntry } from '../../src/sync/types.js';
import type { Observation } from '../../src/types.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

const LEGACY = 'acme/app';
let pg: TestPostgres;
let db: Database;
let server: http.Server;
let base = '';
let adminToken = '';
let memberToken = '';
let outsiderToken = '';
let projectId = '';

async function call(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: await res.json() as any };
}

function obs(id: number, extra: Partial<Observation> = {}): Observation {
  return {
    id,
    entityName: 'billing',
    type: 'decision',
    title: `Use idempotency keys ${id}`,
    narrative: 'Every POST that creates an entity accepts an Idempotency-Key.',
    facts: ['retries are safe'],
    filesModified: ['src/billing.ts'],
    concepts: [],
    tokens: 20,
    createdAt: '2026-10-30T10:00:00.000Z',
    projectId: LEGACY,
    ...extra,
  };
}

function upsert(syncKey: string, row: Observation, revision: number, writer: string): ChangeEntry {
  return { syncKey, kind: 'upsert', version: { revision, writer }, contentHash: contentHash(row), row };
}

function batch(deviceId: string, sequence: number, entries: ChangeEntry[]): ChangeBatch {
  return { formatVersion: 3, namespace: syncNamespace(LEGACY), projectId: LEGACY, deviceId, sequence, producedAt: new Date().toISOString(), entries };
}

describe.skipIf(!pgAvailable)('central server (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    expect((await migrate(db)).applied).toEqual(PG_MIGRATIONS.map((migration) => migration.id));
    await createOrganization(db, 'acme', 'Acme');
    await createOrganization(db, 'other', 'Other');
    await createUser(db, { email: 'lead@acme.test', displayName: 'Lead', orgSlug: 'acme', role: 'admin' });
    await createUser(db, { email: 'dev@acme.test', displayName: 'Dev', orgSlug: 'acme', role: 'member' });
    const outsider = await createUser(db, { email: 'eve@other.test', displayName: 'Eve', orgSlug: 'other', role: 'owner' });
    expect(outsider.id).toBeTruthy();
    adminToken = (await issueToken(db, { email: 'lead@acme.test', name: 'test' })).token;
    memberToken = (await issueToken(db, { email: 'dev@acme.test', name: 'test' })).token;
    outsiderToken = (await issueToken(db, { email: 'eve@other.test', name: 'test' })).token;
    server = createCentralServer({ db, version: 'test', log: () => undefined });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db?.close();
    await pg?.stop();
  });

  it('migrations are idempotent and the server reports ready', async () => {
    expect((await migrate(db)).applied).toEqual([]);
    expect(await pendingMigrations(db)).toEqual([]);
    expect(await call('/health')).toMatchObject({ status: 200, body: { status: 'ok' } });
    expect(await call('/ready')).toMatchObject({ status: 200, body: { status: 'ready' } });
  });

  it('rejects requests without a valid token', async () => {
    expect((await call('/v1/me')).status).toBe(401);
    expect((await call('/v1/me', { token: 'pmi_pat_nope' })).status).toBe(401);
  });

  it('lets only org admins create a project, then resolves it for members', async () => {
    const denied = await call('/v1/projects/resolve', { token: memberToken, body: { legacy_project_id: LEGACY, create: {} } });
    expect(denied.status).toBe(403);

    const created = await call('/v1/projects/resolve', {
      token: adminToken,
      body: { legacy_project_id: LEGACY, root_commit: 'a'.repeat(40), create: { org: 'acme', slug: 'app' } },
    });
    expect(created.status).toBe(201);
    projectId = created.body.project.id;

    // Phase 5: organization membership alone does not open a project.
    const hidden = await call('/v1/projects/resolve', { token: memberToken, body: { legacy_project_id: LEGACY } });
    expect(hidden.status).toBe(404);
    const granted = await call(`/v1/projects/${projectId}/grants`, { method: 'PUT', token: adminToken, body: { user: 'dev@acme.test', role: 'developer' } });
    expect(granted.status).toBe(200);

    const resolved = await call('/v1/projects/resolve', { token: memberToken, body: { legacy_project_id: LEGACY } });
    expect(resolved).toMatchObject({ status: 200, body: { created: false, project: { id: projectId, slug: 'app' } } });

    const mismatch = await call('/v1/projects/resolve', { token: memberToken, body: { legacy_project_id: 'fork/app', root_commit: 'a'.repeat(40) } });
    expect(mismatch).toMatchObject({ status: 409, body: { error: { code: 'identity_mismatch' } } });

    const me = await call('/v1/me', { token: memberToken });
    expect(me.body.projects.map((p: { id: string }) => p.id)).toEqual([projectId]);
  });

  it('materializes pushed memories with PMI classification and history', async () => {
    const row = obs(1);
    const pushed = await call('/v1/sync/push', {
      token: memberToken,
      body: { project_id: projectId, batch: batch('dev_a', 1, [upsert('p:acme%2Fapp:u:dev_a:1', row, 1, 'dev_a')]) },
    });
    expect(pushed.status).toBe(200);
    expect(pushed.body.results).toEqual([{ syncKey: 'p:acme%2Fapp:u:dev_a:1', outcome: 'applied', conflict: false }]);

    const again = await call('/v1/sync/push', {
      token: memberToken,
      body: { project_id: projectId, batch: batch('dev_a', 1, [upsert('p:acme%2Fapp:u:dev_a:1', row, 1, 'dev_a')]) },
    });
    expect(again.body.results[0].outcome).toBe('duplicate');

    const list = await call(`/v1/projects/${projectId}/memories?category=architecture_decision`, { token: memberToken });
    expect(list.body.memories).toHaveLength(1);
    expect(list.body.memories[0]).toMatchObject({ confidence: 'proposed', component: 'billing', relatedFiles: ['src/billing.ts'], version: 1 });

    const updated = obs(1, { narrative: 'Idempotency keys expire after 24 hours.' });
    await call('/v1/sync/push', {
      token: memberToken,
      body: { project_id: projectId, batch: batch('dev_a', 2, [upsert('p:acme%2Fapp:u:dev_a:1', updated, 2, 'dev_a')]) },
    });
    const detail = await call(`/v1/memories/${encodeURIComponent('p:acme%2Fapp:u:dev_a:1')}?include=versions`, { token: memberToken });
    expect(detail.body.memory).toMatchObject({ version: 2, content: 'Idempotency keys expire after 24 hours.' });
    expect(detail.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it('serves only the latest change per memory in the feed', async () => {
    const feed = await call(`/v1/projects/${projectId}/changes?after=0&legacy=${encodeURIComponent(LEGACY)}`, { token: memberToken });
    expect(feed.status).toBe(200);
    expect(feed.body.changes).toHaveLength(1);
    expect(feed.body.changes[0].entry.version).toEqual({ revision: 2, writer: 'dev_a' });
    const after = await call(`/v1/projects/${projectId}/changes?after=${feed.body.lastSeq}&legacy=${encodeURIComponent(LEGACY)}`, { token: memberToken });
    expect(after.body).toMatchObject({ changes: [], hasMore: false });
  });

  it('records concurrent edits as conflicts and keeps the deterministic winner', async () => {
    const key = 'p:acme%2Fapp:t:billing-retries';
    const fromA = obs(5, { topicKey: 'billing-retries', narrative: 'Retry three times.' });
    const fromB = obs(9, { topicKey: 'billing-retries', narrative: 'Retry five times.' });
    await call('/v1/sync/push', { token: memberToken, body: { project_id: projectId, batch: batch('dev_a', 3, [upsert(key, fromA, 1, 'dev_a')]) } });
    const second = await call('/v1/sync/push', { token: memberToken, body: { project_id: projectId, batch: batch('dev_b', 1, [upsert(key, fromB, 1, 'dev_b')]) } });
    expect(second.body.results[0]).toMatchObject({ outcome: 'applied', conflict: true });
    const conflicts = await call(`/v1/projects/${projectId}/conflicts`, { token: memberToken });
    expect(conflicts.body.conflicts).toHaveLength(1);
    expect(conflicts.body.conflicts[0]).toMatchObject({ kind: 'concurrent_edit', memoryId: key });
    expect(conflicts.body.conflicts[0].winner.version.writer).toBe('dev_b');
  });

  it('refuses memories that carry credentials', async () => {
    const leaked = obs(7, { narrative: 'Connect with api_key=sk_live_abcdef123456 for now.' });
    const result = await call('/v1/sync/push', {
      token: memberToken,
      body: { project_id: projectId, batch: batch('dev_a', 4, [upsert('p:acme%2Fapp:u:dev_a:7', leaked, 1, 'dev_a')]) },
    });
    expect(result.body.results[0]).toMatchObject({ outcome: 'rejected', reason: 'contains a credential-like value' });
    const [row] = await db.query('SELECT id FROM memory.memories WHERE id = $1', ['p:acme%2Fapp:u:dev_a:7']);
    expect(row).toBeUndefined();
  });

  it('keeps tombstones so stale upserts cannot resurrect a memory', async () => {
    const key = 'p:acme%2Fapp:u:dev_a:1';
    await call('/v1/sync/push', {
      token: memberToken,
      body: { project_id: projectId, batch: batch('dev_a', 5, [{ syncKey: key, kind: 'tombstone', version: { revision: 3, writer: 'dev_a' }, contentHash: '' }]) },
    });
    const stale = await call('/v1/sync/push', {
      token: memberToken,
      body: { project_id: projectId, batch: batch('dev_c', 1, [upsert(key, obs(1), 2, 'dev_c')]) },
    });
    expect(stale.body.results[0].outcome).toBe('stale');
    const list = await call(`/v1/projects/${projectId}/memories?category=architecture_decision`, { token: memberToken });
    expect(list.body.memories.map((m: { id: string }) => m.id)).not.toContain(key);
  });

  it('hides projects of other organizations and rejects invalid input', async () => {
    expect((await call(`/v1/projects/${projectId}`, { token: outsiderToken })).status).toBe(404);
    expect((await call(`/v1/projects/${projectId}/changes?legacy=x`, { token: outsiderToken })).status).toBe(404);
    const push = await call('/v1/sync/push', { token: outsiderToken, body: { project_id: projectId, batch: batch('dev_x', 1, []) } });
    expect(push.status).toBe(404);
    const invalid = await call('/v1/sync/push', { token: memberToken, body: { project_id: 'nope' } });
    expect(invalid).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
  });

  it('writes an audit trail without memory content', async () => {
    const rows = await db.query<{ action: string; detail: Record<string, unknown> }>(
      "SELECT action, detail FROM core.audit_log WHERE project_id = $1 AND action = 'sync.push' ORDER BY id",
      [projectId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('Idempotency');
  });

  it('lets a member create projects after being promoted to admin', async () => {
    const [dev] = await db.query<{ id: string }>("SELECT id FROM core.users WHERE email = 'dev@acme.test'");
    await addOrgMember(db, 'acme', dev.id, 'admin');
    const ok = await call('/v1/projects/resolve', { token: memberToken, body: { legacy_project_id: 'acme/tools', create: { org: 'acme' } } });
    expect(ok.status).toBe(201);
  });
});

describe.skipIf(pgAvailable)('central server', () => {
  it.skip(pgSkipReason, () => undefined);
});
