/**
 * Acceptance TEST 1 — knowledge moves between people, agents and machines.
 *
 * Alice works with Claude Code on machine A and Bob with Codex on machine B;
 * they are different PMI users. Alice's agent records an architecture
 * decision over MCP; after `pmi sync` on both machines, Bob's agent asks for
 * project context for a related task and receives the decision without
 * reading or searching any project file.
 *
 * Phase 5 uses today's MCP tools (`memorix_store`, `memorix_project_context`);
 * the PMI names `decision_log` / `context_build` arrive with Phase 8.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { createOrganization, createUser, issueToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import { cliBuilt, connectAgent, createRepoPair, machine, pmi, toolText, type Machine, stopDaemons } from './cli-helper.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

const DECISION_TITLE = 'Payment webhooks are verified with HMAC-SHA256 before parsing';

let root = '';
let pg: TestPostgres;
let db: Database;
let server: http.Server;
let serverUrl = '';
let alice: Machine;
let bob: Machine;
const users: Record<string, { id: string; token: string }> = {};

describe.skipIf(!pgAvailable || !cliBuilt)('TEST 1: a decision recorded by one user\'s agent reaches another user\'s agent', () => {
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'pmi-test1-'));
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    for (const [name, role] of [['alice', 'admin'], ['bob', 'member']] as const) {
      const user = await createUser(db, { email: `${name}@acme.test`, displayName: name, orgSlug: 'acme', role });
      users[name] = { id: user.id, token: (await issueToken(db, { email: `${name}@acme.test`, name })).token };
    }
    server = createCentralServer({ db, version: 'test', log: () => undefined });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const [repoA, repoB] = createRepoPair(root, 'https://github.com/acme/payments.git');
    alice = machine(root, 'alice', repoA);
    bob = machine(root, 'bob', repoB);
  }, 180_000);

  afterAll(async () => {
    await stopDaemons([alice, bob]);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db?.close();
    await pg?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('connects both users to one project, Bob through an explicit grant', async () => {
    expect((await pmi(alice, 'login', serverUrl, '--token', users.alice.token)).code).toBe(0);
    expect((await pmi(bob, 'login', serverUrl, '--token', users.bob.token)).code).toBe(0);
    const created = await pmi(alice, 'project', 'link', '--create', '--org', 'acme', '--slug', 'payments', '--json');
    expect(created.code, created.stderr).toBe(0);

    const before = await pmi(bob, 'project', 'link', '--json');
    expect(before.code).toBe(1);
    expect(before.stderr).toContain('no project on the server matches');

    const grant = await fetch(`${serverUrl}/v1/projects/${created.json.projectId}/grants`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${users.alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'bob@acme.test', role: 'developer' }),
    });
    expect(grant.status).toBe(200);
    const linked = await pmi(bob, 'project', 'link', '--json');
    expect(linked.code, linked.stderr).toBe(0);
    expect(linked.json.projectId).toBe(created.json.projectId);
  }, 120_000);

  it('Bob\'s Codex receives Alice\'s Claude Code decision as project context', async () => {
    const claude = await connectAgent(alice, 'claude-code');
    try {
      await claude.callTool({ name: 'memorix_session_start', arguments: { agent: 'claude-code' } });
      const stored = await claude.callTool({
        name: 'memorix_store',
        arguments: {
          entityName: 'payment-webhooks',
          type: 'decision',
          title: DECISION_TITLE,
          narrative: 'Incoming payment provider webhooks must pass HMAC-SHA256 signature verification on the raw body before any JSON parsing; unverified requests get 401.',
          facts: ['verify signature on raw body', 'reject unverified webhooks with 401'],
          filesModified: ['src/webhooks/payment.ts'],
        },
      });
      expect(stored.isError, toolText(stored)).toBeFalsy();
    } finally {
      await claude.close();
    }

    const pushed = await pmi(alice, 'sync', '--json');
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(pushed.json.pushed).toBeGreaterThanOrEqual(1);

    const [row] = await db.query<{ author_user_id: string; category: string; confidence: string }>(
      'SELECT author_user_id, category, confidence FROM memory.memories WHERE title = $1',
      [DECISION_TITLE],
    );
    expect(row).toEqual({ author_user_id: users.alice.id, category: 'architecture_decision', confidence: 'proposed' });

    const pulled = await pmi(bob, 'sync', '--json');
    expect(pulled.code, pulled.stderr).toBe(0);
    expect(pulled.json.applied).toBeGreaterThanOrEqual(1);

    const codex = await connectAgent(bob, 'codex');
    try {
      await codex.callTool({ name: 'memorix_session_start', arguments: { agent: 'codex' } });
      const context = await codex.callTool({
        name: 'memorix_project_context',
        arguments: { task: 'add a webhook endpoint for the new payment provider', agent: 'codex' },
      });
      expect(context.isError, toolText(context)).toBeFalsy();
      expect(toolText(context)).toContain(DECISION_TITLE);
    } finally {
      await codex.close();
    }
  }, 180_000);

  it('Bob confirms the decision and Alice\'s machine receives the confirmation', async () => {
    const [row] = await db.query<{ id: string }>('SELECT id FROM memory.memories WHERE title = $1', [DECISION_TITLE]);
    const confirmed = await fetch(`${serverUrl}/v1/memories/${encodeURIComponent(row.id)}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${users.bob.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'matches the provider integration guide' }),
    });
    expect(confirmed.status).toBe(200);

    const pulled = await pmi(alice, 'sync', '--json');
    expect(pulled.code, pulled.stderr).toBe(0);
    expect(pulled.json.applied).toBe(1);
    const again = await pmi(alice, 'sync', '--json');
    expect(again.json).toMatchObject({ pushed: 0, applied: 0 });
  }, 120_000);
});

describe.skipIf(pgAvailable && cliBuilt)('TEST 1', () => {
  it.skip(`${pgSkipReason}; also requires \`npm run build\``, () => undefined);
});
