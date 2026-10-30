import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emptySessionState, type SessionState } from '../../src/domain/session.js';
import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { createOrganization, createUser, issueToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

let pg: TestPostgres;
let db: Database;
let server: http.Server;
let base = '';
let projectId = '';
const tokens: Record<string, string> = {};

async function call(path: string, init: { method?: string; as?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { ...(init.as ? { authorization: `Bearer ${tokens[init.as]}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

function state(id: string, extra: Partial<SessionState> = {}): SessionState {
  return { ...emptySessionState({ sessionId: id, projectId: 'acme/app', deviceId: 'x', agent: 'claude-code', task: 'Add refunds', objective: 'refund e2e passes' }), ...extra };
}

async function start(as: string, device: string, id: string, extra: Partial<SessionState> = {}) {
  return call(`/v1/projects/${projectId}/sessions`, { as, body: { device_id: device, state: state(id, { status: 'in_progress', ...extra }) } });
}

async function checkpoint(as: string, device: string, id: string, seq: number, extra: Partial<SessionState> = {}, trigger = 'manual') {
  return call(`/v1/sessions/${id}/checkpoints`, {
    as,
    body: { device_id: device, id: `${id}:${seq}`, seq, trigger, created_at: new Date().toISOString(), state: state(id, { status: 'checkpointed', ...extra }) },
  });
}

describe.skipIf(!pgAvailable)('central sessions (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    for (const [name, role] of [['alice', 'admin'], ['bob', 'member'], ['vera', 'member'], ['maint', 'member']] as const) {
      await createUser(db, { email: `${name}@acme.test`, displayName: name, orgSlug: 'acme', role });
      tokens[name] = (await issueToken(db, { email: `${name}@acme.test`, name })).token;
    }
    server = createCentralServer({ db, version: 'test', log: () => undefined, leaseTtlSeconds: 2 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    projectId = (await call('/v1/projects/resolve', { as: 'alice', body: { legacy_project_id: 'acme/app', create: { org: 'acme' } } })).body.project.id;
    for (const [email, role] of [['bob@acme.test', 'developer'], ['vera@acme.test', 'viewer'], ['maint@acme.test', 'maintainer']]) {
      await call(`/v1/projects/${projectId}/grants`, { method: 'PUT', as: 'alice', body: { user: email, role } });
    }
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db?.close();
    await pg?.stop();
  });

  it('keeps parallel sessions of different users independent (TEST 7, server side)', async () => {
    expect((await start('alice', 'dev_a', 'ses_par_a', { task: 'Refunds' })).status).toBe(200);
    expect((await start('bob', 'dev_b', 'ses_par_b', { agent: 'codex', task: 'Invoices' })).status).toBe(200);
    expect((await checkpoint('alice', 'dev_a', 'ses_par_a', 1, { completedSteps: [{ id: '1', text: 'refund table', at: 'x' }] })).body.outcome).toBe('applied');
    expect((await checkpoint('bob', 'dev_b', 'ses_par_b', 1, { completedSteps: [{ id: '1', text: 'invoice pdf', at: 'x' }] })).body.outcome).toBe('applied');

    const list = await call(`/v1/projects/${projectId}/sessions?status=in_progress,checkpointed`, { as: 'alice' });
    const byId = Object.fromEntries(list.body.sessions.map((s: any) => [s.id, s]));
    expect(byId.ses_par_a.status).toBe('checkpointed');
    expect(byId.ses_par_b.status).toBe('checkpointed');
    expect(byId.ses_par_a.state.completedSteps.map((s: any) => s.text)).toEqual(['refund table']);
    expect(byId.ses_par_b.state.completedSteps.map((s: any) => s.text)).toEqual(['invoice pdf']);

    // Neither user can write into the other's session.
    expect((await checkpoint('bob', 'dev_b', 'ses_par_a', 2)).status).toBe(403);
  });

  it('lets only the lease holder write and refuses resume while the lease is live', async () => {
    expect((await checkpoint('alice', 'dev_other', 'ses_par_a', 2)).body.outcome).toBe('orphan');
    const resume = await call('/v1/sessions/ses_par_a/resume', { as: 'bob', body: { device_id: 'dev_b' } });
    expect(resume).toMatchObject({ status: 409, body: { error: { code: 'lease_held' } } });
    expect((await call('/v1/sessions/ses_par_a/resume', { as: 'bob', body: { device_id: 'dev_b', force: true } })).status).toBe(403);
  });

  it('hands off: brief stored, lease released, status resumable; another user resumes into a child session', async () => {
    await checkpoint('alice', 'dev_a', 'ses_par_a', 3, {
      status: 'waiting_handoff',
      completedSteps: [{ id: '1', text: 'refund table', at: 'x' }, { id: '2', text: 'refund service', at: 'x' }],
      pendingSteps: [{ id: '3', text: 'POST /refunds endpoint', at: 'x' }],
      nextAction: 'Write the POST /refunds handler',
      git: { branch: 'feat/refunds', head: 'a'.repeat(40), unpushedCommits: [], dirty: true, modifiedFiles: [{ path: 'src/refunds.ts', status: 'M' }] },
    }, 'handoff');
    const handoff = await call('/v1/sessions/ses_par_a/handoff', { as: 'alice', body: { device_id: 'dev_a', brief: '# Handoff: Refunds' } });
    expect(handoff.body.session).toMatchObject({ status: 'resumable', leaseDevice: null, handoffBrief: '# Handoff: Refunds' });

    const listed = await call(`/v1/projects/${projectId}/sessions?resumable=true`, { as: 'bob' });
    expect(listed.body.sessions.map((s: any) => s.id)).toContain('ses_par_a');

    const pkg = await call('/v1/sessions/ses_par_a/resume', { as: 'bob', body: { device_id: 'dev_b2', agent: 'codex', model: 'gpt-5', new_session_id: 'ses_child_b' } });
    expect(pkg.status).toBe(200);
    expect(pkg.body).toMatchObject({
      continuation: 'child_session',
      resumedFrom: 'ses_par_a',
      nextAction: 'Write the POST /refunds handler',
      doNotRedo: ['refund table', 'refund service'],
      filesToRead: ['src/refunds.ts'],
      snapshot: null,
    });
    expect(pkg.body.session).toMatchObject({ id: 'ses_child_b', status: 'in_progress', parentSessionId: 'ses_par_a', agent: 'codex', userEmail: 'bob@acme.test' });
    expect(pkg.body.brief).toContain('## Do NOT redo');

    const parent = await call('/v1/sessions/ses_par_a', { as: 'alice' });
    expect(parent.body.session).toMatchObject({ status: 'completed', continuedBy: 'ses_child_b' });
    expect((await call('/v1/sessions/ses_par_a/resume', { as: 'maint', body: { device_id: 'dev_m' } })).body.error.code).toBe('already_continued');
  });

  it('reserves an addressed handoff for its recipient', async () => {
    await start('alice', 'dev_a', 'ses_reserved');
    await checkpoint('alice', 'dev_a', 'ses_reserved', 1, { status: 'waiting_handoff' }, 'handoff');
    await call('/v1/sessions/ses_reserved/handoff', { as: 'alice', body: { device_id: 'dev_a', brief: 'b', to: 'bob@acme.test' } });
    expect((await call('/v1/sessions/ses_reserved/resume', { as: 'maint', body: { device_id: 'dev_m' } })).body.error.code).toBe('reserved');
    expect((await call('/v1/sessions/ses_reserved/resume', { as: 'bob', body: { device_id: 'dev_b' } })).status).toBe(200);
  });

  it('expires leases: a silent session becomes resumable and the same user continues it', async () => {
    await start('bob', 'dev_b', 'ses_crash');
    await checkpoint('bob', 'dev_b', 'ses_crash', 1, { completedSteps: [{ id: '1', text: 'half done', at: 'x' }] }, 'fs_change');
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const listed = await call(`/v1/projects/${projectId}/sessions?resumable=true`, { as: 'bob' });
    expect(listed.body.sessions.find((s: any) => s.id === 'ses_crash')?.status).toBe('resumable');
    const audit = await db.query("SELECT 1 FROM core.audit_log WHERE action = 'session.lease_expired' AND target_id = 'ses_crash'");
    expect(audit).toHaveLength(1);

    const same = await call('/v1/sessions/ses_crash/resume', { as: 'bob', body: { device_id: 'dev_b_laptop' } });
    expect(same.body).toMatchObject({ continuation: 'same_session', session: { id: 'ses_crash', status: 'in_progress', deviceId: 'dev_b_laptop' } });
    expect(same.body.doNotRedo).toEqual(['half done']);
  });

  it('a session without any checkpoint becomes interrupted, not resumable', async () => {
    await start('bob', 'dev_b', 'ses_empty');
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const list = await call(`/v1/projects/${projectId}/sessions?status=interrupted`, { as: 'bob' });
    expect(list.body.sessions.map((s: any) => s.id)).toContain('ses_empty');
  });

  it('accepts late checkpoints from the owner after expiry when nobody took over', async () => {
    await start('alice', 'dev_a', 'ses_offline');
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await call(`/v1/projects/${projectId}/sessions?resumable=true`, { as: 'alice' });
    const late = await checkpoint('alice', 'dev_a', 'ses_offline', 1, {}, 'timer');
    expect(late.body.outcome).toBe('applied');
  });

  it('shows viewers the list without state, and refuses them details and writes', async () => {
    const list = await call(`/v1/projects/${projectId}/sessions`, { as: 'vera' });
    expect(list.status).toBe(200);
    expect(list.body.sessions.length).toBeGreaterThan(0);
    expect(list.body.sessions[0]).not.toHaveProperty('state');
    expect((await call('/v1/sessions/ses_crash', { as: 'vera' })).status).toBe(403);
    expect((await start('vera', 'dev_v', 'ses_viewer')).status).toBe(403);
  });

  it('finishes a session and frees it', async () => {
    const finished = await call('/v1/sessions/ses_crash/finish', { as: 'bob', body: { device_id: 'dev_b_laptop', status: 'completed', summary: 'done' } });
    expect(finished.body.session).toMatchObject({ status: 'completed', leaseDevice: null });
    expect((await call('/v1/sessions/ses_crash/resume', { as: 'bob', body: { device_id: 'dev_b' } })).body.error.code).toBe('session_closed');
  });

  it('a maintainer can force-resume a live session, and it is audited', async () => {
    await start('bob', 'dev_b', 'ses_force');
    const forced = await call('/v1/sessions/ses_force/resume', { as: 'maint', body: { device_id: 'dev_m', force: true } });
    expect(forced.status).toBe(200);
    const audit = await db.query("SELECT 1 FROM core.audit_log WHERE action = 'session.resume_forced' AND target_id = 'ses_force'");
    expect(audit).toHaveLength(1);
  });
});

describe.skipIf(pgAvailable)('central sessions', () => {
  it.skip(pgSkipReason, () => undefined);
});
