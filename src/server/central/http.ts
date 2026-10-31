/**
 * HTTP API of the central server (docs/PMI/API.md §1). Plain `node:http`
 * with zod validation. Every handler goes through `authenticate`; project
 * routes go through `authorize()` and read or write project data inside
 * `db.asUser()`, where Postgres row-level security applies as well.
 */
import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';

import { MEMORY_CATEGORIES, MEMORY_CONFIDENCE, MEMORY_STATUSES } from '../../domain/memory.js';
import { validateBatches } from '../../sync/engine.js';
import { syncNamespace } from '../../sync/namespace.js';
import type { ChangeBatch } from '../../sync/types.js';
import type { Database } from './db.js';
import { sanitizeCredentials } from '../../memory/secret-filter.js';
import { audit } from './identity.js';
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
  memoriesByIds,
  setConfidence,
} from './memory-repo.js';
import { pendingMigrations } from './migrations.js';
import { buildServerContext, getOverview, hybridSearch, recordMetric, type ServerEmbeddings } from './context-repo.js';
import { createMetrics } from './metrics.js';
import { applyReconcile, getCursor, postCommits, relatedFiles, resolveRepository, type PostedCommit } from './git-repo.js';
import { timingSafeEqual } from 'node:crypto';
import {
  addCheckpoint,
  expireLeases,
  finishSession,
  getSession,
  handoffSession,
  heartbeat,
  listCheckpoints,
  listSessions,
  releaseSession,
  resumeSession,
  upsertSession,
  type SessionRow,
} from './sessions-repo.js';
import { ServerBlobStorage, type BlobKeys, addProjectBlob, getSnapshot, listSnapshots, missingBlobs, registerSnapshot } from './snapshots-repo.js';
import { isSha256 } from '../../workspace-snapshot/blob-store.js';
import type { SnapshotManifest } from '../../workspace-snapshot/snapshot.js';
import { SESSION_STATUSES, CHECKPOINT_TRIGGERS, RESUMABLE_STATUSES, type SessionState } from '../../domain/session.js';

// Snapshot manifests of large working copies are the biggest JSON bodies.
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface CentralServerOptions {
  db: Database;
  version: string;
  /** Session lease length; a session not renewed within it becomes resumable. Default PMI_LEASE_TTL or 600 s. */
  leaseTtlSeconds?: number;
  /** How long an addressed handoff is reserved for its recipient. Default 24 h. */
  handoffReserveHours?: number;
  /** Directory for blobs of 256 KiB and more. Default PMI_BLOB_DIR or ./data/blobs. */
  blobDir?: string;
  /** Embedding provider for semantic search; keyword-only search without it. */
  embeddings?: ServerEmbeddings | null;
  /** Minimum age of the cached L1 overview before a rebuild (default 600 s). */
  overviewMinAgeSeconds?: number;
  /** Bearer token for /metrics; unset disables the endpoint. Default PMI_METRICS_TOKEN. */
  metricsToken?: string;
  /** Failed authentications per client address per minute before 429 (default 30). */
  maxAuthFailuresPerMinute?: number;
  /** Take the client address from X-Forwarded-For (behind Caddy). Default PMI_TRUST_PROXY=1. */
  trustProxy?: boolean;
  /** Keys for snapshot blob encryption; default PMI_BLOB_KEY / PMI_BLOB_KEYS_OLD. */
  blobKeys?: BlobKeys;
  log?: (line: Record<string, unknown>) => void;
}

interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  raw: (limit: number) => Promise<Buffer>;
  url: URL;
  params: Record<string, string>;
  body: () => Promise<unknown>;
  user: () => Promise<AuthUser>;
}

/** `raw: true` means the handler wrote the response itself (MCP transport). */
type Handler = (ctx: RequestContext) => Promise<{ status?: number; body: unknown } | { raw: true; status: number }>;

interface Route {
  /** The path template, used as a low-cardinality metric label. */
  label: string;
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
  return { label: path, method, pattern, keys, handler };
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
  include_deprecated: z.boolean().optional(),
});

const contextSchema = z.object({
  task: z.string().max(2000).optional(),
  session_id: z.string().max(200).optional(),
  files: z.array(z.string().max(1024)).max(200).optional(),
  components: z.array(z.string().max(200)).max(50).optional(),
  recent_git_files: z.array(z.string().max(1024)).max(500).optional(),
  budget_tokens: z.number().int().min(200).max(32_000).optional(),
  levels: z.array(z.enum(['L1', 'L2', 'L3'])).min(1).max(3).optional(),
});

