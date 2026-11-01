/**
 * Server context engine on real Postgres + pgvector, including acceptance
 * TEST 6: a project with 500 memories and 200 sessions gets a context
 * package within budget (receipt tokensTotal ≤ 2300) that holds no
 * session_history or other L3 material.
 */
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emptySessionState } from '../../src/domain/session.js';
import { openDatabase, type Database } from '../../src/server/central/db.js';
import { EMBEDDING_DIMENSIONS, embedPending, type ServerEmbeddings } from '../../src/server/central/context-repo.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { createOrganization, createUser, issueToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import { contentHash } from '../../src/sync/journal.js';
import { syncNamespace } from '../../src/sync/namespace.js';
import type { ObservationType, Observation } from '../../src/types.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

const LEGACY = 'acme/shop';
let pg: TestPostgres;
let db: Database;
let server: http.Server;
let base = '';
let projectId = '';
const tokens: Record<string, string> = {};
let sequence = 0;

/**
 * Deterministic embeddings for tests: character trigrams hashed into 384
 * dimensions, so "refund" and "refunds" are close while keyword search
 * (simple config, no stemming) treats them as different words.
 */
const trigramEmbeddings: ServerEmbeddings = {
  name: 'test-trigram',
  dimensions: EMBEDDING_DIMENSIONS,
  async embedBatch(texts) {
    return texts.map((text) => {
      const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
      const clean = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
      for (let i = 0; i + 3 <= clean.length; i++) {
        let hash = 0;
        for (const char of clean.slice(i, i + 3)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        vector[hash % EMBEDDING_DIMENSIONS] += 1;
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map((value) => value / norm);
    });
  },
};

async function call(path: string, init: { as: string; method?: string; body?: unknown }) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${tokens[init.as]}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, body };
}

function obs(id: number, type: ObservationType, title: string, narrative: string, extra: Partial<Observation> = {}): Observation {
  return { id, entityName: extra.entityName ?? 'shop', type, title, narrative, facts: [`fact about ${title}`], filesModified: [], concepts: [], tokens: 40, createdAt: '2026-10-20T10:00:00.000Z', projectId: LEGACY, ...extra };
}

