/**
 * Organizations, users, teams, API tokens, projects and grants on the central
 * server, plus `authorize()` — the single service-layer authorization point
 * (docs/baton/DATABASE.md §4).
 *
 * Effective project role (computed in SQL by core.project_role_of, the same
 * function row-level security uses): organization owners/admins are `admin`
 * on every project of their organization; everyone else gets the highest
 * grant held directly or through a team. No role means the project is
 * invisible: callers get 404, never a hint that it exists.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from './db.js';

export const TOKEN_PREFIX = 'baton_pat_';

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

export type ProjectRole = 'viewer' | 'developer' | 'maintainer' | 'admin';
export type GrantRole = Exclude<ProjectRole, 'admin'>;

export type ProjectAction =
  | 'memory.read'
  | 'memory.write'
  | 'memory.confirm'
  | 'session.read'
  | 'session.write'
  | 'session.force'
  | 'snapshot.read'
  | 'snapshot.write'
  | 'git.analyze'
  | 'project.manage';

const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, developer: 2, maintainer: 3, admin: 4 };

/** Minimum project role per action — the RBAC matrix of DATABASE.md §4. */
export const ACTION_MIN_ROLE: Record<ProjectAction, ProjectRole> = {
  'memory.read': 'viewer',
  'memory.write': 'developer',
  'memory.confirm': 'developer',
  // Viewers see the session list without state; state, briefs and resume need developer.
  'session.read': 'viewer',
  'session.write': 'developer',
  'session.force': 'maintainer',
  // Snapshots carry working-copy code (WORKSPACE_RECOVERY.md, SESSION_CONTINUITY.md §8).
  'snapshot.read': 'developer',
  'snapshot.write': 'developer',
  'git.analyze': 'developer',
  'project.manage': 'maintainer',
};

export function roleAllows(role: ProjectRole | null | undefined, action: ProjectAction): boolean {
  return Boolean(role) && ROLE_RANK[role!] >= ROLE_RANK[ACTION_MIN_ROLE[action]];
}

export interface AuthorizedProject extends ProjectRecord {
  role: ProjectRole;
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

/** Projects the user holds any role on, with that role. */
export async function listProjects(db: Queryable, userId: string): Promise<AuthorizedProject[]> {
  return db.query<AuthorizedProject>(
    `SELECT * FROM (
       SELECT ${PROJECT_COLUMNS}, core.project_role_of(p.id, $1) AS role
         FROM core.projects p WHERE p.archived_at IS NULL
     ) visible WHERE role IS NOT NULL ORDER BY slug`,
    [userId],
  );
}

/**
 * The single authorization point for project-scoped requests. A project the
 * user cannot read is reported as not found (404); a readable project with an
 * insufficient role is 403, and the denial is audited.
 */
export async function authorize(db: Queryable, user: AuthUser, projectId: string, action: ProjectAction): Promise<AuthorizedProject> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new HttpError(404, 'project_not_found', 'project not found');
  const [project] = await db.query<AuthorizedProject>(
    `SELECT ${PROJECT_COLUMNS}, core.project_role_of(p.id, $2) AS role
       FROM core.projects p WHERE p.id = $1 AND p.archived_at IS NULL`,
    [projectId, user.id],
  );
  if (!project?.role) throw new HttpError(404, 'project_not_found', 'project not found');
  if (!roleAllows(project.role, action)) {
    await audit(db, { action: 'access.denied', actorUserId: user.id, orgId: project.orgId, projectId: project.id, detail: { attempted: action, role: project.role } });
    throw new HttpError(403, 'forbidden', `${action} requires the ${ACTION_MIN_ROLE[action]} role on this project (you are ${project.role})`);
  }
  return project;
}

