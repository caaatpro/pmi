/**
 * Organizations, users, API tokens and projects on the central server.
 *
 * Phase 4 access rule: a user may read and sync a project when they are a
 * member of the project's organization; owners and admins may create
 * projects. Per-project grants, teams and Postgres RLS arrive in Phase 5 and
 * replace `assertProjectAccess` as the single authorization point.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from './db.js';

export const TOKEN_PREFIX = 'pmi_pat_';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  tokenId: string;
}

export interface OrgMembership {
  orgId: string;
  slug: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
}

export interface ProjectRecord {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  legacyProjectIds: string[];
  createdAt: string;
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export async function audit(
  db: Queryable,
  entry: { action: string; actorUserId?: string; orgId?: string; projectId?: string; deviceId?: string; targetType?: string; targetId?: string; detail?: Record<string, unknown> },
): Promise<void> {
  await db.query(
    `INSERT INTO core.audit_log (org_id, project_id, actor_user_id, actor_device_id, action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [entry.orgId ?? null, entry.projectId ?? null, entry.actorUserId ?? null, entry.deviceId ?? null, entry.action,
      entry.targetType ?? null, entry.targetId ?? null, JSON.stringify(entry.detail ?? {})],
  );
}

export async function createOrganization(db: Queryable, slug: string, name: string): Promise<{ id: string; slug: string }> {
  const [row] = await db.query<{ id: string; slug: string }>(
    'INSERT INTO core.organizations (slug, name) VALUES ($1, $2) RETURNING id, slug',
    [slug, name],
  );
  await audit(db, { action: 'org.create', orgId: row.id, targetType: 'organization', targetId: row.id, detail: { slug } });
  return row;
}

export async function createUser(
  db: Queryable,
  input: { email: string; displayName: string; orgSlug?: string; role?: OrgMembership['role'] },
): Promise<{ id: string; email: string }> {
  const [user] = await db.query<{ id: string; email: string }>(
    'INSERT INTO core.users (email, display_name) VALUES ($1, $2) RETURNING id, email::text AS email',
    [input.email, input.displayName],
  );
  if (input.orgSlug) await addOrgMember(db, input.orgSlug, user.id, input.role ?? 'member');
  await audit(db, { action: 'user.create', targetType: 'user', targetId: user.id, detail: { email: input.email } });
  return user;
}

export async function addOrgMember(db: Queryable, orgSlug: string, userId: string, role: OrgMembership['role']): Promise<void> {
  const [org] = await db.query<{ id: string }>('SELECT id FROM core.organizations WHERE slug = $1', [orgSlug]);
  if (!org) throw new HttpError(404, 'org_not_found', `organization "${orgSlug}" does not exist`);
  await db.query(
    `INSERT INTO core.org_members (org_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role`,
    [org.id, userId, role],
  );
  await audit(db, { action: 'org.member.set', orgId: org.id, targetType: 'user', targetId: userId, detail: { role } });
}

/** Issue a personal access token. The plaintext is returned once and never stored. */
export async function issueToken(
  db: Queryable,
  input: { email: string; name: string; expiresAt?: Date },
): Promise<{ id: string; token: string }> {
  const [user] = await db.query<{ id: string }>('SELECT id FROM core.users WHERE email = $1 AND disabled_at IS NULL', [input.email]);
  if (!user) throw new HttpError(404, 'user_not_found', `no active user with email ${input.email}`);
  const token = generateToken();
  const [row] = await db.query<{ id: string }>(
    'INSERT INTO core.api_tokens (user_id, name, token_sha256, expires_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [user.id, input.name, hashToken(token), input.expiresAt ?? null],
  );
  await audit(db, { action: 'token.issue', actorUserId: user.id, targetType: 'api_token', targetId: row.id, detail: { name: input.name } });
  return { id: row.id, token };
}

export async function revokeToken(db: Queryable, tokenId: string): Promise<boolean> {
  const rows = await db.query<{ id: string; user_id: string }>(
    'UPDATE core.api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id, user_id',
    [tokenId],
  );
  if (rows[0]) await audit(db, { action: 'token.revoke', actorUserId: rows[0].user_id, targetType: 'api_token', targetId: tokenId });
  return rows.length > 0;
}

export async function authenticate(db: Queryable, authorization: string | undefined): Promise<AuthUser> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match || !match[1].startsWith(TOKEN_PREFIX)) {
    throw new HttpError(401, 'unauthorized', 'a Bearer personal access token is required');
  }
  const [row] = await db.query<{ token_id: string; user_id: string; email: string; display_name: string }>(
    `UPDATE core.api_tokens t SET last_used_at = now()
       FROM core.users u
      WHERE t.token_sha256 = $1 AND u.id = t.user_id
        AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
        AND u.disabled_at IS NULL
      RETURNING t.id AS token_id, u.id AS user_id, u.email::text AS email, u.display_name`,
    [hashToken(match[1])],
  );
  if (!row) throw new HttpError(401, 'unauthorized', 'the token is unknown, expired or revoked');
  return { id: row.user_id, email: row.email, displayName: row.display_name, tokenId: row.token_id };
}