async function pushAll(rows: Observation[]) {
  for (let i = 0; i < rows.length; i += 100) {
    sequence++;
    const entries = rows.slice(i, i + 100).map((row) => ({ syncKey: `p:acme%2Fshop:u:dev_seed:${row.id}`, kind: 'upsert' as const, version: { revision: 1, writer: 'dev_seed' }, contentHash: contentHash(row), row }));
    const res = await call('/v1/sync/push', { as: 'admin', body: { project_id: projectId, batch: { formatVersion: 3, namespace: syncNamespace(LEGACY), projectId: LEGACY, deviceId: 'dev_seed', sequence, producedAt: new Date().toISOString(), entries } } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
}

describe.skipIf(!pgAvailable)('server context engine (real Postgres + pgvector)', () => {
  beforeAll(async () => {
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    for (const [name, role] of [['admin', 'admin'], ['viewer', 'member']] as const) {
      await createUser(db, { email: `${name}@acme.test`, displayName: name, orgSlug: 'acme', role });
      tokens[name] = (await issueToken(db, { email: `${name}@acme.test`, name })).token;
    }
    server = createCentralServer({ db, version: 'test', log: () => undefined, embeddings: trigramEmbeddings, overviewMinAgeSeconds: 0, metricsToken: 'metrics-secret' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    projectId = (await call('/v1/projects/resolve', { as: 'admin', body: { legacy_project_id: LEGACY, create: { org: 'acme' } } })).body.project.id;
    await call(`/v1/projects/${projectId}/grants`, { as: 'admin', method: 'PUT', body: { user: 'viewer@acme.test', role: 'viewer' } });

    const types: ObservationType[] = ['how-it-works', 'decision', 'problem-solution', 'gotcha', 'discovery', 'what-changed', 'session-request', 'trade-off'];
    const rows: Observation[] = [];
    for (let i = 1; i <= 492; i++) {
      rows.push(obs(i, types[i % types.length], `Topic ${i}: ${['catalog', 'search', 'cart', 'checkout', 'shipping', 'payments'][i % 6]} detail ${i}`,
        `Narrative ${i} `.repeat(30), { entityName: ['catalog', 'search', 'cart', 'checkout', 'shipping', 'payments'][i % 6] }));
    }
    rows.push(obs(493, 'how-it-works', 'Shop is a modular monolith', 'Services: catalog, cart, checkout, payments; one Postgres.', { category: 'project_overview' }));
    rows.push(obs(494, 'how-it-works', 'Money is stored as integer cents', 'Never floats for money.', { category: 'coding_convention' }));
    rows.push(obs(495, 'decision', 'Refunds are ledger entries', 'Refunds are recorded as ledger entries, never as negative payments.', { entityName: 'payments', filesModified: ['src/payments/refund.ts'] }));
    rows.push(obs(496, 'problem-solution', 'Rounding drift on partial refunds', 'Partial refunds drifted by a cent; fixed with banker rounding.', { entityName: 'payments', filesModified: ['src/payments/refund.ts'] }));
    rows.push(obs(497, 'gotcha', 'Webhook retries can duplicate refunds', 'Payment provider retries webhooks; dedupe by event id.', { entityName: 'payments' }));
    rows.push(obs(498, 'session-request', 'Session 41 asked about refunds UI', 'Old session request.', {}));
    rows.push(obs(499, 'decision', 'Use Kafka for events', 'Superseded idea.', {}));
    rows.push(obs(500, 'how-it-works', 'Search uses Postgres FTS', 'Full text search via tsvector.', { entityName: 'search' }));
    await pushAll(rows);
    // A person confirms two decisions; one older idea is deprecated.
    for (const [id, action] of [[495, 'confirm'], [494, 'confirm'], [499, 'deprecate']] as const) {
      const res = await call(`/v1/memories/${encodeURIComponent(`p:acme%2Fshop:u:dev_seed:${id}`)}/${action}`, { as: 'admin', body: {} });
      expect(res.status).toBe(200);
    }
    // 200 sessions, mostly finished.
    for (let i = 0; i < 200; i++) {
      const state = { ...emptySessionState({ sessionId: `ses_seed_${i}`, projectId: LEGACY, deviceId: 'dev_seed', agent: 'codex', task: `Old task ${i}` }), status: 'in_progress' as const };
      await call(`/v1/projects/${projectId}/sessions`, { as: 'admin', body: { device_id: 'dev_seed', state } });
      if (i < 190) await call(`/v1/sessions/ses_seed_${i}/finish`, { as: 'admin', body: { device_id: 'dev_seed', status: 'completed', summary: `Finished old task ${i}` } });
    }
    while (await embedPending(db, trigramEmbeddings, 200) > 0) { /* embed everything */ }
  }, 240_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db?.close();
    await pg?.stop();
  });

  it('TEST 6: session start + context build stay within budget and hold no history', async () => {
    const live = { ...emptySessionState({ sessionId: 'ses_live', projectId: LEGACY, deviceId: 'dev_a', agent: 'claude-code', task: 'Fix rounding of partial refunds' }), status: 'in_progress' as const,
      nextAction: 'Reproduce the cent drift', git: { branch: 'fix/refunds', head: 'a'.repeat(40), unpushedCommits: [], dirty: true, modifiedFiles: [{ path: 'src/payments/refund.ts', status: 'M' as const }] } };
    expect((await call(`/v1/projects/${projectId}/sessions`, { as: 'admin', body: { device_id: 'dev_a', state: live } })).status).toBe(200);

    const res = await call(`/v1/projects/${projectId}/context`, { as: 'admin', body: { task: 'Fix rounding of partial refunds', session_id: 'ses_live' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const pkg = res.body;
    expect(pkg.receipt.tokensTotal).toBeLessThanOrEqual(2_300);
    expect(pkg.receipt.tokensByLevel.L3).toBe(0);
    expect(pkg.text).not.toContain('## History');
    const included = new Set(pkg.included.map((entry: { id: string }) => entry.id));
    const historyIds = (await db.query<{ id: string }>("SELECT id FROM memory.memories WHERE category IN ('session_history') OR confidence = 'deprecated'")).map((row) => row.id);
    expect(historyIds.length).toBeGreaterThan(50);
    expect(historyIds.filter((id) => included.has(id))).toEqual([]);
    expect(pkg.text).not.toContain('Old task');
    // What the task needs is there: the confirmed decision, the fix, the convention, the session's next action.
    expect(pkg.text).toContain('Refunds are ledger entries');
    expect(pkg.text).toContain('Rounding drift on partial refunds');
    expect(pkg.text).toContain('Money is stored as integer cents');
    expect(pkg.text).toContain('Next action: Reproduce the cent drift');
    expect(pkg.receipt.lens).toBe('bugfix');
  });

  it('hybrid search: semantic matches what keywords miss, fused with RRF', async () => {
    const keywordOnly = await db.asUser((await db.query<{ id: string }>("SELECT id FROM core.users WHERE email = 'admin@acme.test'"))[0].id, async (tx) => {
      const { hybridSearch } = await import('../../src/server/central/context-repo.js');
      return hybridSearch(tx, [projectId], 'refund', { limit: 10 });
    });
    expect(keywordOnly.map((hit) => hit.id)).not.toContain('p:acme%2Fshop:u:dev_seed:495');
    const res = await call(`/v1/projects/${projectId}/search`, { as: 'viewer', body: { query: 'refund', limit: 10 } });
    expect(res.body.mode).toBe('hybrid');
    const hit = res.body.results.find((row: { title: string }) => row.title === 'Refunds are ledger entries');
    expect(hit).toMatchObject({ keywordRank: null });
    expect(hit.semanticRank).toBeGreaterThan(0);
    const deprecatedHidden = res.body.results.some((row: { title: string }) => row.title === 'Use Kafka for events');
    expect(deprecatedHidden).toBe(false);
  });

  it('caches the L1 overview and rebuilds it when overview knowledge changes', async () => {
    const first = await call(`/v1/projects/${projectId}/overview`, { as: 'viewer' });
    const second = await call(`/v1/projects/${projectId}/overview`, { as: 'viewer' });
    expect(second.body).toMatchObject({ cacheHit: true, overview: first.body.overview });
    expect(first.body.overview).toContain('Shop is a modular monolith');
    expect(first.body.overview).toContain('Money is stored as integer cents');
    expect(first.body.tokens).toBeLessThanOrEqual(800);
    await pushAll([obs(501, 'how-it-works', 'All prices include VAT', 'Prices shown include VAT.', { category: 'coding_convention' })]);
    const rebuilt = await call(`/v1/projects/${projectId}/overview`, { as: 'viewer' });
    expect(rebuilt.body.cacheHit).toBe(false);
    expect(rebuilt.body.overview).toContain('All prices include VAT');
  });

  it('serves L3 history only when asked', async () => {
    const res = await call(`/v1/projects/${projectId}/context`, { as: 'viewer', body: { task: 'refunds ledger history', levels: ['L1', 'L2', 'L3'], budget_tokens: 3000 } });
    expect(res.body.text).toContain('## History');
    const history = res.body.text.slice(res.body.text.indexOf('## History'));
    expect(history).toMatch(/Session: Old task \d+ \[completed\]/);
    expect(history).not.toContain('Topic 6:');
    expect(res.body.receipt.tokensTotal).toBeLessThanOrEqual(3000);
  });

  it('lets viewers build context but only developers attach a session', async () => {
    expect((await call(`/v1/projects/${projectId}/context`, { as: 'viewer', body: { task: 'checkout' } })).status).toBe(200);
    expect((await call(`/v1/projects/${projectId}/context`, { as: 'viewer', body: { task: 'checkout', session_id: 'ses_live' } })).status).toBe(403);
  });

  it('exposes Prometheus metrics behind a token', async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const res = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer metrics-secret' } });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toMatch(/baton_context_builds_total \d+/);
    expect(text).toMatch(/baton_memories\{category="architecture_decision"\} \d+/);
    expect(text).toMatch(/baton_sessions\{status="completed"\} 190/);
    expect(text).toContain('baton_http_requests_total{route="/v1/projects/:id/context",status="200"}');
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM work.metrics_events WHERE name = 'context_tokens' AND session_id = 'ses_live'");
    expect(n).toBe(1);
  });
});

describe.skipIf(pgAvailable)('server context engine', () => {
  it.skip(pgSkipReason, () => undefined);
});
