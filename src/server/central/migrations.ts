/**
 * Postgres schema migrations for the central server (docs/PMI/DATABASE.md §2).
 *
 * Migrations are append-only: never edit one that has shipped, add a new one.
 * They are embedded as strings so the bundled CLI needs no SQL files on disk.
 * Each runs in its own transaction under an advisory lock, so two server
 * replicas starting together cannot apply the same step twice.
 */
import type { Database } from './db.js';

export interface PgMigration {
  id: string;
  sql: string;
}

export const PG_MIGRATIONS: PgMigration[] = [
  {
    id: '0001-core-memory',
    sql: `
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS memory;
CREATE SCHEMA IF NOT EXISTS work;

CREATE TABLE core.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  display_name text NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.org_members (
  org_id uuid REFERENCES core.organizations ON DELETE CASCADE,
  user_id uuid REFERENCES core.users ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE core.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES core.organizations ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  legacy_project_ids text[] NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
CREATE INDEX projects_legacy_ids ON core.projects USING gin (legacy_project_ids);

CREATE TABLE core.repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  root_commit text,
  remote_urls text[] NOT NULL DEFAULT '{}',
  default_branch text,
  UNIQUE (project_id, root_commit)
);

CREATE TABLE core.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES core.users ON DELETE CASCADE,
  name text NOT NULL,
  token_sha256 bytea UNIQUE NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  org_id uuid,
  project_id uuid,
  actor_user_id uuid,
  actor_device_id text,
  action text NOT NULL,
  target_type text,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_project_at ON core.audit_log (project_id, at DESC);

CREATE TYPE memory.category AS ENUM (
  'project_overview','architecture','component','dependency','architecture_decision',
  'business_logic','coding_convention','issue','solution','known_limitation',
  'development_history','current_state','active_task','completed_task',
  'session_history','git_history'
);
CREATE TYPE memory.confidence AS ENUM ('observed','inferred','proposed','confirmed','deprecated');
CREATE TYPE memory.status AS ENUM ('active','needs_review','resolved','archived');

-- One row per logical memory, keyed by the client sync key. Tombstoned rows
-- stay (deleted_at set) so a stale replica can never resurrect them.
CREATE TABLE memory.memories (
  id text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  legacy_project_id text NOT NULL,
  category memory.category NOT NULL,
  confidence memory.confidence NOT NULL,
  status memory.status NOT NULL DEFAULT 'active',
  title text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  component text,
  topic_key text,
  source text NOT NULL DEFAULT 'agent',
  author_user_id uuid REFERENCES core.users,
  author_agent text,
  session_id text,
  related_files text[] NOT NULL DEFAULT '{}',
  related_commits text[] NOT NULL DEFAULT '{}',
  body jsonb,
  content_hash text NOT NULL DEFAULT '',
  tokens int NOT NULL DEFAULT 0,
  revision int NOT NULL,
  writer text NOT NULL,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'B')) STORED,
  embedding vector(384),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  server_seq bigint NOT NULL
);
CREATE INDEX memories_project_category ON memory.memories (project_id, category, status) WHERE deleted_at IS NULL;
CREATE INDEX memories_project_topic ON memory.memories (project_id, topic_key) WHERE topic_key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX memories_project_hash ON memory.memories (project_id, content_hash);
CREATE INDEX memories_search ON memory.memories USING gin (search);
CREATE INDEX memories_related_files ON memory.memories USING gin (related_files);
CREATE INDEX memories_embedding ON memory.memories USING hnsw (embedding vector_cosine_ops);

CREATE TABLE memory.memory_versions (
  memory_id text REFERENCES memory.memories ON DELETE CASCADE,
  version int NOT NULL,
  snapshot jsonb,
  deleted boolean NOT NULL DEFAULT false,
  changed_by_user uuid,
  changed_by_device text,
  change_reason text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, version)
);

CREATE TABLE memory.memory_links (
  from_id text REFERENCES memory.memories ON DELETE CASCADE,
  to_id text REFERENCES memory.memories ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('relates','supersedes','contradicts','depends_on','explains','derived_from')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id, kind)
);

CREATE TABLE memory.conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  memory_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('concurrent_edit','contradiction','duplicate')),
  detected_by text NOT NULL,
  winner jsonb NOT NULL,
  loser jsonb NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','dismissed')),
  resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conflicts_project_state ON memory.conflicts (project_id, state, created_at DESC);

CREATE TABLE work.project_seq (
  project_id uuid PRIMARY KEY REFERENCES core.projects ON DELETE CASCADE,
  next_seq bigint NOT NULL
);

CREATE TABLE work.changes (
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  seq bigint NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  op text NOT NULL CHECK (op IN ('upsert','delete')),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, seq)
);
`,
  },
  {
    // Phase 5: teams, per-project grants and row-level security. Project data
    // is read and written under the NOLOGIN role pmi_app with app.user_id set
    // per transaction; policies call core.can(), so a bug in the service
    // layer still cannot return another project's rows.
    id: '0002-rbac-rls',
    sql: `
CREATE TABLE core.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES core.organizations ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE core.team_members (
  team_id uuid REFERENCES core.teams ON DELETE CASCADE,
  user_id uuid REFERENCES core.users ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE core.project_grants (
  project_id uuid REFERENCES core.projects ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user','team')),
  principal_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('maintainer','developer','viewer')),
  granted_by uuid REFERENCES core.users,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, principal_type, principal_id)
);
CREATE INDEX project_grants_principal ON core.project_grants (principal_type, principal_id);

-- Phase 4 gave every organization member access to every project of the
-- organization. Keep that access explicitly so the upgrade locks nobody out.
INSERT INTO core.project_grants (project_id, principal_type, principal_id, role)
SELECT p.id, 'user', m.user_id, 'developer'
  FROM core.projects p JOIN core.org_members m ON m.org_id = p.org_id
 WHERE m.role = 'member'
ON CONFLICT DO NOTHING;

ALTER TABLE memory.memories ADD COLUMN confirmed_by uuid REFERENCES core.users;
ALTER TABLE memory.memories ADD COLUMN confirmed_at timestamptz;

CREATE FUNCTION core.role_rank(role text) RETURNS int
  LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE role WHEN 'admin' THEN 4 WHEN 'maintainer' THEN 3 WHEN 'developer' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END
$f$;

-- Effective project role: organization owners/admins act as 'admin' on every
-- project of their organization; others get the highest grant held directly
-- or through a team, and only while they remain organization members.
CREATE FUNCTION core.project_role_of(p_project uuid, p_user uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $f$
  SELECT role FROM (
    SELECT 'admin' AS role
      FROM core.projects p
      JOIN core.org_members m ON m.org_id = p.org_id
      JOIN core.users u ON u.id = m.user_id AND u.disabled_at IS NULL
     WHERE p.id = p_project AND m.user_id = p_user AND m.role IN ('owner','admin') AND p.archived_at IS NULL
    UNION ALL
    SELECT g.role
      FROM core.project_grants g
      JOIN core.projects p ON p.id = g.project_id AND p.archived_at IS NULL
      JOIN core.org_members m ON m.org_id = p.org_id AND m.user_id = p_user
      JOIN core.users u ON u.id = p_user AND u.disabled_at IS NULL
     WHERE g.project_id = p_project
       AND ((g.principal_type = 'user' AND g.principal_id = p_user)
         OR (g.principal_type = 'team' AND g.principal_id IN (SELECT team_id FROM core.team_members WHERE user_id = p_user)))
  ) roles
  ORDER BY core.role_rank(role) DESC
  LIMIT 1
$f$;

CREATE FUNCTION core.current_app_user() RETURNS uuid
  LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$f$;

CREATE FUNCTION core.can(p_project uuid, p_min_role text) RETURNS boolean
  LANGUAGE sql STABLE AS $f$
  SELECT p_project IS NOT NULL
     AND core.current_app_user() IS NOT NULL
     AND core.role_rank(core.project_role_of(p_project, core.current_app_user())) >= core.role_rank(p_min_role)
$f$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmi_app') THEN
    CREATE ROLE pmi_app NOLOGIN;
  END IF;
END
$do$;
GRANT pmi_app TO CURRENT_USER;

GRANT USAGE ON SCHEMA core, memory, work TO pmi_app;
GRANT SELECT, INSERT, UPDATE ON memory.memories, memory.memory_versions, memory.memory_links, memory.conflicts TO pmi_app;
GRANT SELECT, INSERT ON work.changes TO pmi_app;
GRANT SELECT, UPDATE ON work.project_seq TO pmi_app;
GRANT INSERT ON core.audit_log TO pmi_app;
GRANT USAGE ON SEQUENCE core.audit_log_id_seq TO pmi_app;

ALTER TABLE memory.memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY memories_read ON memory.memories FOR SELECT TO pmi_app USING (core.can(project_id, 'viewer'));
CREATE POLICY memories_insert ON memory.memories FOR INSERT TO pmi_app WITH CHECK (core.can(project_id, 'developer'));
CREATE POLICY memories_update ON memory.memories FOR UPDATE TO pmi_app
  USING (core.can(project_id, 'developer')) WITH CHECK (core.can(project_id, 'developer'));

ALTER TABLE memory.memory_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY versions_read ON memory.memory_versions FOR SELECT TO pmi_app
  USING (core.can((SELECT m.project_id FROM memory.memories m WHERE m.id = memory_id), 'viewer'));
CREATE POLICY versions_insert ON memory.memory_versions FOR INSERT TO pmi_app
  WITH CHECK (core.can((SELECT m.project_id FROM memory.memories m WHERE m.id = memory_id), 'developer'));

ALTER TABLE memory.memory_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY links_read ON memory.memory_links FOR SELECT TO pmi_app
  USING (core.can((SELECT m.project_id FROM memory.memories m WHERE m.id = from_id), 'viewer'));
CREATE POLICY links_write ON memory.memory_links FOR INSERT TO pmi_app
  WITH CHECK (core.can((SELECT m.project_id FROM memory.memories m WHERE m.id = from_id), 'developer'));

ALTER TABLE memory.conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY conflicts_read ON memory.conflicts FOR SELECT TO pmi_app USING (core.can(project_id, 'viewer'));
CREATE POLICY conflicts_insert ON memory.conflicts FOR INSERT TO pmi_app WITH CHECK (core.can(project_id, 'developer'));
CREATE POLICY conflicts_update ON memory.conflicts FOR UPDATE TO pmi_app USING (core.can(project_id, 'developer'));

ALTER TABLE work.changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY changes_read ON work.changes FOR SELECT TO pmi_app USING (core.can(project_id, 'viewer'));
CREATE POLICY changes_insert ON work.changes FOR INSERT TO pmi_app WITH CHECK (core.can(project_id, 'developer'));

ALTER TABLE work.project_seq ENABLE ROW LEVEL SECURITY;
CREATE POLICY seq_read ON work.project_seq FOR SELECT TO pmi_app USING (core.can(project_id, 'viewer'));
CREATE POLICY seq_update ON work.project_seq FOR UPDATE TO pmi_app USING (core.can(project_id, 'developer'));

REVOKE UPDATE, DELETE, TRUNCATE ON core.audit_log FROM PUBLIC, pmi_app;

-- Memory ids are global. Row-level security hides a row of another project,
-- so the sync path asks which project owns a key before writing it.
CREATE FUNCTION memory.memory_project(p_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = memory, pg_temp AS $f$
  SELECT project_id FROM memory.memories WHERE id = p_id
$f$;
`,
  },
  {
    // Phase 6: sessions with leases, immutable checkpoints (SESSION_CONTINUITY.md).
    id: '0003-sessions',
    sql: `
CREATE TABLE work.sessions (
  id text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES core.users,
  device_id text NOT NULL,
  agent text,
  model_provider text,
  model text,
  status text NOT NULL CHECK (status IN ('created','in_progress','checkpointed','interrupted',
                                         'waiting_handoff','resumable','completed','failed')),
  task text NOT NULL DEFAULT '',
  objective text NOT NULL DEFAULT '',
  state jsonb NOT NULL,
  parent_session_id text REFERENCES work.sessions,
  continued_by text,
  lease_device text,
  lease_user uuid,
  lease_expires_at timestamptz,
  handoff_to uuid REFERENCES core.users,
  handoff_reserved_until timestamptz,
  handoff_brief text,
  last_checkpoint_id text,
  last_checkpoint_seq int NOT NULL DEFAULT 0,
  git_branch text,
  git_head text,
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_project_status ON work.sessions (project_id, status, updated_at DESC);
CREATE INDEX sessions_lease_expiry ON work.sessions (lease_expires_at) WHERE status IN ('created','in_progress','checkpointed');

CREATE TABLE work.checkpoints (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES work.sessions ON DELETE CASCADE,
  seq int NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('timer','fs_change','commit','decision','manual','compact','exit','handoff')),
  state jsonb NOT NULL,
  created_by_user uuid NOT NULL,
  device_id text NOT NULL,
  orphan boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

GRANT SELECT, INSERT, UPDATE ON work.sessions, work.checkpoints TO pmi_app;

ALTER TABLE work.sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_read ON work.sessions FOR SELECT TO pmi_app USING (core.can(project_id, 'viewer'));
CREATE POLICY sessions_insert ON work.sessions FOR INSERT TO pmi_app WITH CHECK (core.can(project_id, 'developer'));
CREATE POLICY sessions_update ON work.sessions FOR UPDATE TO pmi_app
  USING (core.can(project_id, 'developer')) WITH CHECK (core.can(project_id, 'developer'));

-- Session ids are generated by clients and global; RLS hides other projects'
-- rows, so writers ask which project owns an id before inserting.
CREATE FUNCTION work.session_project(p_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = work, pg_temp AS $f$
  SELECT project_id FROM work.sessions WHERE id = p_id
$f$;

-- Session lists show who runs each session; pmi_app has no access to core.users.
CREATE FUNCTION core.user_email(p_user uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $f$
  SELECT email::text FROM core.users WHERE id = p_user
$f$;

-- Checkpoint state is developer-only (SESSION_CONTINUITY.md §8).
ALTER TABLE work.checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY checkpoints_read ON work.checkpoints FOR SELECT TO pmi_app
  USING (core.can((SELECT s.project_id FROM work.sessions s WHERE s.id = session_id), 'developer'));
CREATE POLICY checkpoints_insert ON work.checkpoints FOR INSERT TO pmi_app
  WITH CHECK (core.can((SELECT s.project_id FROM work.sessions s WHERE s.id = session_id), 'developer'));
`,
  },
];

