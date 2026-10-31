/**
 * Web UI of the central server (docs/PMI/WEB_UI.md): the built React app under
 * /ui/ with its CSP and per-request style nonce, and the read API it relies
 * on — project stats, the audit log, author emails and paging — under the same
 * RBAC and row-level security as the rest of /v1. Serving needs `npm run build`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emptySessionState } from '../../src/domain/session.js';
import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { createOrganization, createUser, issueToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import { contentHash } from '../../src/sync/journal.js';
import { syncNamespace } from '../../src/sync/namespace.js';
import type { Observation, ObservationType } from '../../src/types.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

const LEGACY = 'acme/web';
const uiBuilt = existsSync('dist/server/central/ui/index.html');
let pg: TestPostgres;
let db: Database;
let server: http.Server;
let bare: http.Server;
let base = '';
let bareBase = '';
let projectId = '';
const tokens: Record<string, string> = {};

async function call(path: string, init: { as?: string; method?: string; body?: unknown; base?: string } = {}) {
  const res = await fetch(`${init.base ?? base}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { ...(init.as ? { authorization: `Bearer ${tokens[init.as]}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body };
}

function obs(id: number, type: ObservationType, title: string, extra: Partial<Observation> = {}): Observation {
  return { id, entityName: 'web', type, title, narrative: `About ${title}.`, facts: [], filesModified: [], concepts: [], tokens: 10, createdAt: '2026-10-30T10:00:00.000Z', projectId: LEGACY, ...extra };
}

describe.skipIf(!pgAvailable)('web UI and its read API (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    for (const [name, role] of [['admin', 'admin'], ['dev', 'member'], ['viewer', 'member'], ['outsider', 'member']] as const) {
      await createUser(db, { email: `${name}@acme.test`, displayName: name, orgSlug: 'acme', role });
      tokens[name] = (await issueToken(db, { email: `${name}@acme.test`, name })).token;
    }
    server = createCentralServer({ db, version: 'test', log: () => undefined });
    bare = createCentralServer({ db, version: 'test', log: () => undefined, uiDir: null });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    bareBase = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    projectId = (await call('/v1/projects/resolve', { as: 'admin', body: { legacy_project_id: LEGACY, create: { org: 'acme' } } })).body.project.id;
    for (const [email, role] of [['dev@acme.test', 'developer'], ['viewer@acme.test', 'viewer']]) {
      await call(`/v1/projects/${projectId}/grants`, { as: 'admin', method: 'PUT', body: { user: email, role } });
    }
    const rows = [
      obs(1, 'decision', 'Prices are integer cents'),
      obs(2, 'gotcha', 'The CDN caches 404s'),
      obs(3, 'how-it-works', 'Components use CSS modules', { category: 'coding_convention' } as Partial<Observation>),
    ];
    const entries = rows.map((row) => ({ syncKey: `p:acme%2Fweb:u:dev_seed:${row.id}`, kind: 'upsert' as const, version: { revision: 1, writer: 'dev_seed' }, contentHash: contentHash(row), row }));
    const pushed = await call('/v1/sync/push', { as: 'admin', body: { project_id: projectId, batch: { formatVersion: 3, namespace: syncNamespace(LEGACY), projectId: LEGACY, deviceId: 'dev_seed', sequence: 1, producedAt: new Date().toISOString(), entries } } });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    const state = { ...emptySessionState({ sessionId: 'ses_web_1', projectId: LEGACY, deviceId: 'dev_d', agent: 'codex', task: 'Checkout page', objective: 'pay works' }), status: 'in_progress' as const };
    expect((await call(`/v1/projects/${projectId}/sessions`, { as: 'dev', body: { device_id: 'dev_d', state } })).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await new Promise<void>((resolve) => bare?.close(() => resolve()));
    await db?.close();
    await pg?.stop();
  });

  it.skipIf(!uiBuilt)('serves the built app under /ui/ with a strict CSP and a fresh style nonce per page', async () => {
    const root = await call('/');
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/ui/');

    const page = await call('/ui/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.body).toContain(`<meta name="csp-nonce" content="${nonce}">`);
    expect(page.body).not.toContain('__CSP_NONCE__');
    const again = await call('/ui/');
    expect(/'nonce-([^']+)'/.exec(again.headers.get('content-security-policy') ?? '')?.[1]).not.toBe(nonce);

    const script = /src="\/ui\/(assets\/[^"]+\.js)"/.exec(page.body)?.[1];
    const style = /href="\/ui\/(assets\/[^"]+\.css)"/.exec(page.body)?.[1];
    expect(script && style).toBeTruthy();
    const js = await call(`/ui/${script}`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await call(`/ui/${style}`)).headers.get('content-type')).toContain('text/css');

    expect((await call('/ui/%2e%2e/package.json')).status).toBe(404);
    expect((await call('/ui/../../package.json')).status).toBe(404);
    expect((await call('/ui/server.ts')).status).toBe(404);
    const head = await fetch(`${base}/ui/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    // Not GET: the UI does not answer, the API router does.
    expect((await call('/ui/', { method: 'POST', body: {} })).body.error.code).toBe('not_found');
  });

  it('never writes server data as HTML: React escapes, the UI source has no raw-HTML escape hatches', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk('src/server/central/web/src');
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/);
    }
  });

  it('can be turned off', async () => {
    expect((await call('/', { base: bareBase })).status).toBe(404);
    expect((await call('/ui/', { base: bareBase })).status).toBe(404);
    expect((await call('/health', { base: bareBase })).status).toBe(200);
  });

  it('counts knowledge, sessions and conflicts per project, as the caller may see them', async () => {
    const stats = (await call(`/v1/projects/${projectId}/stats`, { as: 'viewer' })).body.stats;
    expect(stats.memories.total).toBe(3);
    expect(Object.values(stats.memories.byCategory).reduce((a: number, b) => a + (b as number), 0)).toBe(3);
    expect(stats.memories.byCategory.coding_convention).toBe(1);
    expect(stats.memories.unconfirmed).toBe(3);
    expect(stats.memories.needsReview).toBe(0);
    expect(stats.memories.lastUpdatedAt).toEqual(expect.any(String));
    expect(stats.sessions).toEqual({ total: 1, byStatus: { in_progress: 1 } });
    expect(stats.openConflicts).toBe(0);
    expect(stats.git).toEqual([]);

    expect((await call(`/v1/projects/${projectId}/stats`, { as: 'outsider' })).status).toBe(404);
    expect((await call(`/v1/projects/${projectId}/stats`)).status).toBe(401);
  });

  it('confirming and deprecating from the UI moves the counts, and the people show by email', async () => {
    const { memories } = (await call(`/v1/projects/${projectId}/memories?limit=10`, { as: 'dev' })).body;
    expect(memories).toHaveLength(3);
    expect(memories.every((memory: any) => memory.authorEmail === 'admin@acme.test')).toBe(true);

    expect((await call(`/v1/memories/${encodeURIComponent(memories[0].id)}/confirm`, { as: 'viewer', body: {} })).status).toBe(403);
    expect((await call(`/v1/memories/${encodeURIComponent(memories[0].id)}/confirm`, { as: 'dev', body: { reason: 'checked in code' } })).status).toBe(200);
    expect((await call(`/v1/memories/${encodeURIComponent(memories[1].id)}/deprecate`, { as: 'dev', body: { reason: 'CDN replaced' } })).status).toBe(200);

    const stats = (await call(`/v1/projects/${projectId}/stats`, { as: 'dev' })).body.stats;
    expect(stats.memories.byConfidence.confirmed).toBe(1);
    expect(stats.memories.byConfidence.deprecated).toBe(1);
    expect(stats.memories.unconfirmed).toBe(1);

    const detail = (await call(`/v1/memories/${encodeURIComponent(memories[0].id)}?include=versions`, { as: 'viewer' })).body;
    expect(detail.versions[0]).toMatchObject({ changedByEmail: 'dev@acme.test', reason: expect.stringContaining('checked in code') });
  });

  it('pages the knowledge list', async () => {
    const first = (await call(`/v1/projects/${projectId}/memories?limit=2`, { as: 'viewer' })).body.memories;
    const rest = (await call(`/v1/projects/${projectId}/memories?limit=2&offset=2`, { as: 'viewer' })).body.memories;
    expect(first).toHaveLength(2);
    expect(rest).toHaveLength(1);
    expect(new Set([...first, ...rest].map((memory: any) => memory.id)).size).toBe(3);
  });

  it('shows the audit log to maintainers and admins only, newest first, in pages', async () => {
    expect((await call(`/v1/projects/${projectId}/audit`, { as: 'viewer' })).status).toBe(403);
    expect((await call(`/v1/projects/${projectId}/audit`, { as: 'dev' })).status).toBe(403);
    expect((await call(`/v1/projects/${projectId}/audit`, { as: 'outsider' })).status).toBe(404);

    const all = (await call(`/v1/projects/${projectId}/audit?limit=100`, { as: 'admin' })).body.entries;
    const actions = all.map((entry: any) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(['memory.confirm', 'memory.deprecate', 'session.start', 'sync.push']));
    expect(all[0].id).toBeGreaterThan(all.at(-1).id);
    expect(all.find((entry: any) => entry.action === 'memory.confirm')).toMatchObject({ actorEmail: 'dev@acme.test', targetType: 'memory' });

    const page = (await call(`/v1/projects/${projectId}/audit?limit=1&before=${all[0].id}`, { as: 'admin' })).body.entries;
    expect(page).toEqual([all[1]]);
  });

});

describe.skipIf(pgAvailable)('web UI and its read API', () => {
  it.skip(pgSkipReason, () => undefined);
});
