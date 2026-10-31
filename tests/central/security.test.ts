/**
 * Phase 10 security checks on the central server (real Postgres):
 * authentication edge cases, brute-force limiting, request limits and
 * headers, and encryption of snapshot blobs at rest with key rotation.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type Database } from '../../src/server/central/db.js';
import { createCentralServer } from '../../src/server/central/http.js';
import { createOrganization, createUser, issueToken, revokeToken } from '../../src/server/central/identity.js';
import { migrate } from '../../src/server/central/migrations.js';
import { ServerBlobStorage, decryptBlob, encryptBlob } from '../../src/server/central/snapshots-repo.js';
import { sha256Hex } from '../../src/workspace-snapshot/blob-store.js';
import { pgAvailable, pgSkipReason, startPostgres, type TestPostgres } from './pg-helper.js';

let pg: TestPostgres;
let db: Database;
let server: http.Server;
let base = '';
let blobDir = '';
let projectId = '';
const tokens: Record<string, string> = {};
const key = randomBytes(32);

async function call(pathname: string, init: { token?: string; method?: string; body?: string | Buffer; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.headers ?? {}) },
    body: init.body,
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

describe.skipIf(!pgAvailable)('central server security', () => {
  beforeAll(async () => {
    blobDir = fs.mkdtempSync(path.join(tmpdir(), 'baton-sec-blobs-'));
    pg = await startPostgres();
    db = await openDatabase(pg.url);
    await migrate(db);
    await createOrganization(db, 'acme', 'Acme');
    for (const name of ['admin', 'leaver']) {
      await createUser(db, { email: `${name}@acme.test`, displayName: name, orgSlug: 'acme', role: 'admin' });
      tokens[name] = (await issueToken(db, { email: `${name}@acme.test`, name })).token;
    }
    tokens.expired = (await issueToken(db, { email: 'admin@acme.test', name: 'old', expiresAt: new Date(Date.now() - 1000) })).token;
    const revoked = await issueToken(db, { email: 'admin@acme.test', name: 'revoked' });
    await revokeToken(db, revoked.id);
    tokens.revoked = revoked.token;
    server = createCentralServer({ db, version: 'test', log: () => undefined, blobDir, maxAuthFailuresPerMinute: 5, blobKeys: { current: key, previous: [] } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const created = await call('/v1/projects/resolve', { token: tokens.admin, body: JSON.stringify({ legacy_project_id: 'acme/sec', create: { org: 'acme' } }), headers: { 'content-type': 'application/json' } });
    projectId = JSON.parse(created.body).project.id;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db?.close();
    await pg?.stop();
    fs.rmSync(blobDir, { recursive: true, force: true });
  });

  it('rejects expired, revoked and disabled credentials', async () => {
    expect((await call('/v1/me', { token: tokens.expired })).status).toBe(401);
    expect((await call('/v1/me', { token: tokens.revoked })).status).toBe(401);
    expect((await call('/v1/me', { token: tokens.leaver })).status).toBe(200);
    await db.query("UPDATE core.users SET disabled_at = now() WHERE email = 'leaver@acme.test'");
    expect((await call('/v1/me', { token: tokens.leaver })).status).toBe(401);
    expect((await call('/v1/me', { headers: { authorization: 'Basic YWRtaW46YWRtaW4=' } })).status).toBe(401);
  });

  it('sends hardening headers and enforces request limits', async () => {
    const res = await call('/v1/me', { token: tokens.admin });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(server.headersTimeout).toBe(30_000);
    expect(server.requestTimeout).toBe(120_000);
    const bad = await call('/v1/projects/resolve', { token: tokens.admin, body: '{not json', headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
    const huge = await fetch(`${base}/v1/projects/resolve`, { method: 'POST', headers: { authorization: `Bearer ${tokens.admin}`, 'content-type': 'application/json' }, body: Buffer.alloc(17 * 1024 * 1024, 32) }).catch((error) => error);
    expect(huge instanceof Error || huge.status === 413).toBe(true);
    expect((await call('/v1/nope', { token: tokens.admin })).status).toBe(404);
  });

  it('does not log or echo tokens and hides internals on errors', async () => {
    const lines: string[] = [];
    const logged = createCentralServer({ db, version: 'test', log: (line) => lines.push(JSON.stringify(line)) });
    await new Promise<void>((resolve) => logged.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(logged.address() as AddressInfo).port}`;
    await fetch(`${url}/v1/me`, { headers: { authorization: `Bearer ${tokens.admin}` } });
    const failed = await fetch(`${url}/v1/me`, { headers: { authorization: 'Bearer baton_pat_wrongwrongwrongwrong' } });
    expect(await failed.text()).not.toContain('baton_pat_wrong');
    await new Promise<void>((resolve) => logged.close(() => resolve()));
    expect(lines.join('\n')).not.toContain(tokens.admin);
    expect(lines.join('\n')).not.toContain('baton_pat_');
  });

  it('limits failed authentications per client', async () => {
    // A fresh server: the tests above already spent some of this address's budget.
    const limited = createCentralServer({ db, version: 'test', log: () => undefined, maxAuthFailuresPerMinute: 5 });
    await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
    const me = (token: string) => fetch(`${url}/v1/me`, { headers: { authorization: `Bearer ${token}` } }).then((res) => res.status);
    try {
      for (let i = 0; i < 5; i++) expect(await me(`baton_pat_guess${i}aaaaaaaaaaaaaaaaaaaa`)).toBe(401);
      expect(await me('baton_pat_guess6aaaaaaaaaaaaaaaaaaaa')).toBe(429);
      // A valid token from the same address is refused too while the window lasts: the limit is per client, not per token.
      expect(await me(tokens.admin)).toBe(429);
    } finally {
      await new Promise<void>((resolve) => limited.close(() => resolve()));
    }
  });

  it('stores snapshot blobs encrypted and reads them back verified', async () => {
    const storage = new ServerBlobStorage(blobDir, { current: key, previous: [] });
    const small = Buffer.from('secret source code\n');
    const large = randomBytes(300 * 1024);
    for (const data of [small, large]) await storage.put(db, sha256Hex(data), data);
    const [inline] = await db.query<{ data: Buffer }>("SELECT data FROM work.blobs WHERE sha256 = $1", [sha256Hex(small)]);
    expect(inline.data.includes(Buffer.from('secret source code'))).toBe(false);
    expect(inline.data.subarray(0, 5).toString()).toBe('BTNE1');
    const sha = sha256Hex(large);
    const onDisk = fs.readFileSync(path.join(blobDir, sha.slice(0, 2), sha.slice(2, 4), sha));
    expect(onDisk.subarray(0, 5).toString()).toBe('BTNE1');
    expect((await storage.get(db, sha256Hex(small))).equals(small)).toBe(true);
    expect((await storage.get(db, sha)).equals(large)).toBe(true);

    // Tampering with ciphertext is detected by GCM, not served.
    const tampered = Buffer.from(inline.data);
    tampered[tampered.length - 1] ^= 1;
    await db.query('UPDATE work.blobs SET data = $2 WHERE sha256 = $1', [sha256Hex(small), tampered]);
    await expect(storage.get(db, sha256Hex(small))).rejects.toThrow(/authenticated decryption/);
    expect((await storage.verifyAll(db)).failed).toEqual([sha256Hex(small)]);
    await db.query('UPDATE work.blobs SET data = $2 WHERE sha256 = $1', [sha256Hex(small), inline.data]);

    // Rotation: a new key reads old blobs through BATON_BLOB_KEYS_OLD and re-encrypts them.
    const next = randomBytes(32);
    const rotated = new ServerBlobStorage(blobDir, { current: next, previous: [key] });
    expect((await rotated.get(db, sha)).equals(large)).toBe(true);
    const report = await rotated.reencryptAll(db);
    expect(report).toEqual({ rewritten: 2, failed: [] });
    const nextOnly = new ServerBlobStorage(blobDir, { current: next, previous: [] });
    expect((await nextOnly.verifyAll(db)).failed).toEqual([]);
    await expect(new ServerBlobStorage(blobDir, { current: key, previous: [] }).get(db, sha)).rejects.toThrow(/key this server does not have/);
  });

  it('keeps plaintext blobs from before encryption readable', () => {
    const plain = Buffer.from('legacy blob');
    expect(decryptBlob(plain, { current: key, previous: [] }).equals(plain)).toBe(true);
    expect(decryptBlob(encryptBlob(plain, key), { current: key, previous: [] }).equals(plain)).toBe(true);
    expect(projectId).toBeTruthy();
  });
});

describe.skipIf(pgAvailable)('central server security', () => {
  it.skip(pgSkipReason, () => undefined);
});