const MIGRATION_LOCK_KEY = 74_201_001;

export interface MigrationReport {
  applied: string[];
  current: string | null;
}

/** Apply pending migrations; `until` stops after that id (used to test upgrades from an older schema). */
export async function migrate(db: Database, options: { until?: string } = {}): Promise<MigrationReport> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await tx.query(`CREATE TABLE IF NOT EXISTS public.pmi_schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await tx.query<{ id: string }>('SELECT id FROM public.pmi_schema_migrations')).map((row) => row.id));
    const applied: string[] = [];
    for (const migration of PG_MIGRATIONS) {
      if (done.has(migration.id)) continue;
      await tx.query(migration.sql);
      await tx.query('INSERT INTO public.pmi_schema_migrations (id) VALUES ($1)', [migration.id]);
      applied.push(migration.id);
      if (migration.id === options.until) break;
    }
    return { applied, current: PG_MIGRATIONS.at(-1)?.id ?? null };
  });
}

/** Migration ids not yet applied; empty when the schema is current. */
export async function pendingMigrations(db: Database): Promise<string[]> {
  const [exists] = await db.query<{ name: string | null }>("SELECT to_regclass('public.pmi_schema_migrations')::text AS name");
  if (!exists?.name) return PG_MIGRATIONS.map((migration) => migration.id);
  const done = new Set((await db.query<{ id: string }>('SELECT id FROM public.pmi_schema_migrations')).map((row) => row.id));
  return PG_MIGRATIONS.filter((migration) => !done.has(migration.id)).map((migration) => migration.id);
}
