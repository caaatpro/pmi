import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/store/bun-sqlite-compat.js';
import { closeAllDatabases, getDatabase } from '../../src/store/sqlite-db.js';
import { SqliteBackend } from '../../src/store/sqlite-store.js';
import type { Observation } from '../../src/types.js';

let root: string | undefined;

function dataDir(): string {
  root = mkdtempSync(path.join(tmpdir(), 'pmi-migration-'));
  return path.join(root, 'data');
}

afterEach(() => {
  closeAllDatabases();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function observation(id: number, extra: Partial<Observation> = {}): Observation {
  return {
    id,
    entityName: 'auth',
    type: 'decision',
    title: `Decision ${id}`,
    narrative: 'Tokens are hashed with SHA-256 before storage.',
    facts: ['token hash'],
    filesModified: [],
    concepts: [],
    tokens: 12,
    createdAt: '2026-10-01T00:00:00.000Z',
    projectId: 'acme/app',
    ...extra,
  };
}

/** Turn a fresh store back into what a pre-PMI Memorix install looks like on disk. */
function downgradeToMemorix(dir: string): void {
  const db = getDatabase(dir);
  db.exec('DROP INDEX IF EXISTS idx_observations_project_category');
  db.exec('ALTER TABLE observations DROP COLUMN category');
  db.exec('ALTER TABLE observations DROP COLUMN confidence');
  db.prepare("DELETE FROM schema_migrations WHERE id LIKE 'pmi-%'").run();
  closeAllDatabases();
}

describe('PMI SQLite migration', () => {
  it('backs up a Memorix store, then adds classification columns without touching rows', async () => {
    const dir = dataDir();
    const store = new SqliteBackend();
    await store.init(dir);
    await store.insert(observation(1));
    downgradeToMemorix(dir);

    const db = getDatabase(dir);
    const columns = db.prepare('PRAGMA table_info(observations)').all().map((c: { name: string }) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['category', 'confidence']));
    expect(db.prepare("SELECT id FROM schema_migrations WHERE id = 'pmi-1-memory-classification'").get()).toBeTruthy();

    const row = db.prepare('SELECT title, category, confidence FROM observations WHERE id = 1').get();
    expect(row).toEqual({ title: 'Decision 1', category: null, confidence: null });

    const backups = readdirSync(dir).filter((name) => name.startsWith('memorix.db.pre-pmi-'));
    expect(backups).toHaveLength(1);
    const copy = createDatabase(path.join(dir, backups[0]));
    try {
      expect(copy.prepare('SELECT title FROM observations WHERE id = 1').get()).toEqual({ title: 'Decision 1' });
      const copyColumns = copy.prepare('PRAGMA table_info(observations)').all().map((c: { name: string }) => c.name);
      expect(copyColumns).not.toContain('category');
    } finally {
      copy.close();
    }
  });

  it('does not create a backup for an empty store or when nothing is pending', () => {
    const dir = dataDir();
    getDatabase(dir);
    closeAllDatabases();
    getDatabase(dir);
    expect(readdirSync(dir).filter((name) => name.includes('pre-pmi'))).toEqual([]);
  });

  it('round-trips explicit classification and leaves defaults implicit', async () => {
    const dir = dataDir();
    const store = new SqliteBackend();
    await store.init(dir);
    await store.insert(observation(1, { category: 'coding_convention', confidence: 'confirmed' }));
    await store.insert(observation(2));
    expect(await store.getById(1)).toMatchObject({ category: 'coding_convention', confidence: 'confirmed' });
    const plain = await store.getById(2);
    expect(plain).not.toHaveProperty('category');
    expect(plain).not.toHaveProperty('confidence');
  });
});
