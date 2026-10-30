/**
 * HTTP API of the central server (docs/PMI/API.md §1). Plain `node:http`
 * with zod validation. Every handler goes through `authenticate`; project
 * routes go through `authorize()` and read or write project data inside
 * `db.asUser()`, where Postgres row-level security applies as well.
 */
import http from 'node:http';
import { z } from 'zod';

import { MEMORY_CATEGORIES, MEMORY_CONFIDENCE, MEMORY_STATUSES } from '../../domain/memory.js';
import { validateBatches } from '../../sync/engine.js';
import { syncNamespace } from '../../sync/namespace.js';
import type { ChangeBatch } from '../../sync/types.js';
import type { Database } from './db.js';
import { sanitizeCredentials } from '../../memory/secret-filter.js';
import {
  HttpError,
  authenticate,
  authorize,
  createTeam,
  addTeamMember,
  findTeam,
  findUserByEmail,
  listMemberships,
  listProjectGrants,
  listProjects,
  resolveProject,
  setProjectGrant,
  type AuthUser,
} from './identity.js';
import { handleMcpRequest } from './mcp.js';
import {
  applyPushedBatch,
  getMemory,
  listConflicts,
  listMemories,
  listVersions,
  readChanges,
  searchMemories,
  setConfidence,
} from './memory-repo.js';
import { pendingMigrations } from './migrations.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface CentralServerOptions {
  db: Database;
  version: string;
  log?: (line: Record<string, unknown>) => void;
}

interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: () => Promise<unknown>;
  user: () => Promise<AuthUser>;
}

