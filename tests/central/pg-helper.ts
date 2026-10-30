/**
 * Real Postgres for central-server tests.
 *
 * - `PMI_TEST_PG_URL` set (CI service container): each call creates a fresh
 *   database on that server and drops it afterwards.
 * - Otherwise, when Docker is available: a throwaway `pgvector/pgvector:pg17`
 *   container per test file, removed in `stop()`.
 * - Neither: `pgAvailable` is false and suites skip with an explicit reason.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const PG_IMAGE = 'pgvector/pgvector:pg17';

/** Docker that can run Linux images (Windows runners report Windows containers). */
function dockerAvailable(): boolean {
  try {
    const osType = execFileSync('docker', ['info', '--format', '{{.OSType}}'], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 }).trim();
    return osType === 'linux';
  } catch {
    return false;
  }
}

export const pgAvailable = Boolean(process.env.PMI_TEST_PG_URL) || dockerAvailable();
export const pgSkipReason = 'Postgres tests need Docker or PMI_TEST_PG_URL; skipped';

export interface TestPostgres {
  url: string;
  stop: () => Promise<void>;
}

async function withAdminClient<T>(url: string, fn: (query: (sql: string) => Promise<unknown>) => Promise<T>): Promise<T> {
  const pg = await import('pg');
  const Client = (pg as unknown as { default?: { Client: new (c: unknown) => any }; Client?: new (c: unknown) => any }).Client
    ?? (pg as any).default.Client;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn((sql) => client.query(sql));
  } finally {
    await client.end();
  }
}

async function waitForPostgres(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await withAdminClient(url, (query) => query('SELECT 1'));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`Postgres did not become ready: ${(lastError as Error)?.message}`);
}

/**
 * Remove containers left by test processes that died before their cleanup
 * ran (timeouts, killed workers). The owner's pid is part of the name.
 */
function sweepOrphans(): void {
  let names: string[] = [];
  try {
    names = execFileSync('docker', ['ps', '-a', '--filter', 'name=pmi-test-pg-', '--format', '{{.Names}}'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^pmi-test-pg-(\d+)-/.exec(name)?.[1]);
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch {
      try { execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' }); } catch { /* already gone */ }
    }
  }
}

const started = new Set<string>();
process.once('exit', () => {
  for (const name of started) {
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' }); } catch { /* already gone */ }
  }
});

export async function startPostgres(): Promise<TestPostgres> {
  const shared = process.env.PMI_TEST_PG_URL;
  if (shared) {
    const name = `pmi_test_${randomBytes(6).toString('hex')}`;
    await withAdminClient(shared, (query) => query(`CREATE DATABASE ${name}`));
    const url = new URL(shared);
    url.pathname = `/${name}`;
    return {
      url: url.toString(),
      stop: () => withAdminClient(shared, (query) => query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).then(() => undefined),
    };
  }

  sweepOrphans();
  const container = `pmi-test-pg-${process.pid}-${randomBytes(3).toString('hex')}`;
  started.add(container);
  execFileSync('docker', [
    'run', '-d', '--rm', '--name', container,
    '-e', 'POSTGRES_PASSWORD=pmi', '-e', 'POSTGRES_USER=pmi', '-e', 'POSTGRES_DB=pmi',
    '-p', '127.0.0.1::5432',
    PG_IMAGE,
  ], { stdio: 'pipe' });
  const stop = async () => {
    try { execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' }); } catch { /* already gone */ }
    started.delete(container);
  };
  try {
    const mapping = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split('\n')[0];
    const port = mapping.slice(mapping.lastIndexOf(':') + 1);
    const url = `postgres://pmi:pmi@127.0.0.1:${port}/pmi`;
    await waitForPostgres(url);
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
