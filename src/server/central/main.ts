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
 *   pmi-server create-team <org> <name>
 *   pmi-server add-team-member <org> <team> <email>
 *   pmi-server grant <org>/<project-slug> (--user <email> | --team <name>) --role maintainer|developer|viewer|none
 *
 * Configuration: PMI_DATABASE_URL (required), PMI_HOST, PMI_PORT.
 */
import { parseArgs } from 'node:util';

import { openDatabase, type Database } from './db.js';
import { createCentralServer } from './http.js';
import {
  HttpError,
  addOrgMember,
  addTeamMember,
  createOrganization,
  createTeam,
  createUser,
  findTeam,
  findUserByEmail,
  issueToken,
  revokeToken,
  setProjectGrant,
  type GrantRole,
  type ProjectRecord,
} from './identity.js';
import { migrate } from './migrations.js';
import { expireLeases } from './sessions-repo.js';
import { ServerBlobStorage, applyRetention } from './snapshots-repo.js';
import path from 'node:path';

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
  gc                                        Apply snapshot retention and delete unused blobs
  create-team <org> <name>
  add-team-member <org> <team> <email>
  grant <org>/<project> (--user EMAIL | --team NAME) --role maintainer|developer|viewer|none

Organization owners/admins have full access to every project of their
organization; everyone else needs a project grant (directly or via a team).

Environment: PMI_DATABASE_URL (required), PMI_HOST (default 127.0.0.1), PMI_PORT (default 7420),
PMI_LEASE_TTL (session lease seconds, default 600), PMI_BLOB_DIR (large snapshot blobs, default ./data/blobs)`;

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
      user: { type: 'string' },
      team: { type: 'string' },
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
      // Sessions whose lease ran out become resumable even if nobody asks.
      const leaseJob = setInterval(() => {
        expireLeases(db).catch((error: Error) => console.error(`[pmi-server] lease expiry failed: ${error.message}`));
      }, 30_000);
      leaseJob.unref();
      // Snapshot retention and blob GC (WORKSPACE_RECOVERY.md §7) every 6 hours.
      const blobStorage = new ServerBlobStorage(process.env.PMI_BLOB_DIR ?? path.resolve('data', 'blobs'));
      const retentionJob = setInterval(() => {
        applyRetention(db, blobStorage)
          .then((report) => console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'snapshot retention', ...report })))
          .catch((error: Error) => console.error(`[pmi-server] snapshot retention failed: ${error.message}`));
      }, 6 * 3_600_000);
      retentionJob.unref();
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
    case 'gc': {
      const report = await withDatabase((db) => applyRetention(db, new ServerBlobStorage(process.env.PMI_BLOB_DIR ?? path.resolve('data', 'blobs'))));
      console.log(`Removed ${report.snapshots} snapshot(s), ${report.projectBlobs} unused project blob claim(s), ${report.blobs} blob(s)`);
      return 0;
    }
    case 'create-team': {
      const [org, name] = rest;
      if (!org || !name) throw new Error('usage: pmi-server create-team <org> <name>');
      const team = await withDatabase((db) => db.transaction((tx) => createTeam(tx, org, name)));
      console.log(`Team ${team.name} (${team.id})`);
      return 0;
    }
    case 'add-team-member': {
      const [org, teamName, email] = rest;
      if (!org || !teamName || !email) throw new Error('usage: pmi-server add-team-member <org> <team> <email>');
      await withDatabase((db) => db.transaction(async (tx) => {
        const team = await findTeam(tx, org, teamName);
        const user = await findUserByEmail(tx, email);
        if (!team) throw new Error(`no team ${teamName} in ${org}`);
        if (!user) throw new Error(`no user with email ${email}`);
        await addTeamMember(tx, team.id, user.id);
      }));
      console.log(`${email} joined ${org}/${teamName}`);
      return 0;
    }
    case 'grant': {
      const [target] = rest;
      const [org, slug] = (target ?? '').split('/');
      if (!org || !slug || Boolean(values.user) === Boolean(values.team) || !values.role) {
        throw new Error('usage: pmi-server grant <org>/<project> (--user EMAIL | --team NAME) --role maintainer|developer|viewer|none');
      }
      if (!['maintainer', 'developer', 'viewer', 'none'].includes(values.role)) throw new Error('--role must be maintainer, developer, viewer or none');
      const role = values.role === 'none' ? null : values.role as GrantRole;
      await withDatabase((db) => db.transaction(async (tx) => {
        const [project] = await tx.query<ProjectRecord>(
          `SELECT p.id, p.org_id AS "orgId", p.slug, p.name, p.legacy_project_ids AS "legacyProjectIds", p.created_at AS "createdAt"
             FROM core.projects p JOIN core.organizations o ON o.id = p.org_id WHERE o.slug = $1 AND p.slug = $2`,
          [org, slug],
        );
        if (!project) throw new Error(`no project ${org}/${slug}`);
        const principalId = values.user ? (await findUserByEmail(tx, values.user))?.id : (await findTeam(tx, org, values.team!))?.id;
        if (!principalId) throw new Error(`no ${values.user ? 'user' : 'team'} ${values.user ?? values.team}`);
        await setProjectGrant(tx, project, { principalType: values.user ? 'user' : 'team', principalId, role });
      }));
      console.log(role ? `${values.user ?? `team ${values.team}`} is ${role} on ${org}/${slug}` : `Revoked access of ${values.user ?? `team ${values.team}`} to ${org}/${slug}`);
      return 0;
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