/** `raw: true` means the handler wrote the response itself (MCP transport). */
type Handler = (ctx: RequestContext) => Promise<{ status?: number; body: unknown } | { raw: true; status: number }>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
    keys.push(key);
    return '([^/]+)';
  })}$`);
  return { method, pattern, keys, handler };
}

const resolveSchema = z.object({
  legacy_project_id: z.string().min(1).max(512),
  root_commit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  remote_urls: z.array(z.string().max(1024)).max(20).optional(),
  create: z.object({
    org: z.string().max(128).optional(),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
    name: z.string().max(200).optional(),
  }).optional(),
});

const pushSchema = z.object({
  project_id: z.string().uuid(),
  batch: z.object({
    formatVersion: z.literal(3),
    namespace: z.string(),
    projectId: z.string(),
    deviceId: z.string(),
    sequence: z.number().int().positive(),
    producedAt: z.string(),
    entries: z.array(z.any()).max(5000),
  }).passthrough(),
});

const memoryQuerySchema = z.object({
  category: z.enum(MEMORY_CATEGORIES).optional(),
  confidence: z.enum(MEMORY_CONFIDENCE).optional(),
  status: z.enum(MEMORY_STATUSES).optional(),
  component: z.string().max(200).optional(),
  file: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const changesQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  legacy: z.string().min(1).max(512),
});

const searchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(100).default(20),
});

const confidenceSchema = z.object({ reason: z.string().max(2000).optional() });

const grantSchema = z.object({
  user: z.string().email().optional(),
  team: z.string().min(1).max(200).optional(),
  role: z.enum(['maintainer', 'developer', 'viewer']).nullable(),
}).refine((value) => Boolean(value.user) !== Boolean(value.team), { message: 'give exactly one of user or team' });

const teamSchema = z.object({ name: z.string().min(1).max(200) });
const teamMemberSchema = z.object({ email: z.string().email() });

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, 'invalid_request', 'request validation failed', result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }
  return result.data;
}

export function createCentralServer(options: CentralServerOptions): http.Server {
  const { db } = options;
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));

  const routes: Route[] = [
    route('GET', '/health', async () => ({ body: { status: 'ok', version: options.version } })),
    route('GET', '/ready', async () => {
      try {
        await db.query('SELECT 1');
      } catch (error) {
        return { status: 503, body: { status: 'unavailable', postgres: 'down', error: (error as Error).message } };
      }
      const pending = await pendingMigrations(db);
      if (pending.length > 0) return { status: 503, body: { status: 'unavailable', postgres: 'up', pendingMigrations: pending } };
      return { body: { status: 'ready', postgres: 'up', pendingMigrations: [] } };
    }),

    route('GET', '/v1/me', async (ctx) => {
      const user = await ctx.user();
      const [orgs, projects] = await Promise.all([listMemberships(db, user.id), listProjects(db, user.id)]);
      return { body: { user: { id: user.id, email: user.email, displayName: user.displayName }, organizations: orgs, projects } };
    }),

    route('GET', '/v1/projects', async (ctx) => ({ body: { projects: await listProjects(db, (await ctx.user()).id) } })),

    route('POST', '/v1/projects/resolve', async (ctx) => {
      const user = await ctx.user();
      const input = parse(resolveSchema, await ctx.body());
      const result = await db.transaction((tx) => resolveProject(tx, user, {
        legacyProjectId: input.legacy_project_id,
        rootCommit: input.root_commit,
        remoteUrls: input.remote_urls,
        create: input.create ? { orgSlug: input.create.org, slug: input.create.slug, name: input.create.name } : undefined,
      }));
      return { status: result.created ? 201 : 200, body: result };
    }),

    route('GET', '/v1/projects/:id', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'memory.read');
      return { body: { project, ...(project.role === 'viewer' ? {} : { grants: await listProjectGrants(db, project.id) }) } };
    }),

    route('PUT', '/v1/projects/:id/grants', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'project.manage');
      const input = parse(grantSchema, await ctx.body());
      const principal = input.user
        ? { principalType: 'user' as const, principalId: (await findUserByEmail(db, input.user))?.id }
        : { principalType: 'team' as const, principalId: (await db.query<{ id: string }>('SELECT id FROM core.teams WHERE org_id = $1 AND name = $2', [project.orgId, input.team]))[0]?.id };
      if (!principal.principalId) throw new HttpError(404, 'principal_not_found', `${principal.principalType} not found`);
      await db.transaction((tx) => setProjectGrant(tx, project, { principalType: principal.principalType, principalId: principal.principalId!, role: input.role }, user.id));
      return { body: { grants: await listProjectGrants(db, project.id) } };
    }),

    route('POST', '/v1/orgs/:org/teams', async (ctx) => {
      const user = await ctx.user();
      await assertOrgAdmin(user, ctx.params.org);
      const input = parse(teamSchema, await ctx.body());
      return { status: 201, body: { team: await db.transaction((tx) => createTeam(tx, ctx.params.org, input.name, user.id)) } };
    }),

    route('POST', '/v1/orgs/:org/teams/:team/members', async (ctx) => {
      const user = await ctx.user();
      await assertOrgAdmin(user, ctx.params.org);
      const input = parse(teamMemberSchema, await ctx.body());
      const team = await findTeam(db, ctx.params.org, decodeURIComponent(ctx.params.team));
      const member = await findUserByEmail(db, input.email);
      if (!team) throw new HttpError(404, 'team_not_found', 'team not found');
      if (!member) throw new HttpError(404, 'user_not_found', 'user not found');
      await db.transaction((tx) => addTeamMember(tx, team.id, member.id, user.id));
      return { body: { ok: true } };
    }),

    route('GET', '/v1/projects/:id/memories', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'memory.read');
      const filters = parse(memoryQuerySchema, Object.fromEntries(ctx.url.searchParams));
      return { body: { memories: await db.asUser(user.id, (tx) => listMemories(tx, project.id, filters)) } };
    }),

    route('POST', '/v1/projects/:id/search', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'memory.read');
      const input = parse(searchSchema, await ctx.body());
      return { body: { results: await db.asUser(user.id, (tx) => searchMemories(tx, [project.id], input.query, input.limit)) } };
    }),

    // Cross-project search over every project the caller can read.
    route('POST', '/v1/search', async (ctx) => {
      const user = await ctx.user();
      const input = parse(searchSchema, await ctx.body());
      const projectIds = (await listProjects(db, user.id)).map((project) => project.id);
      return { body: { results: await db.asUser(user.id, (tx) => searchMemories(tx, projectIds, input.query, input.limit)) } };
    }),

    route('GET', '/v1/projects/:id/conflicts', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'memory.read');
      return { body: { conflicts: await db.asUser(user.id, (tx) => listConflicts(tx, project.id)) } };
    }),

    route('GET', '/v1/memories/:mid', async (ctx) => {
      const user = await ctx.user();
      const memoryId = decodeURIComponent(ctx.params.mid);
      const memory = await db.asUser(user.id, (tx) => getMemory(tx, memoryId));
      if (!memory) throw new HttpError(404, 'memory_not_found', 'memory not found');
      await authorize(db, user, memory.projectId, 'memory.read');
      const include = new Set((ctx.url.searchParams.get('include') ?? '').split(',').filter(Boolean));
      const versions = include.has('versions') ? await db.asUser(user.id, (tx) => listVersions(tx, memory.id)) : undefined;
      return { body: { memory, ...(versions ? { versions } : {}) } };
    }),

    route('POST', '/v1/memories/:mid/confirm', (ctx) => changeConfidence(ctx, 'confirmed')),
    route('POST', '/v1/memories/:mid/deprecate', (ctx) => changeConfidence(ctx, 'deprecated')),

    route('POST', '/v1/sync/push', async (ctx) => {
      const user = await ctx.user();
      const input = parse(pushSchema, await ctx.body());
      const project = await authorize(db, user, input.project_id, 'memory.write');
      const batch = input.batch as unknown as ChangeBatch;
      if (!project.legacyProjectIds.includes(batch.projectId)) {
        throw new HttpError(409, 'identity_mismatch', `project "${project.slug}" does not replicate Memorix project ${batch.projectId}`);
      }
      try {
        validateBatches([batch], batch.projectId, syncNamespace(batch.projectId));
      } catch (error) {
        throw new HttpError(400, 'invalid_batch', (error as Error).message);
      }
      const result = await db.asUser(user.id, (tx) => applyPushedBatch(tx, project, user, batch));
      return { body: result };
    }),

    route('GET', '/v1/projects/:id/changes', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'memory.read');
      const query = parse(changesQuerySchema, Object.fromEntries(ctx.url.searchParams));
      return { body: await db.asUser(user.id, (tx) => readChanges(tx, project.id, query.legacy, query.after, query.limit)) };
    }),

    route('POST', '/mcp', async (ctx) => {
      const user = await ctx.user();
      await handleMcpRequest(db, user, options.version, ctx.req, ctx.res, await ctx.body());
      return { raw: true, status: ctx.res.statusCode };
    }),
  ];

  async function assertOrgAdmin(user: AuthUser, orgSlug: string): Promise<void> {
    const membership = (await listMemberships(db, user.id)).find((org) => org.slug === orgSlug);
    if (!membership) throw new HttpError(404, 'org_not_found', 'organization not found');
    if (membership.role === 'member') throw new HttpError(403, 'forbidden', 'organization owners and admins only');
  }

  async function changeConfidence(ctx: RequestContext, to: 'confirmed' | 'deprecated') {
    const user = await ctx.user();
    const memoryId = decodeURIComponent(ctx.params.mid);
    const input = parse(confidenceSchema, await ctx.body());
    const current = await db.asUser(user.id, (tx) => getMemory(tx, memoryId));
    if (!current || current.deleted) throw new HttpError(404, 'memory_not_found', 'memory not found');
    const project = await authorize(db, user, current.projectId, 'memory.confirm');
    const reason = input.reason ? sanitizeCredentials(input.reason) : undefined;
    const memory = await db.asUser(user.id, (tx) => setConfidence(tx, project, user, memoryId, to, reason));
    if (!memory) throw new HttpError(404, 'memory_not_found', 'memory not found');
    return { body: { memory } };
  }

  return http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    let user: AuthUser | undefined;

    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(payload);
      log({ at: new Date().toISOString(), method: req.method, path: url.pathname, status, ms: Date.now() - started, user: user?.id });
    };

    const match = routes
      .filter((candidate) => candidate.pattern.test(url.pathname));
    const selected = match.find((candidate) => candidate.method === req.method);
    if (!selected) {
      if (match.length > 0) send(405, { error: { code: 'method_not_allowed', message: `${req.method} is not supported here` } });
      else send(404, { error: { code: 'not_found', message: 'no such endpoint' } });
      return;
    }
    const groups = selected.pattern.exec(url.pathname)!;
    const params = Object.fromEntries(selected.keys.map((key, index) => [key, groups[index + 1]]));

    const ctx: RequestContext = {
      req,
      res,
      url,
      params,
      body: () => readJson(req),
      user: async () => {
        user ??= await authenticate(db, req.headers.authorization);
        return user;
      },
    };

    selected.handler(ctx).then(
      (result) => {
        if ('raw' in result) {
          log({ at: new Date().toISOString(), method: req.method, path: url.pathname, status: result.status, ms: Date.now() - started, user: user?.id });
          return;
        }
        send(result.status ?? 200, result.body);
      },
      (error: unknown) => {
        if (error instanceof HttpError) {
          send(error.status, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
          return;
        }
        log({ at: new Date().toISOString(), level: 'error', path: url.pathname, error: (error as Error)?.stack ?? String(error) });
        send(500, { error: { code: 'internal', message: 'internal server error' } });
      },
    );
  });
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'payload_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid_json', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}
