/**
 * `POST /v1/projects/resolve` with forks: a fork shares the first commit with
 * its upstream, so the server must tell "this exact repository" apart from
 * "a repository with the same history", let a fork get a project of its own,
 * and let the caller choose when several projects replicate the same id.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { addOrgMember, createOrganization, createUser, issueToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import { cliBuilt, createRepoPair, git, machine, pmi, type Machine } from './cli-helper.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

const ROOT = 'b'.repeat(40);
let pg: TestPostgres;
let db: Database;
let server: http.Server;
let base = '';
const tokens: Record<string, string> = {};

async function resolve(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/v1/projects/resolve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

describe.skipIf(!pgAvailable)('project resolution for forks (real Postgres)', () => {
  let upstreamId = '';
  let forkId = '';
  let mirrorId = '';

  beforeAll(async () => {
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    await createOrganization(db, 'other', 'Other');
    await createUser(db, { email: 'lead@acme.test', displayName: 'Lead', orgSlug: 'acme', role: 'admin' });
    await createUser(db, { email: 'eve@other.test', displayName: 'Eve', orgSlug: 'other', role: 'owner' });
    const both = await createUser(db, { email: 'both@acme.test', displayName: 'Both', orgSlug: 'acme', role: 'admin' });
    await addOrgMember(db, 'other', both.id, 'admin');
    for (const email of ['lead@acme.test', 'eve@other.test', 'both@acme.test']) {
      tokens[email.split('@')[0]] = (await issueToken(db, { email, name: 'test' })).token;
    }
    server = createCentralServer({ db, version: 'test', log: () => undefined });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const upstream = await resolve(tokens.lead, { legacy_project_id: 'acme/shop', root_commit: ROOT, create: { org: 'acme', slug: 'shop' } });
    expect(upstream.status).toBe(201);
    upstreamId = upstream.body.project.id;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((done) => server?.close(() => done()));
    await db?.close();
    await pg?.stop();
  }, 60_000);

  it('refuses a fork that only shares the first commit and names the project it collided with', async () => {
    const res = await resolve(tokens.lead, { legacy_project_id: 'lead/shop', root_commit: ROOT });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('identity_mismatch');
    expect(res.body.error.message).toContain('--create');
    expect(res.body.error.details).toEqual([expect.objectContaining({ id: upstreamId, org: 'acme', slug: 'shop', legacyProjectIds: ['acme/shop'] })]);
  });

  it('gives a fork its own project with --create, then tells fork and upstream apart', async () => {
    const created = await resolve(tokens.lead, { legacy_project_id: 'lead/shop', root_commit: ROOT, create: { org: 'acme', slug: 'shop-fork' } });
    expect(created.status).toBe(201);
    forkId = created.body.project.id;
    expect(forkId).not.toBe(upstreamId);
    expect(created.body.project).not.toHaveProperty('org');

    const fork = await resolve(tokens.lead, { legacy_project_id: 'lead/shop', root_commit: ROOT });
    expect(fork).toMatchObject({ status: 200, body: { created: false, project: { id: forkId, slug: 'shop-fork' } } });
    const upstream = await resolve(tokens.lead, { legacy_project_id: 'acme/shop', root_commit: ROOT });
    expect(upstream).toMatchObject({ status: 200, body: { project: { id: upstreamId } } });
  });

  it('lists the choices when several projects replicate the same id, and links the one chosen', async () => {
    // Another organization replicates the same repository id; Eve cannot see Acme's projects.
    const mirror = await resolve(tokens.eve, { legacy_project_id: 'acme/shop', root_commit: ROOT, create: { org: 'other', slug: 'shop' } });
    expect(mirror.status).toBe(201);
    mirrorId = mirror.body.project.id;

    const ambiguous = await resolve(tokens.both, { legacy_project_id: 'acme/shop', root_commit: ROOT });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error.code).toBe('ambiguous_project');
    expect(ambiguous.body.error.details.map((c: { org: string; slug: string }) => `${c.org}/${c.slug}`).sort()).toEqual(['acme/shop', 'other/shop']);

    // A bare slug is not enough when both organizations use it.
    const bySlug = await resolve(tokens.both, { legacy_project_id: 'acme/shop', root_commit: ROOT, project: 'shop' });
    expect(bySlug).toMatchObject({ status: 409, body: { error: { code: 'ambiguous_project' } } });

    const chosen = await resolve(tokens.both, { legacy_project_id: 'acme/shop', root_commit: ROOT, project: 'other/shop' });
    expect(chosen).toMatchObject({ status: 200, body: { project: { id: mirrorId } } });
    const byId = await resolve(tokens.both, { legacy_project_id: 'acme/shop', project: upstreamId });
    expect(byId).toMatchObject({ status: 200, body: { project: { id: upstreamId } } });
  });

  it('only chooses among projects the caller can see and that match the repository', async () => {
    // Eve sees only her mirror: no ambiguity for her, and Acme's project stays invisible.
    const eve = await resolve(tokens.eve, { legacy_project_id: 'acme/shop', root_commit: ROOT });
    expect(eve).toMatchObject({ status: 200, body: { project: { id: mirrorId } } });
    const hidden = await resolve(tokens.eve, { legacy_project_id: 'acme/shop', project: 'acme/shop' });
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.details.map((c: { id: string }) => c.id)).toEqual([mirrorId]);

    // Choosing the fork for an upstream working copy would mix two ids in one project.
    const mixed = await resolve(tokens.lead, { legacy_project_id: 'acme/shop', root_commit: ROOT, project: 'acme/shop-fork' });
    expect(mixed).toMatchObject({ status: 409, body: { error: { code: 'identity_mismatch' } } });
  });
});

describe.skipIf(!pgAvailable || !cliBuilt)('pmi project link for a fork (real Postgres, built CLI)', () => {
  let root = '';
  let upstream: Machine;
  let fork: Machine;

  beforeAll(async () => {
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    await createUser(db, { email: 'lead@acme.test', displayName: 'Lead', orgSlug: 'acme', role: 'admin' });
    const token = (await issueToken(db, { email: 'lead@acme.test', name: 'test' })).token;
    server = createCentralServer({ db, version: 'test', log: () => undefined });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    root = mkdtempSync(path.join(tmpdir(), 'pmi-fork-link-'));
    const [repoA, repoB] = createRepoPair(root, 'https://github.com/acme/shop.git');
    git(repoB, 'remote', 'set-url', 'origin', 'https://github.com/lead/shop.git');
    upstream = machine(root, 'upstream', repoA, { PMI_DAEMON: 'off' });
    fork = machine(root, 'fork', repoB, { PMI_DAEMON: 'off' });
    for (const m of [upstream, fork]) expect((await pmi(m, 'login', base, '--token', token)).code).toBe(0);
    const created = await pmi(upstream, 'project', 'link', '--create', '--org', 'acme', '--slug', 'shop', '--json');
    expect(created.code, created.stderr).toBe(0);
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((done) => server?.close(() => done()));
    await db?.close();
    await pg?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('shows the colliding project with a ready command, then links the fork to its own project', async () => {
    const refused = await pmi(fork, 'project', 'link');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('--create');
    expect(refused.stderr).toContain('Matching projects:');
    expect(refused.stderr).toContain('acme/shop [acme/shop]');

    const json = await pmi(fork, 'project', 'link', '--json');
    expect(JSON.parse(json.stderr)).toMatchObject({ code: 'identity_mismatch', candidates: [{ org: 'acme', slug: 'shop' }] });

    const created = await pmi(fork, 'project', 'link', '--create', '--org', 'acme', '--slug', 'shop-fork', '--json');
    expect(created.code, created.stderr).toBe(0);
    expect(created.json).toMatchObject({ slug: 'shop-fork', legacyProjectId: 'lead/shop', created: true });

    const relinked = await pmi(fork, 'project', 'link', '--json');
    expect(relinked.json).toMatchObject({ slug: 'shop-fork', created: false });
    const upstreamAgain = await pmi(upstream, 'project', 'link', '--json');
    expect(upstreamAgain.json).toMatchObject({ slug: 'shop', created: false });
  }, 120_000);
});

describe.skipIf(pgAvailable)('project resolution for forks', () => {
  it.skip(`needs Postgres: ${pgSkipReason}`, () => undefined);
});
