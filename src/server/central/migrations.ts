/**
 * Postgres schema migrations for the central server (docs/baton/DATABASE.md §2).
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
    // is read and written under the NOLOGIN role baton_app with app.user_id set
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

-- Roles are cluster-wide while the migration lock is per database: two
-- databases of one cluster migrating at once may both try to create the
-- role, so losing that race is not an error. (Same resulting schema; the
-- only change to this migration since it shipped.)
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'baton_app') THEN
    CREATE ROLE baton_app NOLOGIN;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$do$;
GRANT baton_app TO CURRENT_USER;

GRANT USAGE ON SCHEMA core, memory, work TO baton_app;
GRANT SELECT, INSERT, UPDATE ON memory.memories, memory.memory_versions, memory.memory_links, memory.conflicts TO baton_app;
GRANT SELECT, INSERT ON work.changes TO baton_app;
GRANT SELECT, UPDATE ON work.project_seq TO baton_app;
GRANT INSERT ON core.audit_log TO baton_app;
GRANT USAGE ON SEQUENCE core.audit_log_id_seq TO baton_app;

ALTER TABLE memory.memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY memories_read ON memory.memories FOR SELECT TO baton_app USING (core.can(project_id, 'viewer'));
CREATE POLICY memories_insert ON memory.memories FOR INSERT TO baton_app WITH CHECK (core.can(project_id, 'developer'));
CREATE POLICY memories_update ON memory.memories FOR UPDATE TO baton_app
  USING (core.can(project_id, 'developer')) WITH CHECK (core.can(project_id, 'developer'));

ALTER TABLE memory.memory_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY versions_read ON memory.memory_versions FOR SELECT TO baton_app
  USING (core.can((SELECT m.project_id FROM memory.memories m WHERE m.id = memory_id), 'viewer'));
CREATE POLICY versions_insert ON memory.memory_versions FOR INSERT TO baton_app
  WITH CHECK (core.can((SELECT m.project_id FROM memory.memories m WHERE m.id = memory_id), 'developer'));

ALTER TABLE memory.memory_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY links_read ON memory.memory_links FOR SELECT TO baton_app
  USING (core.can((SELECT m.project_id FROM memory.memories m WHERE m.id = from_id), 'viewer'));
CREATE POLICY links_write ON memory.memory_links FOR INSERT TO baton_app
  WITH CHECK (core.can((SELECT m.project_id FROM memory.memories m WHERE m.id = from_id), 'developer'));

ALTER TABLE memory.conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY conflicts_read ON memory.conflicts FOR SELECT TO baton_app USING (core.can(project_id, 'viewer'));
CREATE POLICY conflicts_insert ON memory.conflicts FOR INSERT TO baton_app WITH CHECK (core.can(project_id, 'developer'));
CREATE POLICY conflicts_update ON memory.conflicts FOR UPDATE TO baton_app USING (core.can(project_id, 'developer'));

ALTER TABLE work.changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY changes_read ON work.changes FOR SELECT TO baton_app USING (core.can(project_id, 'viewer'));
CREATE POLICY changes_insert ON work.changes FOR INSERT TO baton_app WITH CHECK (core.can(project_id, 'developer'));

ALTER TABLE work.project_seq ENABLE ROW LEVEL SECURITY;
CREATE POLICY seq_read ON work.project_seq FOR SELECT TO baton_app USING (core.can(project_id, 'viewer'));
CREATE POLICY seq_update ON work.project_seq FOR UPDATE TO baton_app USING (core.can(project_id, 'developer'));

REVOKE UPDATE, DELETE, TRUNCATE ON core.audit_log FROM PUBLIC, baton_app;

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

GRANT SELECT, INSERT, UPDATE ON work.sessions, work.checkpoints TO baton_app;

ALTER TABLE work.sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_read ON work.sessions FOR SELECT TO baton_app USING (core.can(project_id, 'viewer'));
CREATE POLICY sessions_insert ON work.sessions FOR INSERT TO baton_app WITH CHECK (core.can(project_id, 'developer'));
CREATE POLICY sessions_update ON work.sessions FOR UPDATE TO baton_app
  USING (core.can(project_id, 'developer')) WITH CHECK (core.can(project_id, 'developer'));

-- Session ids are generated by clients and global; RLS hides other projects'
-- rows, so writers ask which project owns an id before inserting.
CREATE FUNCTION work.session_project(p_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = work, pg_temp AS $f$
  SELECT project_id FROM work.sessions WHERE id = p_id
$f$;

-- Session lists show who runs each session; baton_app has no access to core.users.
CREATE FUNCTION core.user_email(p_user uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $f$
  SELECT email::text FROM core.users WHERE id = p_user
$f$;

-- Checkpoint state is developer-only (SESSION_CONTINUITY.md §8).
ALTER TABLE work.checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY checkpoints_read ON work.checkpoints FOR SELECT TO baton_app
  USING (core.can((SELECT s.project_id FROM work.sessions s WHERE s.id = session_id), 'developer'));
CREATE POLICY checkpoints_insert ON work.checkpoints FOR INSERT TO baton_app
  WITH CHECK (core.can((SELECT s.project_id FROM work.sessions s WHERE s.id = session_id), 'developer'));
`,
  },
  {
    // Phase 7: workspace snapshots and content-addressed blobs (WORKSPACE_RECOVERY.md §4).
    // Blob bodies are shared and deduplicated, but each project must upload
    // (prove possession of) a blob before it may reference or read it.
    id: '0004-workspace-snapshots',
    sql: `
CREATE TABLE work.blobs (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size bigint NOT NULL,
  storage text NOT NULL CHECK (storage IN ('inline','fs')),
  data bytea,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE work.project_blobs (
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  sha256 text NOT NULL REFERENCES work.blobs,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, sha256)
);

CREATE TABLE work.snapshots (
  id text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  session_id text REFERENCES work.sessions ON DELETE SET NULL,
  parent_snapshot_id text,
  base_commit text NOT NULL,
  branch text,
  manifest jsonb NOT NULL,
  manifest_sha256 text NOT NULL,
  total_bytes bigint NOT NULL,
  file_count int NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  created_by_user uuid NOT NULL,
  device_id text NOT NULL,
  created_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX snapshots_session ON work.snapshots (session_id, created_at DESC);
CREATE INDEX snapshots_project ON work.snapshots (project_id, created_at DESC);

CREATE TABLE work.snapshot_blobs (
  snapshot_id text NOT NULL REFERENCES work.snapshots ON DELETE CASCADE,
  project_id uuid NOT NULL,
  sha256 text NOT NULL,
  PRIMARY KEY (snapshot_id, sha256),
  FOREIGN KEY (project_id, sha256) REFERENCES work.project_blobs (project_id, sha256)
);

ALTER TABLE work.checkpoints ADD COLUMN snapshot_id text;

GRANT SELECT, INSERT ON work.project_blobs, work.snapshots, work.snapshot_blobs TO baton_app;
GRANT UPDATE (pinned) ON work.snapshots TO baton_app;

-- Snapshot contents are working-copy code: developer and above only.
ALTER TABLE work.project_blobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_blobs_read ON work.project_blobs FOR SELECT TO baton_app USING (core.can(project_id, 'developer'));
CREATE POLICY project_blobs_insert ON work.project_blobs FOR INSERT TO baton_app WITH CHECK (core.can(project_id, 'developer'));
ALTER TABLE work.snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY snapshots_read ON work.snapshots FOR SELECT TO baton_app USING (core.can(project_id, 'developer'));
CREATE POLICY snapshots_insert ON work.snapshots FOR INSERT TO baton_app WITH CHECK (core.can(project_id, 'developer'));
CREATE POLICY snapshots_update ON work.snapshots FOR UPDATE TO baton_app USING (core.can(project_id, 'developer'));
ALTER TABLE work.snapshot_blobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY snapshot_blobs_read ON work.snapshot_blobs FOR SELECT TO baton_app USING (core.can(project_id, 'developer'));
CREATE POLICY snapshot_blobs_insert ON work.snapshot_blobs FOR INSERT TO baton_app WITH CHECK (core.can(project_id, 'developer'));

CREATE FUNCTION work.snapshot_project(p_id text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = work, pg_temp AS $f$
  SELECT project_id FROM work.snapshots WHERE id = p_id
$f$;
`,
  },
  {
    // Phase 8: L1 overview cache and metric events (CONTEXT_ENGINE.md §2, §8).
    id: '0005-context',
    sql: `
CREATE TABLE memory.overviews (
  project_id uuid PRIMARY KEY REFERENCES core.projects ON DELETE CASCADE,
  content text NOT NULL,
  memory_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  tokens int NOT NULL,
  source_max_seq bigint NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE work.metrics_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  project_id uuid REFERENCES core.projects ON DELETE CASCADE,
  session_id text,
  user_id uuid,
  name text NOT NULL,
  value double precision NOT NULL,
  labels jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX metrics_events_name_at ON work.metrics_events (name, at DESC);
CREATE INDEX metrics_events_session ON work.metrics_events (session_id) WHERE session_id IS NOT NULL;

GRANT SELECT ON memory.overviews TO baton_app;
ALTER TABLE memory.overviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY overviews_read ON memory.overviews FOR SELECT TO baton_app USING (core.can(project_id, 'viewer'));
GRANT INSERT ON work.metrics_events TO baton_app;
GRANT USAGE ON SEQUENCE work.metrics_events_id_seq TO baton_app;
ALTER TABLE work.metrics_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY metrics_insert ON work.metrics_events FOR INSERT TO baton_app WITH CHECK (project_id IS NULL OR core.can(project_id, 'viewer'));
`,
  },
  {
    // Phase 9: incremental git analysis shared by every client of a project (CONTEXT_ENGINE.md §7).
    id: '0006-git-intelligence',
    sql: `
CREATE TABLE work.git_cursors (
  repository_id uuid NOT NULL REFERENCES core.repositories ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  branch text NOT NULL,
  last_analyzed_commit text NOT NULL,
  last_full_reconcile_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, branch)
);

CREATE TABLE work.git_commits (
  repository_id uuid NOT NULL REFERENCES core.repositories ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
  sha text NOT NULL,
  parents text[] NOT NULL,
  author text NOT NULL,
  committed_at timestamptz NOT NULL,
  subject text NOT NULL,
  changes jsonb NOT NULL,
  classification jsonb NOT NULL,
  rewritten boolean NOT NULL DEFAULT false,
  analyzed_at timestamptz NOT NULL DEFAULT now(),
  analyzed_by uuid,
  PRIMARY KEY (repository_id, sha)
);

GRANT SELECT, INSERT, UPDATE ON work.git_cursors TO baton_app;
GRANT SELECT, INSERT ON work.git_commits TO baton_app;
ALTER TABLE work.git_cursors ENABLE ROW LEVEL SECURITY;
CREATE POLICY git_cursors_read ON work.git_cursors FOR SELECT TO baton_app USING (core.can(project_id, 'viewer'));
CREATE POLICY git_cursors_write ON work.git_cursors FOR INSERT TO baton_app WITH CHECK (core.can(project_id, 'developer'));
CREATE POLICY git_cursors_update ON work.git_cursors FOR UPDATE TO baton_app USING (core.can(project_id, 'developer'));
ALTER TABLE work.git_commits ENABLE ROW LEVEL SECURITY;
CREATE POLICY git_commits_read ON work.git_commits FOR SELECT TO baton_app USING (core.can(project_id, 'viewer'));
CREATE POLICY git_commits_insert ON work.git_commits FOR INSERT TO baton_app WITH CHECK (core.can(project_id, 'developer'));
`,
  },
  {
    // Phase 10 (load test): row-level security evaluated core.project_role_of
    // for every row — a full scan at 100k memories. The same rules, but the
    // caller's project set is computed once per statement (an InitPlan) and
    // rows are matched with = ANY, so indexes apply again.
    id: '0007-rls-performance',
    sql: `
CREATE FUNCTION core.project_ids_with(p_min_role text) RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $f$
  SELECT COALESCE(array_agg(p.id), '{}')
    FROM core.projects p
   WHERE core.current_app_user() IS NOT NULL
     AND core.role_rank(core.project_role_of(p.id, core.current_app_user())) >= core.role_rank(p_min_role)
$f$;

ALTER POLICY memories_read ON memory.memories
  USING (project_id = ANY ((SELECT core.project_ids_with('viewer'))::uuid[]));
ALTER POLICY memories_insert ON memory.memories
  WITH CHECK (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY memories_update ON memory.memories
  USING (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]))
  WITH CHECK (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY versions_read ON memory.memory_versions
  USING (EXISTS (SELECT 1 FROM memory.memories m WHERE m.id = memory_id AND m.project_id = ANY ((SELECT core.project_ids_with('viewer'))::uuid[])));
ALTER POLICY versions_insert ON memory.memory_versions
  WITH CHECK (EXISTS (SELECT 1 FROM memory.memories m WHERE m.id = memory_id AND m.project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[])));
ALTER POLICY links_read ON memory.memory_links
  USING (EXISTS (SELECT 1 FROM memory.memories m WHERE m.id = from_id AND m.project_id = ANY ((SELECT core.project_ids_with('viewer'))::uuid[])));
ALTER POLICY links_write ON memory.memory_links
  WITH CHECK (EXISTS (SELECT 1 FROM memory.memories m WHERE m.id = from_id AND m.project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[])));
ALTER POLICY conflicts_read ON memory.conflicts
  USING (project_id = ANY ((SELECT core.project_ids_with('viewer'))::uuid[]));
ALTER POLICY conflicts_insert ON memory.conflicts
  WITH CHECK (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY conflicts_update ON memory.conflicts
  USING (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY changes_read ON work.changes
  USING (project_id = ANY ((SELECT core.project_ids_with('viewer'))::uuid[]));
ALTER POLICY changes_insert ON work.changes
  WITH CHECK (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY seq_read ON work.project_seq
  USING (project_id = ANY ((SELECT core.project_ids_with('viewer'))::uuid[]));
ALTER POLICY seq_update ON work.project_seq
  USING (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY sessions_read ON work.sessions
  USING (project_id = ANY ((SELECT core.project_ids_with('viewer'))::uuid[]));
ALTER POLICY sessions_insert ON work.sessions
  WITH CHECK (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY sessions_update ON work.sessions
  USING (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]))
  WITH CHECK (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY checkpoints_read ON work.checkpoints
  USING (EXISTS (SELECT 1 FROM work.sessions s WHERE s.id = session_id AND s.project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[])));
ALTER POLICY checkpoints_insert ON work.checkpoints
  WITH CHECK (EXISTS (SELECT 1 FROM work.sessions s WHERE s.id = session_id AND s.project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[])));
ALTER POLICY project_blobs_read ON work.project_blobs
  USING (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY project_blobs_insert ON work.project_blobs
  WITH CHECK (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY snapshots_read ON work.snapshots
  USING (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY snapshots_insert ON work.snapshots
  WITH CHECK (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY snapshots_update ON work.snapshots
  USING (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY snapshot_blobs_read ON work.snapshot_blobs
  USING (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY snapshot_blobs_insert ON work.snapshot_blobs
  WITH CHECK (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY overviews_read ON memory.overviews
  USING (project_id = ANY ((SELECT core.project_ids_with('viewer'))::uuid[]));
ALTER POLICY metrics_insert ON work.metrics_events
  WITH CHECK (project_id IS NULL OR project_id = ANY ((SELECT core.project_ids_with('viewer'))::uuid[]));
ALTER POLICY git_cursors_read ON work.git_cursors
  USING (project_id = ANY ((SELECT core.project_ids_with('viewer'))::uuid[]));
ALTER POLICY git_cursors_write ON work.git_cursors
  WITH CHECK (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY git_cursors_update ON work.git_cursors
  USING (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));
ALTER POLICY git_commits_read ON work.git_commits
  USING (project_id = ANY ((SELECT core.project_ids_with('viewer'))::uuid[]));
ALTER POLICY git_commits_insert ON work.git_commits
  WITH CHECK (project_id = ANY ((SELECT core.project_ids_with('developer'))::uuid[]));

CREATE INDEX IF NOT EXISTS conflicts_memory ON memory.conflicts (memory_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS memories_project_recent ON memory.memories (project_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS memories_project_component ON memory.memories (project_id, lower(component)) WHERE deleted_at IS NULL;
`,
  },
  {
    // A handed-off session stays handed off until someone resumes it: a
    // heartbeat or checkpoint that arrives late from the previous owner (its
    // daemon raced the handoff) must not bring it back to in_progress. A
    // release or an expired lease is not a handoff; the owner can still
    // pick the session up again.
    id: '0008-session-release',
    sql: `
ALTER TABLE work.sessions ADD COLUMN released_at timestamptz;
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
    await tx.query(`CREATE TABLE IF NOT EXISTS public.baton_schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await tx.query<{ id: string }>('SELECT id FROM public.baton_schema_migrations')).map((row) => row.id));
    const applied: string[] = [];
    for (const migration of PG_MIGRATIONS) {
      if (done.has(migration.id)) continue;
      await tx.query(migration.sql);
      await tx.query('INSERT INTO public.baton_schema_migrations (id) VALUES ($1)', [migration.id]);
      applied.push(migration.id);
      if (migration.id === options.until) break;
    }
    return { applied, current: PG_MIGRATIONS.at(-1)?.id ?? null };
  });
}

/** Migration ids not yet applied; empty when the schema is current. */
export async function pendingMigrations(db: Database): Promise<string[]> {
  const [exists] = await db.query<{ name: string | null }>("SELECT to_regclass('public.baton_schema_migrations')::text AS name");
  if (!exists?.name) return PG_MIGRATIONS.map((migration) => migration.id);
  const done = new Set((await db.query<{ id: string }>('SELECT id FROM public.baton_schema_migrations')).map((row) => row.id));
  return PG_MIGRATIONS.filter((migration) => !done.has(migration.id)).map((migration) => migration.id);
}
