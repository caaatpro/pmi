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
];

const MIGRATION_LOCK_KEY = 74_201_001;

export interface MigrationReport {
  applied: string[];
  current: string | null;
}

export async function migrate(db: Database): Promise<MigrationReport> {
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
