/**
 * Local content-addressed blob store for workspace snapshots
 * (WORKSPACE_RECOVERY.md §4): `<dataDir>/blobs/aa/bb/<sha256>`, gzip on
 * disk, the hash always of the uncompressed content. Reads verify the hash,
 * so a damaged blob is never handed to a restore.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export class BlobStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'blobs');
  }

  private pathFor(sha: string): string {
    if (!isSha256(sha)) throw new Error(`[baton] invalid blob id ${sha}`);
    return path.join(this.root, sha.slice(0, 2), sha.slice(2, 4), sha);
  }

  has(sha: string): boolean {
    return fs.existsSync(this.pathFor(sha));
  }

  /** Store content and return its SHA-256. Writing an existing blob is a no-op. */
  put(data: Buffer): string {
    const sha = sha256Hex(data);
    const target = this.pathFor(sha);
    if (fs.existsSync(target)) return sha;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, gzipSync(data));
    fs.renameSync(tmp, target);
    return sha;
  }

  /** Store content that must hash to `sha` (downloads); refuses anything else. */
  putVerified(sha: string, data: Buffer): void {
    const actual = sha256Hex(data);
    if (actual !== sha) throw new Error(`[baton] blob ${sha} failed verification (got ${actual})`);
    this.put(data);
  }

  get(sha: string): Buffer {
    const data = gunzipSync(fs.readFileSync(this.pathFor(sha)));
    if (sha256Hex(data) !== sha) throw new Error(`[baton] local blob ${sha} is corrupted`);
    return data;
  }

  size(sha: string): number {
    return this.get(sha).length;
  }

  /** Remove blobs not in `keep`; returns how many were deleted. */
  gc(keep: Set<string>): number {
    if (!fs.existsSync(this.root)) return 0;
    let removed = 0;
    for (const a of fs.readdirSync(this.root)) {
      for (const b of fs.readdirSync(path.join(this.root, a))) {
        for (const name of fs.readdirSync(path.join(this.root, a, b))) {
          if (isSha256(name) && !keep.has(name)) {
            fs.unlinkSync(path.join(this.root, a, b, name));
            removed++;
          }
        }
      }
    }
    return removed;
  }
}
