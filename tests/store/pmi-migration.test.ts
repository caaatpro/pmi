import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

  it('copies every mini-skill into a coding_convention memory once and leaves mini_skills untouched', async () => {
    const dir = dataDir();
    const store = new SqliteBackend();
    await store.init(dir);
    await store.insert(observation(1, { type: 'gotcha', title: 'Never call the API without a timeout' }));
    await store.insert(observation(2));
    const db = getDatabase(dir);
    const insertSkill = db.prepare(`INSERT INTO mini_skills
      (id, sourceObservationIds, sourceEntity, title, instruction, trigger_desc, facts, projectId, createdAt, usedCount, tags, sourceSnapshot, updatedAt)
      VALUES (?, ?, 'http-client', ?, ?, ?, ?, ?, '2026-09-01T00:00:00.000Z', 4, ?, '{"observations":[]}', NULL)`);
    insertSkill.run(3, '[1]', 'Always pass a timeout', 'Pass `timeout` to every fetch call.', 'When calling external APIs', '["default 5s"]', 'acme/app', '["http"]');
    insertSkill.run(7, '[]', 'Use pnpm', 'Install packages with pnpm.', '', '[]', 'acme/other', '[]');
    // The store as an older PMI build left it: mini-skills present, migration not yet run.
    db.prepare("DELETE FROM schema_migrations WHERE id = 'pmi-5-mini-skills-to-conventions'").run();
    const skillsBefore = db.prepare('SELECT * FROM mini_skills ORDER BY id').all();
    closeAllDatabases();

    const migrated = getDatabase(dir);
    expect(migrated.prepare('SELECT * FROM mini_skills ORDER BY id').all()).toEqual(skillsBefore);
    const rows = migrated.prepare(
      "SELECT id, projectId, entityName, title, narrative, facts, concepts, category, confidence, status, valueCategory, topicKey FROM observations WHERE category = 'coding_convention' ORDER BY topicKey",
    ).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      projectId: 'acme/app',
      entityName: 'http-client',
      title: 'Always pass a timeout',
      facts: '["default 5s"]',
      concepts: '["http"]',
      confidence: 'observed',
      status: 'active',
      valueCategory: 'core',
      topicKey: 'mini-skill/3',
    });
    expect(rows[0].narrative).toContain('Pass `timeout` to every fetch call.');
    expect(rows[0].narrative).toContain('When: When calling external APIs');
    expect(rows[0].narrative).toContain('#1');
    expect(rows[1]).toMatchObject({ projectId: 'acme/other', title: 'Use pnpm', topicKey: 'mini-skill/7' });
    expect(rows.map((row: { id: number }) => row.id).every((id: number) => id > 2)).toBe(true);
    expect(readdirSync(dir).some((name) => name.startsWith('memorix.db.pre-pmi-'))).toBe(true);
    closeAllDatabases();

    // The converted memories are ordinary observations: the store reads them
    // with their category and allocates new ids past them.
    const reopened = new SqliteBackend();
    await reopened.init(dir);
    const converted = (await reopened.loadByProject('acme/app')).find((obs) => obs.topicKey === 'mini-skill/3');
    expect(converted).toMatchObject({ category: 'coding_convention', confidence: 'observed', type: 'how-it-works' });
    expect(await reopened.loadIdCounter()).toBeGreaterThan(Math.max(...rows.map((row: { id: number }) => row.id)));

    // Running the migration again (e.g. a restored backup) does not duplicate.
    const again = getDatabase(dir);
    again.prepare("DELETE FROM schema_migrations WHERE id = 'pmi-5-mini-skills-to-conventions'").run();
    closeAllDatabases();
    expect(getDatabase(dir).prepare("SELECT COUNT(*) AS n FROM observations WHERE category = 'coding_convention'").get()).toEqual({ n: 2 });
  });

  it('converts mini-skills that only exist in a legacy mini-skills.json', () => {
    const dir = dataDir();
    getDatabase(dir);
    closeAllDatabases();
    writeFileSync(path.join(dir, 'mini-skills.json'), JSON.stringify([
      { id: 1, sourceObservationIds: [], sourceEntity: 'db', title: 'Migrations are additive', instruction: 'Never drop columns.', trigger: 'Schema changes', facts: [], projectId: 'acme/app', createdAt: '2026-01-01T00:00:00.000Z', usedCount: 0, tags: [] },
    ]));
    const db = getDatabase(dir);
    db.prepare("DELETE FROM schema_migrations WHERE id = 'pmi-5-mini-skills-to-conventions'").run();
    closeAllDatabases();
    const row = getDatabase(dir).prepare("SELECT title, category FROM observations WHERE topicKey = 'mini-skill/1'").get();
    expect(row).toEqual({ title: 'Migrations are additive', category: 'coding_convention' });
  });
});