const confidenceSchema = z.object({ reason: z.string().max(2000).optional() });

const grantSchema = z.object({
  user: z.string().email().optional(),
  team: z.string().min(1).max(200).optional(),
  role: z.enum(['maintainer', 'developer', 'viewer']).nullable(),
}).refine((value) => Boolean(value.user) !== Boolean(value.team), { message: 'give exactly one of user or team' });

const teamSchema = z.object({ name: z.string().min(1).max(200) });

const deviceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
// The full SessionState is validated structurally where the server relies on
// fields; the rest is stored as the client sent it (bounded to 64 KiB).
const sessionStateSchema = z.object({
  schema: z.literal(1),
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  status: z.enum(SESSION_STATUSES),
  task: z.string().max(2000),
  objective: z.string().max(4000),
  agent: z.string().max(100).nullable(),
  completedSteps: z.array(z.any()).max(200),
  pendingSteps: z.array(z.any()).max(200),
  decisions: z.array(z.object({ id: z.string(), title: z.string() })).max(200),
}).passthrough().refine((state) => Buffer.byteLength(JSON.stringify(state), 'utf8') <= 64 * 1024, { message: 'state exceeds 64 KiB' });

const sessionUpsertSchema = z.object({ device_id: deviceIdSchema, state: sessionStateSchema });
const checkpointSchema = z.object({
  device_id: deviceIdSchema,
  id: z.string().max(200),
  seq: z.number().int().positive(),
  trigger: z.enum(CHECKPOINT_TRIGGERS),
  state: sessionStateSchema,
  created_at: z.string().datetime(),
});
const deviceOnlySchema = z.object({ device_id: deviceIdSchema });
const handoffSchema = z.object({ device_id: deviceIdSchema, brief: z.string().max(32_000), to: z.string().email().optional() });
const finishSchema = z.object({ device_id: deviceIdSchema, status: z.enum(['completed', 'failed']), summary: z.string().max(8000).optional() });
const resumeSchema = z.object({
  device_id: deviceIdSchema,
  force: z.boolean().optional(),
  new_session_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),
  agent: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  model_provider: z.string().max(100).optional(),
});
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const missingSchema = z.object({ sha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20_000) });
const snapshotRegisterSchema = z.object({
  device_id: deviceIdSchema,
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  pinned: z.boolean().optional(),
  manifest: z.object({
    schema: z.literal(1),
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    projectId: z.string(),
    files: z.array(z.object({ path: z.string().min(1).max(4096) }).passthrough()).max(100_000),
    git: z.object({ head: z.string().regex(/^[a-f0-9]{40,64}$/) }).passthrough(),
    totals: z.object({ files: z.number(), bytes: z.number() }),
  }).passthrough(),
});
const restoredSchema = z.object({
  mode: z.enum(['worktree', 'in-place']),
  verified: z.boolean(),
  written: z.number().int().min(0),
  conflicts: z.number().int().min(0),
});

const shaSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
const cursorQuerySchema = z.object({ root_commit: shaSchema, branch: z.string().min(1).max(255) });
const changeSchema = z.object({
  path: z.string().max(4096),
  status: z.enum(['A', 'M', 'D', 'R', 'C', 'T']),
  oldPath: z.string().max(4096).optional(),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
});
const proposalSchema = z.object({
  topicKey: z.string().max(300),
  category: z.enum(MEMORY_CATEGORIES),
  confidence: z.enum(['observed', 'inferred']),
  title: z.string().max(300),
  content: z.string().max(20_000),
  facts: z.array(z.string().max(1000)).max(200),
  files: z.array(z.string().max(4096)).max(500),
  commit: shaSchema,
  component: z.string().max(200),
});
const commitsSchema = z.object({
  root_commit: shaSchema,
  branch: z.string().min(1).max(255),
  legacy_project_id: z.string().min(1).max(512),
  expected_cursor: shaSchema.nullable(),
  new_cursor: shaSchema,
  rewritten: z.boolean().default(false),
  commits: z.array(z.object({
    sha: shaSchema,
    parents: z.array(shaSchema).max(16),
    author: z.string().max(300),
    committedAt: z.string().max(64),
    subject: z.string().max(2000),
    changes: z.array(changeSchema).max(5000),
    classification: z.record(z.any()),
    proposals: z.array(proposalSchema).max(20),
  })).max(100),
});
const reconcileSchema = z.object({
  root_commit: shaSchema,
  branch: z.string().min(1).max(255),
  head: shaSchema,
  findings: z.array(z.object({ id: z.string().max(1024), missing: z.array(z.string().max(4096)).max(500) })).max(20_000),
});

