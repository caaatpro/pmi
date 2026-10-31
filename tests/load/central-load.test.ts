/**
 * Load test (ROADMAP Phase 10): 100k memories, 20 concurrent clients doing a
 * realistic mix of context builds, searches, pushes and feed reads against
 * baton-server on real Postgres. Opt-in: BATON_LOAD_TEST=1 (minutes, not seconds).
 * Prints latency percentiles; fails on any error or when p95 exceeds the
 * budgets below.
 */
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { createOrganization, createUser, issueToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import { contentHash } from '../../src/sync/journal.js';
import { syncNamespace } from '../../src/sync/namespace.js';
import type { Observation } from '../../src/types.js';
import { pgAvailable, startPostgres, type TestPostgres } from '../central/pg-helper.js';

const ENABLED = process.env.BATON_LOAD_TEST === '1' && pgAvailable;
const MEMORIES = Number(process.env.BATON_LOAD_MEMORIES ?? 100_000);
const CLIENTS = Number(process.env.BATON_LOAD_CLIENTS ?? 20);
const DURATION_MS = Number(process.env.BATON_LOAD_SECONDS ?? 30) * 1000;
const LEGACY = 'acme/load';
const BUDGET_P95_MS: Record<string, number> = { context: 1500, search: 500, push: 1000, feed: 500 };

let pg: TestPostgres;
let db: Database;
let server: http.Server;
let base = '';
let projectId = '';
let token = '';

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function call(path: string, body?: unknown): Promise<{ status: number; ms: number }> {
  const started = performance.now();
  const res = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  await res.arrayBuffer();
  return { status: res.status, ms: performance.now() - started };
}

const WORDS = ['checkout', 'refund', 'invoice', 'cart', 'shipping', 'catalog', 'search', 'payment', 'ledger', 'tax', 'discount', 'webhook', 'session', 'cache', 'queue'];

describe.skipIf(!ENABLED)('load: 100k memories, 20 clients', () => {
  beforeAll(async () => {
    pg = await startPostgres();
    db = await openDatabase(pg.url, { max: 30 });
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    await createUser(db, { email: 'load@acme.test', displayName: 'load', orgSlug: 'acme', role: 'admin' });
    token = (await issueToken(db, { email: 'load@acme.test', name: 'load' })).token;
    server = createCentralServer({ db, version: 'load', log: () => undefined, maxAuthFailuresPerMinute: 1_000_000 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/v1/projects/resolve`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ legacy_project_id: LEGACY, create: { org: 'acme' } }) });
    projectId = (await res.json() as { project: { id: string } }).project.id;

    // Bulk seed with SQL (the push path is measured separately below).
    const started = Date.now();
    await db.query(
      `INSERT INTO memory.memories (id, project_id, legacy_project_id, category, confidence, status, title, content, facts, component,
                                    source, related_files, body, content_hash, tokens, revision, writer, version, created_at, updated_at, server_seq)
       SELECT 'p:acme%2Fload:u:seed:' || g, $1, $2,
              (ARRAY['architecture','component','issue','solution','architecture_decision','coding_convention','git_history','session_history','known_limitation','dependency'])[1 + g % 10]::memory.category,
              (ARRAY['observed','inferred','proposed','confirmed'])[1 + g % 4]::memory.confidence, 'active',
              'Memory ' || g || ' about ' || ($3::text[])[1 + g % 15] || ' and ' || ($3::text[])[1 + (g / 15) % 15],
              repeat('Narrative about ' || ($3::text[])[1 + g % 15] || ' detail ' || g || '. ', 12),
              jsonb_build_array('fact ' || g), ($3::text[])[1 + g % 15], 'agent',
              ARRAY['src/' || ($3::text[])[1 + g % 15] || '/' || (g % 200) || '.ts'],
              jsonb_build_object('id', g, 'title', 'Memory ' || g), md5(g::text) || md5((g * 7)::text), 60, 1, 'seed', 1, now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval, g
         FROM generate_series(1, $4) AS g`,
      [projectId, LEGACY, WORDS, MEMORIES],
    );
    await db.query(`INSERT INTO work.changes (project_id, seq, entity, entity_id, op) SELECT $1, g, 'memory', 'p:acme%2Fload:u:seed:' || g, 'upsert' FROM generate_series(1, $2) g`, [projectId, MEMORIES]);
    await db.query('UPDATE work.project_seq SET next_seq = $2 WHERE project_id = $1', [projectId, MEMORIES + 1]);
    await db.query('ANALYZE');
    console.log(`[load] seeded ${MEMORIES} memories in ${Date.now() - started} ms`);
  }, 600_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db?.close();
    await pg?.stop();
  });

  it('serves 20 concurrent clients within the latency budgets and without errors', async () => {
    const latencies: Record<string, number[]> = { context: [], search: [], push: [], feed: [] };
    const errors: string[] = [];
    let sequence = 0;
    const deadline = Date.now() + DURATION_MS;
    const client = async (index: number) => {
      let i = 0;
      while (Date.now() < deadline) {
        const word = WORDS[(index + i) % WORDS.length];
        const roll = (index * 7 + i) % 10;
        let kind: string;
        let result: { status: number; ms: number };
        if (roll < 4) {
          kind = 'context';
          result = await call(`/v1/projects/${projectId}/context`, { task: `fix ${word} bug in ${WORDS[(i + 3) % 15]}`, files: [`src/${word}/${i % 200}.ts`] });
        } else if (roll < 7) {
          kind = 'search';
          result = await call(`/v1/projects/${projectId}/search`, { query: `${word} ${WORDS[(i + 5) % 15]}`, limit: 20 });
        } else if (roll < 9) {
          kind = 'push';
          const seq = ++sequence;
          const rows: Observation[] = Array.from({ length: 10 }, (_, k) => ({
            id: k + 1, entityName: word, type: 'discovery', title: `Client ${index} note ${seq}-${k} about ${word}`, narrative: `Load test write ${seq}-${k}.`,
            facts: [], filesModified: [`src/${word}/${k}.ts`], concepts: [], tokens: 10, createdAt: new Date().toISOString(), projectId: LEGACY,
          }));
          result = await call('/v1/sync/push', {
            project_id: projectId,
            batch: { formatVersion: 3, namespace: syncNamespace(LEGACY), projectId: LEGACY, deviceId: `dev_load_${index}`, sequence: seq, producedAt: new Date().toISOString(),
              entries: rows.map((row) => ({ syncKey: `p:acme%2Fload:u:dev_load_${index}:${seq}-${row.id}`, kind: 'upsert', version: { revision: 1, writer: `dev_load_${index}` }, contentHash: contentHash(row), row })) },
          });
        } else {
          kind = 'feed';
          result = await call(`/v1/projects/${projectId}/changes?after=${Math.max(0, MEMORIES - 500 + i)}&limit=200&legacy=${encodeURIComponent(LEGACY)}`);
        }
        latencies[kind].push(result.ms);
        if (result.status !== 200) errors.push(`${kind} -> ${result.status}`);
        i++;
      }
    };
    const started = Date.now();
    await Promise.all(Array.from({ length: CLIENTS }, (_, index) => client(index)));
    const seconds = (Date.now() - started) / 1000;

    const summary = Object.fromEntries(Object.entries(latencies).map(([kind, values]) => [kind, {
      requests: values.length,
      p50: Math.round(percentile(values, 50)),
      p95: Math.round(percentile(values, 95)),
      p99: Math.round(percentile(values, 99)),
    }]));
    const total = Object.values(latencies).reduce((n, values) => n + values.length, 0);
    console.log(`[load] ${MEMORIES} memories, ${CLIENTS} clients, ${seconds.toFixed(1)} s, ${total} requests (${(total / seconds).toFixed(0)} req/s)`);
    console.log(`[load] ${JSON.stringify(summary)}`);
    expect(errors.slice(0, 10)).toEqual([]);
    for (const [kind, budget] of Object.entries(BUDGET_P95_MS)) expect(summary[kind].p95, `${kind} p95`).toBeLessThanOrEqual(budget);
  }, 600_000);
});

describe.skipIf(ENABLED)('load test', () => {
  it.skip('set BATON_LOAD_TEST=1 (and have Docker) to run the 100k-memory, 20-client load test', () => undefined);
});
