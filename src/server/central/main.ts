/**
 * `pmi-server` — central PMI server and its administration commands.
 *
 *   pmi-server migrate
 *   pmi-server serve [--host 0.0.0.0] [--port 7420] [--no-migrate]
 *   pmi-server create-org <slug> [--name "..."]
 *   pmi-server create-user <email> [--name "..."] [--org <slug>] [--role owner|admin|member]
 *   pmi-server add-member <org> <email> [--role ...]
 *   pmi-server issue-token <email> [--name laptop] [--days 90]
 *   pmi-server revoke-token <token-id>
 *
 * Configuration: PMI_DATABASE_URL (required), PMI_HOST, PMI_PORT.
 */
import { parseArgs } from 'node:util';

import { openDatabase, type Database } from './db.js';
import { createCentralServer } from './http.js';
import { HttpError, addOrgMember, createOrganization, createUser, issueToken, revokeToken } from './identity.js';
import { migrate } from './migrations.js';

declare const __MEMORIX_VERSION__: string | undefined;
const VERSION = typeof __MEMORIX_VERSION__ === 'string' ? __MEMORIX_VERSION__ : 'dev';

const USAGE = `pmi-server ${VERSION} — central PMI server

Commands:
  migrate                                   Apply Postgres migrations
  serve [--host H] [--port P] [--no-migrate] Start the HTTP API (migrates first by default)
  create-org <slug> [--name N]
  create-user <email> [--name N] [--org SLUG] [--role owner|admin|member]
  add-member <org> <email> [--role owner|admin|member]
  issue-token <email> [--name N] [--days D]  Print a new personal access token once
  revoke-token <token-id>

Environment: PMI_DATABASE_URL (required), PMI_HOST (default 127.0.0.1), PMI_PORT (default 7420)`;

type Role = 'owner' | 'admin' | 'member';

function parseRole(value: string | undefined): Role {
  const role = value ?? 'member';
  if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new Error(`--role must be owner, admin or member (got ${role})`);
  return role;
}

async function withDatabase<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const url = process.env.PMI_DATABASE_URL;
  if (!url) throw new Error('PMI_DATABASE_URL is not set');
  const db = await openDatabase(url);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

export async function runServerCli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'no-migrate': { type: 'boolean' },
      name: { type: 'string' },
      org: { type: 'string' },
      role: { type: 'string' },
      days: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case 'migrate': {
      const report = await withDatabase(migrate);
      console.log(report.applied.length ? `Applied: ${report.applied.join(', ')}` : `Schema is current (${report.current})`);
      return 0;
    }
    case 'serve': {
      const url = process.env.PMI_DATABASE_URL;
      if (!url) throw new Error('PMI_DATABASE_URL is not set');
      const db = await openDatabase(url);
      if (!values['no-migrate']) await migrate(db);
      const host = values.host ?? process.env.PMI_HOST ?? '127.0.0.1';
      const port = Number(values.port ?? process.env.PMI_PORT ?? 7420);
      const server = createCentralServer({ db, version: VERSION });
      await new Promise<void>((resolve) => server.listen(port, host, resolve));
      console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'pmi-server listening', host, port, version: VERSION }));
      await new Promise<void>((resolve) => {
        const stop = () => server.close(() => resolve());
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
      });
      await db.close();
      return 0;
    }
    case 'create-org': {
      const [slug] = rest;
      if (!slug) throw new Error('usage: pmi-server create-org <slug> [--name N]');
      const org = await withDatabase((db) => createOrganization(db, slug, values.name ?? slug));
      console.log(`Organization ${org.slug} (${org.id})`);
      return 0;
    }
    case 'create-user': {
      const [email] = rest;
      if (!email) throw new Error('usage: pmi-server create-user <email> [--name N] [--org SLUG] [--role R]');
      const role = parseRole(values.role);
      const user = await withDatabase((db) => db.transaction((tx) =>
        createUser(tx, { email, displayName: values.name ?? email, orgSlug: values.org, role })));
      console.log(`User ${user.email} (${user.id})`);
      return 0;
    }
    case 'add-member': {
      const [org, email] = rest;
      if (!org || !email) throw new Error('usage: pmi-server add-member <org> <email> [--role R]');
      const role = parseRole(values.role);
      await withDatabase((db) => db.transaction(async (tx) => {
        const [user] = await tx.query<{ id: string }>('SELECT id FROM core.users WHERE email = $1', [email]);
        if (!user) throw new Error(`no user with email ${email}`);
        await addOrgMember(tx, org, user.id, role);
      }));
      console.log(`${email} is now ${role} of ${org}`);
      return 0;
    }
    case 'issue-token': {
      const [email] = rest;
      if (!email) throw new Error('usage: pmi-server issue-token <email> [--name N] [--days D]');
      const days = values.days ? Number(values.days) : undefined;
      if (days !== undefined && (!Number.isFinite(days) || days <= 0)) throw new Error('--days must be a positive number');
      const expiresAt = days ? new Date(Date.now() + days * 86_400_000) : undefined;
      const issued = await withDatabase((db) => db.transaction((tx) => issueToken(tx, { email, name: values.name ?? 'cli', expiresAt })));
      console.error(`Token ${issued.id} issued for ${email}. It is shown once; store it now.`);
      console.log(issued.token);
      return 0;
    }
    case 'revoke-token': {
      const [id] = rest;
      if (!id) throw new Error('usage: pmi-server revoke-token <token-id>');
      const revoked = await withDatabase((db) => revokeToken(db, id));
      console.log(revoked ? `Revoked ${id}` : `No active token ${id}`);
      return revoked ? 0 : 1;
    }
    default:
      console.error(`Unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

const invokedDirectly = process.argv[1] && /pmi-server(\.js)?$|central[\\/]main\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  runServerCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(`[pmi-server] ${error instanceof HttpError || error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
