/**
 * Prometheus metrics for baton-server (CONTEXT_ENGINE.md §8). Request and
 * context counters live in process; project-wide gauges and recovery results
 * are read from Postgres at scrape time, so several replicas report the same
 * totals. Exposed at /metrics behind BATON_METRICS_TOKEN.
 */
import type { Queryable } from './db.js';

type Labels = Record<string, string>;

function key(name: string, labels: Labels): string {
  const parts = Object.keys(labels).sort().map((label) => `${label}="${labels[label].replace(/["\\\n]/g, '_')}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly help = new Map<string, { type: 'counter' | 'gauge'; text: string }>();

  describe(name: string, type: 'counter' | 'gauge', text: string): void {
    this.help.set(name, { type, text });
  }

  inc(name: string, labels: Labels = {}, value = 1): void {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + value);
  }

  async render(db: Queryable): Promise<string> {
    const lines: string[] = [];
    const gauges = new Map<string, number>();
    for (const row of await db.query<{ category: string; n: string }>(
      "SELECT category::text, count(*)::text AS n FROM memory.memories WHERE deleted_at IS NULL GROUP BY category")) {
      gauges.set(key('baton_memories', { category: row.category }), Number(row.n));
    }
    for (const row of await db.query<{ status: string; n: string }>('SELECT status, count(*)::text AS n FROM work.sessions GROUP BY status')) {
      gauges.set(key('baton_sessions', { status: row.status }), Number(row.n));
    }
    for (const row of await db.query<{ action: string; result: string; n: string }>(
      `SELECT action, CASE WHEN action = 'snapshot.restore' THEN CASE WHEN (detail->>'verified')::boolean THEN 'success' ELSE 'conflict' END ELSE 'success' END AS result,
              count(*)::text AS n
         FROM core.audit_log WHERE action IN ('session.resume', 'session.resume_forced', 'snapshot.restore') GROUP BY 1, 2`)) {
      const name = row.action === 'snapshot.restore' ? 'baton_workspace_recovery_total' : 'baton_session_recovery_total';
      const k = key(name, { result: row.action === 'session.resume_forced' ? 'forced' : row.result });
      gauges.set(k, (gauges.get(k) ?? 0) + Number(row.n));
    }
    const [blobs] = await db.query<{ n: string; bytes: string }>('SELECT count(*)::text AS n, COALESCE(sum(size), 0)::text AS bytes FROM work.blobs');
    gauges.set('baton_blobs', Number(blobs.n));
    gauges.set('baton_blob_bytes', Number(blobs.bytes));
    const [tokens] = await db.query<{ n: string; sum: string }>(
      "SELECT count(*)::text AS n, COALESCE(sum(value), 0)::text AS sum FROM work.metrics_events WHERE name = 'context_tokens'");
    gauges.set('baton_context_tokens_sum', Number(tokens.sum));
    gauges.set('baton_context_builds_total', Number(tokens.n));

    const names = new Set([...this.counters.keys(), ...gauges.keys()].map((k) => k.split('{')[0]));
    for (const name of [...names].sort()) {
      const help = this.help.get(name);
      if (help) lines.push(`# HELP ${name} ${help.text}`, `# TYPE ${name} ${help.type}`);
      for (const [k, value] of [...this.counters, ...gauges]) if (k.split('{')[0] === name) lines.push(`${k} ${value}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export function createMetrics(): Metrics {
  const metrics = new Metrics();
  metrics.describe('baton_http_requests_total', 'counter', 'HTTP requests by route and status');
  metrics.describe('baton_context_build_ms_sum', 'counter', 'Total time spent building context packages');
  metrics.describe('baton_context_cache_hits_total', 'counter', 'Context builds served from the cached L1 overview');
  metrics.describe('baton_memory_retrieval_total', 'counter', 'Memory search and get calls');
  metrics.describe('baton_git_commits_analyzed_total', 'counter', 'Commits analyzed by incremental git analysis');
  metrics.describe('baton_memories', 'gauge', 'Live memories by category');
  metrics.describe('baton_sessions', 'gauge', 'Sessions by status');
  metrics.describe('baton_session_recovery_total', 'gauge', 'Session resumes by result');
  metrics.describe('baton_workspace_recovery_total', 'gauge', 'Workspace restores by result');
  metrics.describe('baton_context_tokens_sum', 'gauge', 'Tokens delivered by context builds');
  metrics.describe('baton_context_builds_total', 'gauge', 'Context builds');
  return metrics;
}
