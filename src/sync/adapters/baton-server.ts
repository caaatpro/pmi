/**
 * `SyncRemote` backed by the Baton central server.
 *
 * Push ships the engine's batches to `/v1/sync/push`, where the server
 * materializes them into `memory.memories`. Pull reads the per-project
 * changes feed and presents it to the engine as batches from the pseudo
 * device `baton-server`, whose sequence is the server's change seq — so the
 * engine's existing cursor (`applied[device] = sequence`) tracks the feed
 * position without a second cursor mechanism.
 */
import type { BatonApiClient } from '../../client/api.js';
import type { ChangeBatch, ChangeEntry, SyncCompactReport, SyncPullPage, SyncRemote } from '../types.js';

export const SERVER_DEVICE_ID = 'baton-server';

const FEED_PAGE = 500;
const MAX_ENTRIES_PER_BATCH = 200;
const MAX_BATCH_BYTES = 600_000;

export interface PushEntryResult {
  syncKey: string;
  outcome: 'applied' | 'duplicate' | 'stale' | 'rejected';
  reason?: string;
  conflict?: boolean;
}

interface FeedResponse {
  changes: Array<{ seq: number; entry: ChangeEntry }>;
  hasMore: boolean;
  lastSeq: number;
}

export class BatonServerRemote implements SyncRemote {
  readonly kind = 'baton';
  /** Entries the server refused during this run (e.g. credential-like content). */
  readonly rejected: PushEntryResult[] = [];
  /** Entries applied on the server that overwrote a concurrent edit. */
  conflicts = 0;

  constructor(
    private readonly api: BatonApiClient,
    private readonly projectId: string,
    private readonly legacyProjectId: string,
    readonly namespace: string,
  ) {}

  async init(): Promise<void> {
    // Connection errors surface on the first push/pull; nothing to create.
  }

  async push(batch: ChangeBatch): Promise<void> {
    const response = await this.api.post<{ results: PushEntryResult[] }>('/v1/sync/push', {
      project_id: this.projectId,
      batch,
    });
    for (const result of response.results) {
      if (result.outcome === 'rejected') this.rejected.push(result);
      if (result.conflict) this.conflicts++;
    }
  }

  async pull(since: Record<string, number>, _limit: number, pageToken?: string): Promise<SyncPullPage> {
    const after = pageToken ? Number(pageToken) : (since[SERVER_DEVICE_ID] ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('[baton] invalid changes-feed cursor');
    const query = new URLSearchParams({ after: String(after), limit: String(FEED_PAGE), legacy: this.legacyProjectId });
    const feed = await this.api.get<FeedResponse>(`/v1/projects/${this.projectId}/changes?${query}`);
    const batches = toBatches(feed.changes, this.legacyProjectId, this.namespace);
    return {
      batches,
      hasMore: feed.hasMore,
      nextPageToken: feed.hasMore ? String(feed.lastSeq) : undefined,
    };
  }

  async compact(): Promise<SyncCompactReport> {
    // The server keeps materialized rows, not an event log; there is nothing to compact.
    return { candidates: 0, deleted: 0 };
  }

  async close(): Promise<void> {}
}

function toBatches(changes: FeedResponse['changes'], projectId: string, namespace: string): ChangeBatch[] {
  const batches: ChangeBatch[] = [];
  let entries: ChangeEntry[] = [];
  let bytes = 0;
  let lastSeq = 0;
  const flush = () => {
    if (entries.length === 0) return;
    batches.push({
      formatVersion: 3,
      namespace,
      projectId,
      deviceId: SERVER_DEVICE_ID,
      sequence: lastSeq,
      producedAt: new Date().toISOString(),
      entries,
    });
    entries = [];
    bytes = 0;
  };
  for (const change of changes) {
    const size = Buffer.byteLength(JSON.stringify(change.entry), 'utf8');
    if (entries.length >= MAX_ENTRIES_PER_BATCH || (entries.length > 0 && bytes + size > MAX_BATCH_BYTES)) flush();
    entries.push(change.entry);
    bytes += size;
    lastSeq = change.seq;
  }
  flush();
  return batches;
}