const sessionListSchema = z.object({
  status: z.string().optional(),
  resumable: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
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
      metrics.inc('pmi_memory_retrieval_total', { kind: 'search' });
      const results = await db.asUser(user.id, async (tx) => {
        const hits = await hybridSearch(tx, [project.id], input.query, { limit: input.limit, embeddings, includeDeprecated: input.include_deprecated });
        const rows = await memoriesByIds(tx, hits.map((hit) => hit.id));
        const score = new Map(hits.map((hit) => [hit.id, hit]));
        return rows.map((row) => ({ ...row, relevance: score.get(row.id)!.relevance, keywordRank: score.get(row.id)!.keywordRank, semanticRank: score.get(row.id)!.semanticRank }));
      });
      return { body: { results, mode: embeddings ? 'hybrid' : 'keyword' } };
    }),

    // Cross-project search over every project the caller can read.
    route('POST', '/v1/search', async (ctx) => {
      const user = await ctx.user();
      const input = parse(searchSchema, await ctx.body());
      const projectIds = (await listProjects(db, user.id)).map((project) => project.id);
      metrics.inc('pmi_memory_retrieval_total', { kind: 'search' });
      const results = await db.asUser(user.id, async (tx) => {
        const hits = await hybridSearch(tx, projectIds, input.query, { limit: input.limit, embeddings, includeDeprecated: input.include_deprecated });
        const relevance = new Map(hits.map((hit) => [hit.id, hit.relevance]));
        return (await memoriesByIds(tx, hits.map((hit) => hit.id))).map((row) => ({ ...row, relevance: relevance.get(row.id)! }));
      });
      return { body: { results, mode: embeddings ? 'hybrid' : 'keyword' } };
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

    route('POST', '/v1/projects/:id/sessions', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'session.write');
      const input = parse(sessionUpsertSchema, await ctx.body());
      const session = await db.asUser(user.id, (tx) => upsertSession(tx, project, user, input.device_id, input.state as unknown as SessionState, leaseTtl));
      return { body: { session } };
    }),

    route('GET', '/v1/projects/:id/sessions', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'session.read');
      const query = parse(sessionListSchema, Object.fromEntries(ctx.url.searchParams));
      await expireLeases(db);
      const statuses = query.resumable === 'true'
        ? [...RESUMABLE_STATUSES]
        : query.status?.split(',').filter((status) => (SESSION_STATUSES as readonly string[]).includes(status)) as SessionRow['status'][] | undefined;
      const sessions = await db.asUser(user.id, (tx) => listSessions(tx, project.id, { statuses, limit: query.limit }));
      return { body: { sessions: project.role === 'viewer' ? sessions.map(withoutState) : sessions } };
    }),

    route('GET', '/v1/sessions/:sid', async (ctx) => {
      const { user, session } = await loadSession(ctx, 'session.write');
      const checkpoints = await db.asUser(user.id, (tx) => listCheckpoints(tx, session.id));
      return { body: { session, checkpoints } };
    }),

    route('POST', '/v1/sessions/:sid/checkpoints', async (ctx) => {
      const { user, session } = await loadSession(ctx, 'session.write');
      const input = parse(checkpointSchema, await ctx.body());
      const result = await db.asUser(user.id, async (tx) => {
        const locked = (await getSession(tx, session.id, true))!;
        return addCheckpoint(tx, locked, user, input.device_id, {
          id: input.id, seq: input.seq, trigger: input.trigger, state: input.state as unknown as SessionState, createdAt: input.created_at,
        }, leaseTtl);
      });
      return { body: result };
    }),

    route('POST', '/v1/sessions/:sid/heartbeat', async (ctx) => {
      const { user, session } = await loadSession(ctx, 'session.write');
      const input = parse(deviceOnlySchema, await ctx.body());
      const expires = await db.asUser(user.id, async (tx) => heartbeat(tx, (await getSession(tx, session.id, true))!, user, input.device_id, leaseTtl));
      return { body: { leaseExpiresAt: expires } };
    }),

    route('POST', '/v1/sessions/:sid/handoff', async (ctx) => {
      const { user, session, project } = await loadSession(ctx, 'session.write');
      const input = parse(handoffSchema, await ctx.body());
      let toUserId: string | undefined;
      if (input.to) {
        const target = await findUserByEmail(db, input.to);
        if (!target) throw new HttpError(404, 'user_not_found', `no user ${input.to}`);
        toUserId = target.id;
      }
      const updated = await db.asUser(user.id, async (tx) => handoffSession(tx, project, (await getSession(tx, session.id, true))!, user, input.device_id, {
        brief: sanitizeCredentials(input.brief), toUserId, reserveHours: handoffReserveHours,
      }));
      return { body: { session: updated } };
    }),

    route('POST', '/v1/sessions/:sid/finish', async (ctx) => {
      const { user, session, project } = await loadSession(ctx, 'session.write');
      const input = parse(finishSchema, await ctx.body());
      const updated = await db.asUser(user.id, async (tx) => finishSession(tx, project, (await getSession(tx, session.id, true))!, user, input.device_id, {
        status: input.status, summary: input.summary ? sanitizeCredentials(input.summary) : undefined,
      }));
      return { body: { session: updated } };
    }),

    route('POST', '/v1/sessions/:sid/release', async (ctx) => {
      const { user, session } = await loadSession(ctx, 'session.write');
      const input = parse(deviceOnlySchema, await ctx.body());
      const updated = await db.asUser(user.id, async (tx) => releaseSession(tx, (await getSession(tx, session.id, true))!, user, input.device_id));
      return { body: { session: updated } };
    }),

    route('POST', '/v1/sessions/:sid/resume', async (ctx) => {
      const { user, session, project } = await loadSession(ctx, 'session.write');
      const input = parse(resumeSchema, await ctx.body());
      if (input.force) await authorize(db, user, project.id, 'session.force');
      await expireLeases(db);
      const pkg = await db.asUser(user.id, (tx) => resumeSession(tx, project, user, input.device_id, session.id, {
        force: input.force, newSessionId: input.new_session_id, agent: input.agent, model: input.model, modelProvider: input.model_provider,
      }, leaseTtl));
      return { body: pkg };
    }),

    route('POST', '/v1/projects/:id/blobs/missing', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'snapshot.write');
      const input = parse(missingSchema, await ctx.body());
      return { body: { missing: await db.asUser(user.id, (tx) => missingBlobs(tx, project.id, input.sha256)) } };
    }),

    route('PUT', '/v1/projects/:id/blobs/:sha', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'snapshot.write');
      const sha = ctx.params.sha;
      if (!isSha256(sha)) throw new HttpError(400, 'invalid_blob_id', 'blob id must be a lowercase SHA-256');
      const data = await ctx.raw(MAX_BLOB_BYTES);
      await blobStorage.put(db, sha, data);
      await db.asUser(user.id, (tx) => addProjectBlob(tx, project.id, user, sha));
      return { status: 201, body: { sha256: sha, size: data.length } };
    }),

    route('GET', '/v1/projects/:id/blobs/:sha', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'snapshot.read');
      const sha = ctx.params.sha;
      if (!isSha256(sha)) throw new HttpError(400, 'invalid_blob_id', 'blob id must be a lowercase SHA-256');
      const [claimed] = await db.asUser(user.id, (tx) => missingBlobs(tx, project.id, [sha]));
      if (claimed) throw new HttpError(404, 'blob_not_found', 'blob not found');
      const data = await blobStorage.get(db, sha);
      ctx.res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length, ...SECURITY_HEADERS });
      ctx.res.end(data);
      return { raw: true, status: 200 };
    }),

    route('POST', '/v1/projects/:id/snapshots', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'snapshot.write');
      const input = parse(snapshotRegisterSchema, await ctx.body());
      const result = await db.asUser(user.id, (tx) => registerSnapshot(tx, project, user, {
        deviceId: input.device_id,
        manifest: input.manifest as unknown as SnapshotManifest,
        manifestSha256: input.manifest_sha256,
        pinned: Boolean(input.pinned),
      }));
      return { status: result.created ? 201 : 200, body: result };
    }),

    route('GET', '/v1/projects/:id/snapshots', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'snapshot.read');
      const sessionId = ctx.url.searchParams.get('session_id') ?? undefined;
      return { body: { snapshots: await db.asUser(user.id, (tx) => listSnapshots(tx, project.id, sessionId)) } };
    }),

    route('GET', '/v1/snapshots/:snap', async (ctx) => {
      const user = await ctx.user();
      const id = decodeURIComponent(ctx.params.snap);
      const snapshot = await db.asUser(user.id, (tx) => getSnapshot(tx, id));
      if (!snapshot) throw new HttpError(404, 'snapshot_not_found', 'snapshot not found');
      await authorize(db, user, snapshot.projectId, 'snapshot.read');
      return { body: { snapshot } };
    }),

    route('POST', '/v1/snapshots/:snap/restored', async (ctx) => {
      const user = await ctx.user();
      const id = decodeURIComponent(ctx.params.snap);
      const snapshot = await db.asUser(user.id, (tx) => getSnapshot(tx, id));
      if (!snapshot) throw new HttpError(404, 'snapshot_not_found', 'snapshot not found');
      const project = await authorize(db, user, snapshot.projectId, 'snapshot.read');
      const input = parse(restoredSchema, await ctx.body());
      await db.asUser(user.id, (tx) => audit(tx, {
        action: 'snapshot.restore', actorUserId: user.id, orgId: project.orgId, projectId: project.id,
        targetType: 'snapshot', targetId: id, detail: input,
      }));
      return { body: { ok: true } };
    }),

    route('GET', '/v1/projects/:id/overview', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'memory.read');
      const overview = await db.asUser(user.id, (tx) => getOverview(tx, db, project, { minAgeSeconds: overviewMinAge }));
      if (overview.cacheHit) metrics.inc('pmi_context_cache_hits_total');
      return { body: { overview: overview.text, memoryIds: overview.ids, tokens: overview.tokens, cacheHit: overview.cacheHit } };
    }),

    route('POST', '/v1/projects/:id/context', async (ctx) => {
      const user = await ctx.user();
      const input = parse(contextSchema, await ctx.body());
      const project = await authorize(db, user, ctx.params.id, input.session_id ? 'session.write' : 'memory.read');
      const started = Date.now();
      const pkg = await db.asUser(user.id, async (tx) => {
        let session: SessionState | null = null;
        if (input.session_id) {
          const row = await getSession(tx, input.session_id);
          if (!row || row.projectId !== project.id) throw new HttpError(404, 'session_not_found', 'session not found');
          session = row.state;
        }
        const built = await buildServerContext(tx, db, project, {
          task: input.task, budgetTokens: input.budget_tokens, levels: input.levels, files: input.files,
          components: input.components, recentGitFiles: input.recent_git_files, session,
        }, { embeddings, overviewMinAgeSeconds: overviewMinAge });
        await recordMetric(tx, {
          projectId: project.id, sessionId: input.session_id, userId: user.id, name: 'context_tokens', value: built.receipt.tokensTotal,
          labels: { lens: built.receipt.lens, levels: input.levels ?? ['L1', 'L2'], cacheHit: built.receipt.cacheHit },
        });
        return built;
      });
      metrics.inc('pmi_context_build_ms_sum', {}, Date.now() - started);
      if (pkg.receipt.cacheHit) metrics.inc('pmi_context_cache_hits_total');
      return { body: pkg };
    }),

    route('GET', '/metrics', async (ctx) => {
      const expected = options.metricsToken ?? process.env.PMI_METRICS_TOKEN;
      if (!expected) throw new HttpError(404, 'not_found', 'metrics are disabled; set PMI_METRICS_TOKEN');
      const given = /^Bearer\s+(\S+)$/i.exec(ctx.req.headers.authorization ?? '')?.[1] ?? '';
      const a = Buffer.from(given);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'unauthorized', 'metrics token required');
      const text = await metrics.render(db);
      ctx.res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
      ctx.res.end(text);
      return { raw: true, status: 200 };
    }),

    route('GET', '/v1/projects/:id/git/cursor', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'memory.read');
      const query = parse(cursorQuerySchema, Object.fromEntries(ctx.url.searchParams));
      const repositoryId = await resolveRepository(db, project.id, query.root_commit);
      const cursor = await db.asUser(user.id, (tx) => getCursor(tx, repositoryId, query.branch));
      return { body: { repositoryId, ...cursor } };
    }),

    route('POST', '/v1/projects/:id/git/commits', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'git.analyze');
      const input = parse(commitsSchema, await ctx.body());
      const report = await db.asUser(user.id, (tx) => postCommits(tx, db, project, user, {
        rootCommit: input.root_commit, branch: input.branch, legacyProjectId: input.legacy_project_id,
        expectedCursor: input.expected_cursor, newCursor: input.new_cursor, rewritten: input.rewritten,
        commits: input.commits as unknown as PostedCommit[],
      }));
      metrics.inc('pmi_git_commits_analyzed_total', {}, report.analyzed);
      return { body: report };
    }),

    route('GET', '/v1/projects/:id/git/related-files', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'memory.read');
      return { body: { memories: await db.asUser(user.id, (tx) => relatedFiles(tx, project.id)) } };
    }),

    route('POST', '/v1/projects/:id/git/reconcile', async (ctx) => {
      const user = await ctx.user();
      const project = await authorize(db, user, ctx.params.id, 'git.analyze');
      const input = parse(reconcileSchema, await ctx.body());
      return { body: await db.asUser(user.id, (tx) => applyReconcile(tx, db, project, user, {
        rootCommit: input.root_commit, branch: input.branch, head: input.head, findings: input.findings,
      })) };
    }),

    route('POST', '/mcp', async (ctx) => {
      const user = await ctx.user();
      await handleMcpRequest(db, user, options.version, ctx.req, ctx.res, await ctx.body());
      return { raw: true, status: ctx.res.statusCode };
    }),
  ];

  const metrics = createMetrics();
  const embeddings = options.embeddings ?? null;
  const overviewMinAge = options.overviewMinAgeSeconds ?? 600;
  const blobStorage = new ServerBlobStorage(options.blobDir ?? process.env.PMI_BLOB_DIR ?? path.resolve('data', 'blobs'), options.blobKeys);
  const leaseTtl = options.leaseTtlSeconds ?? (Number(process.env.PMI_LEASE_TTL) || 600);
  const handoffReserveHours = options.handoffReserveHours ?? 24;

  function withoutState(session: SessionRow): Omit<SessionRow, 'state' | 'handoffBrief'> {
    const { state: _state, handoffBrief: _brief, ...rest } = session;
    return rest;
  }

  /** Resolve a session id through RLS (invisible → 404), then check the caller's role on its project. */
  async function loadSession(ctx: RequestContext, action: 'session.read' | 'session.write') {
    const user = await ctx.user();
    const id = decodeURIComponent(ctx.params.sid);
    const session = await db.asUser(user.id, (tx) => getSession(tx, id));
    if (!session) throw new HttpError(404, 'session_not_found', 'session not found');
    const project = await authorize(db, user, session.projectId, action);
    return { user, session, project };
  }

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

  const authFailures = new FailureLimiter(options.maxAuthFailuresPerMinute ?? 30);
  const trustProxy = options.trustProxy ?? process.env.PMI_TRUST_PROXY === '1';
  const clientIp = (req: http.IncomingMessage): string => {
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    return forwarded || req.socket.remoteAddress || 'unknown';
  };

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    let user: AuthUser | undefined;
    let routeLabel = 'unmatched';

    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      res.end(payload);
      metrics.inc('pmi_http_requests_total', { route: routeLabel, status: String(status) });
      log({ at: new Date().toISOString(), method: req.method, path: url.pathname, status, ms: Date.now() - started, user: user?.id });
    };

    const match = routes
      .filter((candidate) => candidate.pattern.test(url.pathname));
    routeLabel = match[0]?.label ?? 'unmatched';
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
      raw: (limit) => readRaw(req, limit),
      user: async () => {
        if (user) return user;
        const ip = clientIp(req);
        if (authFailures.blocked(ip)) throw new HttpError(429, 'too_many_failures', 'too many failed authentication attempts; try again in a minute');
        try {
          user = await authenticate(db, req.headers.authorization);
        } catch (error) {
          if (error instanceof HttpError && error.status === 401) authFailures.fail(ip);
          throw error;
        }
        return user;
      },
    };

    selected.handler(ctx).then(
      (result) => {
        if ('raw' in result) {
          metrics.inc('pmi_http_requests_total', { route: routeLabel, status: String(result.status) });
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
  // Slow-loris protection: headers within 30 s, a whole request within 2 min.
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  return server;
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/** Failed authentications per client address in a sliding minute; blocks token guessing and floods. */
class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly limit: number) {}

  private recent(key: string): number[] {
    const now = Date.now();
    const kept = (this.failures.get(key) ?? []).filter((at) => now - at < 60_000);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  blocked(key: string): boolean {
    return this.recent(key).length >= this.limit;
  }

  fail(key: string): void {
    const kept = this.recent(key);
    kept.push(Date.now());
    this.failures.set(key, kept);
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value!);
  }
}

function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload_too_large', `request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
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
