import type { ChangeBatch, SyncCompactReport, SyncPullPage, SyncRemote } from '../types.js';
import { decodePageCursor, encodePageCursor } from '../paging.js';
import { isSafeSyncDeviceId } from '../namespace.js';

export interface SqlClient {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
  exec(sql: string, params: unknown[]): Promise<void>;
  close?(): Promise<void>;
}

interface BatchRow {
  device_id: string;
  sequence: number | string;
  produced_at: string;
  payload: ChangeBatch | string;
}

export class PostgresSyncRemote implements SyncRemote {
  readonly kind = 'postgres';
  readonly namespace: string;
  private available = false;

  constructor(private readonly sql: SqlClient, namespace: string) {
    this.namespace = namespace;
  }

  async init(options: { create?: boolean } = {}): Promise<void> {
    if (options.create === false) {
      const [row] = await this.sql.query<{ name?: string | null }>(
        `SELECT to_regclass('baton_sync_batches') AS name`,
        [],
      );
      this.available = typeof row?.name === 'string' && row.name.length > 0;
      return;
    }
    await this.sql.exec(
      `CREATE TABLE IF NOT EXISTS baton_sync_batches (
        namespace text NOT NULL,
        device_id text NOT NULL,
        sequence bigint NOT NULL,
        produced_at text NOT NULL,
        payload jsonb NOT NULL,
        PRIMARY KEY (namespace, device_id, sequence)
      )`,
      [],
    );
    // Upgrade the pre-v3 #277 table without touching its payloads. Legacy rows
    // stay quarantined under a non-project namespace; a fresh scoped sync never
    // accidentally imports them.
    await this.sql.exec(
      `ALTER TABLE baton_sync_batches
       ADD COLUMN IF NOT EXISTS namespace text NOT NULL DEFAULT 'legacy'`,
      [],
    );
    await this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS baton_sync_batches_scope_key
       ON baton_sync_batches(namespace, device_id, sequence)`,
      [],
    );
    this.available = true;
  }

  async push(batch: ChangeBatch): Promise<void> {
    assertBatchNamespace(batch, this.namespace);
    if (!this.available) throw new Error('[baton] Postgres sync remote is not initialized for writes');
    await this.sql.exec(
      `INSERT INTO baton_sync_batches (namespace, device_id, sequence, produced_at, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (namespace, device_id, sequence) DO NOTHING`,
      [this.namespace, batch.deviceId, batch.sequence, batch.producedAt, JSON.stringify(batch)],
    );
    const [stored] = await this.sql.query<{ payload: ChangeBatch | string }>(
      `SELECT payload FROM baton_sync_batches
       WHERE namespace = $1 AND device_id = $2 AND sequence = $3`,
      [this.namespace, batch.deviceId, batch.sequence],
    );
    const payload = typeof stored?.payload === 'string'
      ? JSON.parse(stored.payload) as ChangeBatch
      : stored?.payload;
    if (!payload || stableJson(payload) !== stableJson(batch)) {
      throw new Error('[baton] Postgres relay event path already contains a different payload');
    }
  }

  async pull(since: Record<string, number>, limit: number, pageToken?: string): Promise<SyncPullPage> {
    assertLimit(limit);
    if (!this.available) return { batches: [], hasMore: false };
    const after = decodePageCursor(pageToken);
    const sinceEntries = Object.entries(since);
    const params: unknown[] = [this.namespace];
    const sinceClauses: string[] = [];
    for (const [deviceId, sequence] of sinceEntries) {
      params.push(deviceId, sequence);
      const deviceParam = `$${params.length - 1}`;
      const sequenceParam = `$${params.length}`;
      sinceClauses.push(`(device_id = ${deviceParam} AND sequence > ${sequenceParam})`);
    }
    if (sinceEntries.length > 0) {
      params.push(...sinceEntries.map(([deviceId]) => deviceId));
      const placeholders = sinceEntries.map((_, index) => `$${params.length - sinceEntries.length + index + 1}`);
      sinceClauses.push(`device_id NOT IN (${placeholders.join(', ')})`);
    } else {
      sinceClauses.push('TRUE');
    }
    const filters = [`(${sinceClauses.join(' OR ')})`];
    if (after) {
      params.push(after.deviceId, after.sequence);
      const deviceParam = `$${params.length - 1}`;
      const sequenceParam = `$${params.length}`;
      filters.push(`(device_id > ${deviceParam} OR (device_id = ${deviceParam} AND sequence > ${sequenceParam}))`);
    }
    params.push(limit + 1);
    const rows = await this.sql.query<BatchRow>(
      `SELECT device_id, sequence, produced_at, payload
       FROM baton_sync_batches
       WHERE namespace = $1 AND ${filters.join(' AND ')}
       ORDER BY device_id, sequence
       LIMIT $${params.length}`,
      params,
    );

    const batches = rows
      .map((row) => {
        const payload = typeof row.payload === 'string'
          ? JSON.parse(row.payload) as ChangeBatch
          : row.payload;
        return {
          ...payload,
          deviceId: row.device_id,
          sequence: Number(row.sequence),
          producedAt: row.produced_at,
        };
      })
      .sort((left, right) => {
        if (left.deviceId < right.deviceId) return -1;
        if (left.deviceId > right.deviceId) return 1;
        return left.sequence - right.sequence;
      });
    const hasMore = batches.length > limit;
    const page = batches.slice(0, limit);
    return {
      batches: page,
      hasMore,
      nextPageToken: hasMore && page.length > 0
        ? encodePageCursor(page[page.length - 1])
        : undefined,
    };
  }

  async compact(through: Record<string, number>, options: { dryRun?: boolean } = {}): Promise<SyncCompactReport> {
    if (!this.available) return { candidates: 0, deleted: 0 };
    const entries = Object.entries(through).filter(([, value]) => Number.isSafeInteger(value) && value >= 0);
    if (entries.length === 0) return { candidates: 0, deleted: 0 };
    const clauses: string[] = [];
    const params: unknown[] = [this.namespace];
    for (const [deviceId, sequence] of entries) {
      params.push(deviceId, sequence);
      clauses.push(`(device_id = $${params.length - 1} AND sequence <= $${params.length})`);
    }
    const where = `namespace = $1 AND (${clauses.join(' OR ')})`;
    const [row] = await this.sql.query<{ count: number | string }>(`SELECT COUNT(*) AS count FROM baton_sync_batches WHERE ${where}`, params);
    const candidates = Number(row?.count ?? 0);
    if (!options.dryRun && candidates > 0) await this.sql.exec(`DELETE FROM baton_sync_batches WHERE ${where}`, params);
    return { candidates, deleted: options.dryRun ? 0 : candidates };
  }

  async close(): Promise<void> {
    await this.sql.close?.();
  }
}

function assertBatchNamespace(batch: ChangeBatch, namespace: string): void {
  if (batch.namespace !== namespace) {
    throw new Error('[baton] sync batch namespace does not match the Postgres relay');
  }
  if (!isSafeSyncDeviceId(batch.deviceId)) {
    throw new Error('[baton] sync batch has an invalid device id');
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('[baton] sync pull limit must be a positive integer');
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

interface PgPool {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
  end?(): Promise<void>;
}

interface PgModule {
  Pool?: new (config: Record<string, unknown>) => PgPool;
  default?: {
    Pool?: new (config: Record<string, unknown>) => PgPool;
  };
}

export async function createPgSqlClient(env: NodeJS.ProcessEnv = process.env): Promise<SqlClient> {
  const connectionString = env.BATON_SYNC_PG_URL;
  let config: Record<string, unknown>;

  if (connectionString) {
    config = { connectionString };
  } else {
    const required = [
      'BATON_SYNC_PG_HOST',
      'BATON_SYNC_PG_PORT',
      'BATON_SYNC_PG_DB',
      'BATON_SYNC_PG_USER',
      'BATON_SYNC_PG_PASSWORD',
    ] as const;
    const missing = required.filter((name) => !env[name]);
    if (missing.length > 0) {
      throw new Error(
        `Postgres sync requires BATON_SYNC_PG_URL or all discrete settings; missing ${missing.join(', ')}`,
      );
    }

    const port = Number(env.BATON_SYNC_PG_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error('BATON_SYNC_PG_PORT must be a positive integer');
    }
    config = {
      host: env.BATON_SYNC_PG_HOST,
      port,
      database: env.BATON_SYNC_PG_DB,
      user: env.BATON_SYNC_PG_USER,
      password: env.BATON_SYNC_PG_PASSWORD,
    };
  }

  // Loaded lazily so local-only installs never open the driver.
  const packageName = 'pg';
  let pg: PgModule;
  try {
    pg = await import(packageName) as PgModule;
  } catch (cause) {
    throw new Error('Postgres sync could not load the "pg" driver; reinstall dependencies (npm ci)', { cause });
  }

  const Pool = pg.Pool ?? pg.default?.Pool;
  if (!Pool) {
    throw new Error('The installed "pg" package does not export Pool');
  }
  const pool = new Pool(config);

  return {
    async query<T>(sql: string, params: unknown[]): Promise<T[]> {
      const result = await pool.query(sql, params);
      return result.rows as T[];
    },
    async exec(sql: string, params: unknown[]): Promise<void> {
      await pool.query(sql, params);
    },
    async close(): Promise<void> {
      await pool.end?.();
    },
  };
}
