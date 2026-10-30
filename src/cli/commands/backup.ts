/**
 * `pmi backup <dir>` / `pmi restore <dir> [--force]` — the local store of
 * this machine: the SQLite database (copied with VACUUM INTO and
 * integrity-checked) and the snapshot blob store. Tokens are not included;
 * log in again after restoring on a new machine.
 *
 * Restore never deletes data: the current store is moved aside to
 * `<data>.pre-restore-<timestamp>` first.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineCommand } from 'citty';

import { createDatabase } from '../../store/bun-sqlite-compat.js';
import { closeAllDatabases, getDatabase } from '../../store/sqlite-db.js';
import { getBaseDataDir } from '../../store/persistence.js';
import { emitError, emitResult } from './operator-shared.js';

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function integrityOk(dbPath: string): boolean {
  const db = createDatabase(dbPath);
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
    return Object.values(row)[0] === 'ok';
  } finally {
    db.close();
  }
}

export function backupLocalStore(dataDir: string, out: string): { database: string; blobs: number; manifest: string } {
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`);
  fs.mkdirSync(out, { recursive: true });
  const dbCopy = path.join(out, 'memorix.db');
  getDatabase(dataDir).prepare('VACUUM INTO ?').run(dbCopy);
  if (!integrityOk(dbCopy)) throw new Error('the database copy failed its integrity check');
  let blobs = 0;
  const blobDir = path.join(dataDir, 'blobs');
  if (fs.existsSync(blobDir)) {
    fs.cpSync(blobDir, path.join(out, 'blobs'), { recursive: true });
    const walk = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true })
      .reduce((n, entry) => n + (entry.isDirectory() ? walk(path.join(dir, entry.name)) : 1), 0);
    blobs = walk(path.join(out, 'blobs'));
  }
  const manifest = path.join(out, 'MANIFEST.json');
  fs.writeFileSync(manifest, JSON.stringify({ createdAt: new Date().toISOString(), database: { file: 'memorix.db', sha256: sha256File(dbCopy) }, blobs }, null, 2));
  return { database: dbCopy, blobs, manifest };
}

export function restoreLocalStore(dataDir: string, src: string, force: boolean): { movedAside: string | null } {
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'MANIFEST.json'), 'utf8')) as { database: { file: string; sha256: string } };
  const dbFile = path.join(src, manifest.database.file);
  if (sha256File(dbFile) !== manifest.database.sha256) throw new Error('the backup database does not match its checksum');
  if (!integrityOk(dbFile)) throw new Error('the backup database failed its integrity check');
  const hasData = fs.existsSync(path.join(dataDir, 'memorix.db'));
  if (hasData && !force) throw new Error(`${dataDir} already holds a store; pass --force to move it aside and restore`);
  closeAllDatabases();
  let movedAside: string | null = null;
  if (fs.existsSync(dataDir)) {
    movedAside = `${dataDir}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(dataDir, movedAside);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(dbFile, path.join(dataDir, 'memorix.db'));
  if (fs.existsSync(path.join(src, 'blobs'))) fs.cpSync(path.join(src, 'blobs'), path.join(dataDir, 'blobs'), { recursive: true });
  return { movedAside };
}

export const backup = defineCommand({
  meta: { name: 'backup', description: 'Back up the local PMI store (database and snapshot blobs) to a directory' },
  args: { dir: { type: 'positional', required: true }, json: { type: 'boolean', default: false } },
  async run({ args }) {
    try {
      const result = backupLocalStore(getBaseDataDir(), path.resolve(String(args.dir)));
      emitResult(result, `Backed up the local store to ${args.dir} (${result.blobs} blob file(s)). Tokens are not included.`, Boolean(args.json));
    } catch (error) {
      emitError((error as Error).message, Boolean(args.json));
    }
  },
});

export const restore = defineCommand({
  meta: { name: 'restore', description: 'Restore the local PMI store from a `pmi backup` directory (current store is moved aside)' },
  args: { dir: { type: 'positional', required: true }, force: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
  async run({ args }) {
    try {
      const result = restoreLocalStore(getBaseDataDir(), path.resolve(String(args.dir)), Boolean(args.force));
      emitResult(result, `Restored the local store from ${args.dir}.${result.movedAside ? ` Previous store kept at ${result.movedAside}.` : ''}`, Boolean(args.json));
    } catch (error) {
      emitError((error as Error).message, Boolean(args.json));
    }
  },
});
