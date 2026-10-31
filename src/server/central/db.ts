/**
 * Postgres access for the central server. A thin wrapper over `pg.Pool` that
 * adds a transaction helper; repositories receive a `Queryable` so the same
 * code runs inside or outside a transaction.
 */

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /**
   * Run `fn` in a transaction as the restricted role `pmi_app` with
   * `app.user_id` set, so row-level security filters every project-data
   * query to what this user may see (migration 0002). Use it for all
   * project data; identity and admin queries stay on the owner connection.
   */
  asUser<T>(userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface PgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): void;
}

export async function openDatabase(connectionString: string, options: { max?: number } = {}): Promise<Database> {
  const packageName = 'pg';
  const pg = await import(packageName) as { Pool?: new (config: Record<string, unknown>) => PgPool; default?: { Pool?: new (config: Record<string, unknown>) => PgPool } };
  const Pool = pg.Pool ?? pg.default?.Pool;
  if (!Pool) throw new Error('[pmi-server] the installed "pg" package does not export Pool');
  const pool = new Pool({ connectionString, max: options.max ?? 10 });
  // An idle client losing its connection must not crash the process; the next
  // query reconnects and /ready reports the outage.
  pool.on('error', (error) => console.error(`[pmi-server] idle Postgres client error: ${error.message}`));

  const database: Database = {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await pool.query(sql, params)).rows as T[];
    },
    async asUser<T>(userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return database.transaction(async (tx) => {
        await tx.query('SET LOCAL ROLE pmi_app');
        await tx.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        return fn(tx);
      });
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: Queryable = {
          async query<R>(sql: string, params: unknown[] = []): Promise<R[]> {
            return (await client.query(sql, params)).rows as R[];
          },
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
  return database;
}