export async function createTeam(db: Queryable, orgSlug: string, name: string, actorUserId?: string): Promise<{ id: string; name: string }> {
  const [org] = await db.query<{ id: string }>('SELECT id FROM core.organizations WHERE slug = $1', [orgSlug]);
  if (!org) throw new HttpError(404, 'org_not_found', `organization "${orgSlug}" does not exist`);
  const [team] = await db.query<{ id: string; name: string }>(
    'INSERT INTO core.teams (org_id, name) VALUES ($1, $2) RETURNING id, name',
    [org.id, name],
  );
  await audit(db, { action: 'team.create', actorUserId, orgId: org.id, targetType: 'team', targetId: team.id, detail: { name } });
  return team;
}

export async function addTeamMember(db: Queryable, teamId: string, userId: string, actorUserId?: string): Promise<void> {
  const [team] = await db.query<{ org_id: string }>('SELECT org_id FROM core.teams WHERE id = $1', [teamId]);
  if (!team) throw new HttpError(404, 'team_not_found', 'team not found');
  const [member] = await db.query('SELECT 1 FROM core.org_members WHERE org_id = $1 AND user_id = $2', [team.org_id, userId]);
  if (!member) throw new HttpError(422, 'not_org_member', 'only members of the team\'s organization can join it');
  await db.query('INSERT INTO core.team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [teamId, userId]);
  await audit(db, { action: 'team.member.add', actorUserId, orgId: team.org_id, targetType: 'user', targetId: userId, detail: { teamId } });
}

export interface GrantInput {
  principalType: 'user' | 'team';
  principalId: string;
  role: GrantRole | null;
}

/** Set (or with role null, revoke) a project grant. The principal must belong to the project's organization. */
export async function setProjectGrant(db: Queryable, project: ProjectRecord, input: GrantInput, actorUserId?: string): Promise<void> {
  const principalOrg = input.principalType === 'team'
    ? await db.query('SELECT 1 FROM core.teams WHERE id = $1 AND org_id = $2', [input.principalId, project.orgId])
    : await db.query('SELECT 1 FROM core.org_members WHERE user_id = $1 AND org_id = $2', [input.principalId, project.orgId]);
  if (principalOrg.length === 0) {
    throw new HttpError(422, 'principal_outside_org', `the ${input.principalType} is not part of the project's organization`);
  }
  if (input.role === null) {
    await db.query(
      'DELETE FROM core.project_grants WHERE project_id = $1 AND principal_type = $2 AND principal_id = $3',
      [project.id, input.principalType, input.principalId],
    );
  } else {
    await db.query(
      `INSERT INTO core.project_grants (project_id, principal_type, principal_id, role, granted_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, principal_type, principal_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = now()`,
      [project.id, input.principalType, input.principalId, input.role, actorUserId ?? null],
    );
  }
  await audit(db, {
    action: input.role === null ? 'grant.revoke' : 'grant.set',
    actorUserId,
    orgId: project.orgId,
    projectId: project.id,
    targetType: input.principalType,
    targetId: input.principalId,
    detail: { role: input.role },
  });
}

export async function listProjectGrants(db: Queryable, projectId: string): Promise<Array<{ principalType: string; principalId: string; principal: string; role: GrantRole }>> {
  return db.query(
    `SELECT g.principal_type AS "principalType", g.principal_id AS "principalId", g.role,
            COALESCE(u.email::text, t.name) AS principal
       FROM core.project_grants g
       LEFT JOIN core.users u ON g.principal_type = 'user' AND u.id = g.principal_id
       LEFT JOIN core.teams t ON g.principal_type = 'team' AND t.id = g.principal_id
      WHERE g.project_id = $1 ORDER BY g.principal_type, principal`,
    [projectId],
  );
}

export async function findUserByEmail(db: Queryable, email: string): Promise<{ id: string } | undefined> {
  const [user] = await db.query<{ id: string }>('SELECT id FROM core.users WHERE email = $1', [email]);
  return user;
}

export async function findTeam(db: Queryable, orgSlug: string, name: string): Promise<{ id: string } | undefined> {
  const [team] = await db.query<{ id: string }>(
    'SELECT t.id FROM core.teams t JOIN core.organizations o ON o.id = t.org_id WHERE o.slug = $1 AND t.name = $2',
    [orgSlug, name],
  );
  return team;
}

export interface ResolveProjectInput {
  legacyProjectId: string;
  rootCommit?: string;
  remoteUrls?: string[];
  /** Pick one of several matching projects: its id, slug or `org/slug`. */
  project?: string;
  create?: { orgSlug?: string; slug?: string; name?: string };
}

export interface ProjectCandidate {
  id: string;
  slug: string;
  org: string;
  name: string;
  legacyProjectIds: string[];
}

/**
 * Find the project a working copy belongs to, by Baton project id or by the
 * repository root commit; optionally create it. Used by `baton project link`.
 *
 * A fork shares the root commit with its upstream. The project replicating
 * this exact Baton id wins; a root-commit-only match is refused (or, with
 * `create`, the fork gets its own project). When several projects replicate
 * the id, the caller picks one with `project`, only among projects it sees.
 */
export async function resolveProject(
  db: Queryable,
  user: AuthUser,
  input: ResolveProjectInput,
): Promise<{ project: ProjectRecord; created: boolean }> {
  const visible = await db.query<ProjectRecord & { org: string }>(
    `SELECT DISTINCT ${PROJECT_COLUMNS}, o.slug AS org
       FROM core.projects p
       JOIN core.organizations o ON o.id = p.org_id
       LEFT JOIN core.repositories r ON r.project_id = p.id
      WHERE p.archived_at IS NULL
        AND core.project_role_of(p.id, $1) IS NOT NULL
        AND ($2 = ANY (p.legacy_project_ids) OR ($3::text IS NOT NULL AND r.root_commit = $3))`,
    [user.id, input.legacyProjectId, input.rootCommit ?? null],
  );
  const candidates = (rows: typeof visible): ProjectCandidate[] => rows.map(({ id, slug, org, name, legacyProjectIds }) => ({ id, slug, org, name, legacyProjectIds }));
  const exact = visible.filter((p) => p.legacyProjectIds.includes(input.legacyProjectId));
  let chosen: (ProjectRecord & { org: string }) | undefined;
  if (input.project) {
    const ref = input.project;
    const picked = visible.filter((p) => p.id === ref || p.slug === ref || `${p.org}/${p.slug}` === ref);
    if (picked.length === 0) throw new HttpError(404, 'project_not_found', `no project "${ref}" matches this repository`, candidates(visible));
    if (picked.length > 1) throw new HttpError(409, 'ambiguous_project', `"${ref}" names several projects; use org/slug or the id`, candidates(picked));
    chosen = picked[0];
  } else if (exact.length > 1) {
    throw new HttpError(409, 'ambiguous_project', 'several projects replicate this repository; choose one with --project <org/slug>', candidates(exact));
  } else {
    chosen = exact[0];
  }
  if (chosen && !chosen.legacyProjectIds.includes(input.legacyProjectId)) {
    // Sync rows carry the Baton project id; mixing two ids in one project
    // would split its memory silently.
    throw new HttpError(409, 'identity_mismatch',
      `project "${chosen.slug}" replicates ${chosen.legacyProjectIds.join(', ')}, but the local project id is ${input.legacyProjectId}`,
      candidates([chosen]));
  }
  if (!chosen && visible.length > 0 && !input.create) {
    // Only the root commit matched: a fork or a renamed remote. A fork gets a
    // project of its own with --create.
    throw new HttpError(409, 'identity_mismatch',
      `this repository shares its first commit with ${visible.map((p) => `"${p.org}/${p.slug}"`).join(', ')}, but its local project id ${input.legacyProjectId} is not replicated there; ` +
      'for a fork, create its own project with --create', candidates(visible));
  }
  let project: ProjectRecord | undefined;
  if (chosen) {
    const { org: _org, ...record } = chosen;
    project = record;
  }
  let created = false;
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