export async function listMemberships(db: Queryable, userId: string): Promise<OrgMembership[]> {
  return db.query<OrgMembership>(
    `SELECT o.id AS "orgId", o.slug, o.name, m.role
       FROM core.org_members m JOIN core.organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 ORDER BY o.slug`,
    [userId],
  );
}

const PROJECT_COLUMNS = `p.id, p.org_id AS "orgId", p.slug, p.name, p.legacy_project_ids AS "legacyProjectIds", p.created_at AS "createdAt"`;

export async function listProjects(db: Queryable, userId: string): Promise<ProjectRecord[]> {
  return db.query<ProjectRecord>(
    `SELECT ${PROJECT_COLUMNS}
       FROM core.projects p JOIN core.org_members m ON m.org_id = p.org_id
      WHERE m.user_id = $1 AND p.archived_at IS NULL ORDER BY p.slug`,
    [userId],
  );
}

/** The single authorization point for project-scoped requests in Phase 4. Unknown and forbidden look the same. */
export async function assertProjectAccess(db: Queryable, user: AuthUser, projectId: string): Promise<ProjectRecord> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new HttpError(404, 'project_not_found', 'project not found');
  const [project] = await db.query<ProjectRecord>(
    `SELECT ${PROJECT_COLUMNS}
       FROM core.projects p JOIN core.org_members m ON m.org_id = p.org_id
      WHERE p.id = $1 AND m.user_id = $2 AND p.archived_at IS NULL`,
    [projectId, user.id],
  );
  if (!project) throw new HttpError(404, 'project_not_found', 'project not found');
  return project;
}

export interface ResolveProjectInput {
  legacyProjectId: string;
  rootCommit?: string;
  remoteUrls?: string[];
  create?: { orgSlug?: string; slug?: string; name?: string };
}

/**
 * Find the project a working copy belongs to, by Memorix project id or by the
 * repository root commit; optionally create it. Used by `pmi project link`.
 */
export async function resolveProject(
  db: Queryable,
  user: AuthUser,
  input: ResolveProjectInput,
): Promise<{ project: ProjectRecord; created: boolean }> {
  const visible = await db.query<ProjectRecord>(
    `SELECT DISTINCT ${PROJECT_COLUMNS}
       FROM core.projects p
       JOIN core.org_members m ON m.org_id = p.org_id AND m.user_id = $1
       LEFT JOIN core.repositories r ON r.project_id = p.id
      WHERE p.archived_at IS NULL
        AND ($2 = ANY (p.legacy_project_ids) OR ($3::text IS NOT NULL AND r.root_commit = $3))`,
    [user.id, input.legacyProjectId, input.rootCommit ?? null],
  );
  if (visible.length > 1) {
    throw new HttpError(409, 'ambiguous_project', 'several projects match this repository; pass --project explicitly',
      visible.map((project) => ({ id: project.id, slug: project.slug })));
  }
  let project = visible[0];
  let created = false;
  if (project && !project.legacyProjectIds.includes(input.legacyProjectId)) {
    // Sync rows carry the Memorix project id; mixing two ids in one project
    // would split its memory silently. Mapping between ids comes with the
    // `.pmi/project.json` identity in Phase 5.
    throw new HttpError(409, 'identity_mismatch',
      `this repository is linked to project "${project.slug}" under ${project.legacyProjectIds.join(', ')}, but the local project id is ${input.legacyProjectId}`);
  }
  if (!project) {
    if (!input.create) throw new HttpError(404, 'project_not_found', 'no project is linked to this repository yet');
    const memberships = await listMemberships(db, user.id);
    const org = input.create.orgSlug
      ? memberships.find((membership) => membership.slug === input.create!.orgSlug)
      : memberships.length === 1 ? memberships[0] : undefined;
    if (!org) {
      throw new HttpError(input.create.orgSlug ? 404 : 400, 'org_required',
        input.create.orgSlug ? `you are not a member of organization "${input.create.orgSlug}"` : 'choose an organization with --org');
    }
    if (org.role === 'member') throw new HttpError(403, 'forbidden', 'only organization owners and admins may create projects');
    const slug = input.create.slug ?? slugify(input.legacyProjectId);
    [project] = await db.query<ProjectRecord>(
      `INSERT INTO core.projects AS p (org_id, slug, name, legacy_project_ids) VALUES ($1, $2, $3, ARRAY[$4])
       RETURNING ${PROJECT_COLUMNS}`,
      [org.orgId, slug, input.create.name ?? input.legacyProjectId, input.legacyProjectId],
    );
    await db.query('INSERT INTO work.project_seq (project_id, next_seq) VALUES ($1, 1)', [project.id]);
    created = true;
    await audit(db, { action: 'project.create', actorUserId: user.id, orgId: org.orgId, projectId: project.id, targetType: 'project', targetId: project.id, detail: { slug } });
  }
  if (input.rootCommit) {
    await db.query(
      `INSERT INTO core.repositories (project_id, root_commit, remote_urls) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, root_commit) DO UPDATE
         SET remote_urls = ARRAY(SELECT DISTINCT unnest(core.repositories.remote_urls || excluded.remote_urls))`,
      [project.id, input.rootCommit, input.remoteUrls ?? []],
    );
  }
  return { project, created };
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'project';
}
