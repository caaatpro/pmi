import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { backupLocalStore, restoreLocalStore } from '../../src/cli/commands/backup.js';
import { BlobStore } from '../../src/workspace-snapshot/blob-store.js';
import { closeAllDatabases, getDatabase } from '../../src/store/sqlite-db.js';

let root = '';
afterEach(() => {
  closeAllDatabases();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('local backup and restore', () => {
  it('round-trips the database and blobs, checks integrity, and never deletes the current store', () => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'baton-backup-'));
    const data = path.join(root, 'data');
    getDatabase(data).prepare("INSERT INTO meta (key, value) VALUES ('marker', 'original')").run();
    const sha = new BlobStore(data).put(Buffer.from('blob body'));

    const out = path.join(root, 'backup');
    const result = backupLocalStore(data, out);
    expect(result.blobs).toBe(1);
    expect(() => backupLocalStore(data, out)).toThrow(/not empty/);

    getDatabase(data).prepare("UPDATE meta SET value = 'changed later' WHERE key = 'marker'").run();
    expect(() => restoreLocalStore(data, out, false)).toThrow(/--force/);
    const restored = restoreLocalStore(data, out, true);
    expect(getDatabase(data).prepare("SELECT value FROM meta WHERE key = 'marker'").get()).toEqual({ value: 'original' });
    expect(new BlobStore(data).get(sha).toString()).toBe('blob body');
    expect(restored.movedAside && fs.existsSync(path.join(restored.movedAside, 'baton.db'))).toBe(true);

    closeAllDatabases();
    fs.appendFileSync(path.join(out, 'baton.db'), 'tampered');
    expect(() => restoreLocalStore(data, out, true)).toThrow(/checksum/);
  });
});
