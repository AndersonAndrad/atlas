import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  MIGRATIONS,
  SqliteProjectRepository,
  SqliteSettingsRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '../src/index.js';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Atlas',
    tags: ['core', 'desktop'],
    workspacePath: '/work/atlas',
    git: { isRepository: true, repositoryRoot: '/work/atlas' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SQLite persistence', () => {
  let temp: ReturnType<typeof createTempDir>;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    temp = createTempDir();
    dbPath = path.join(temp.dir, 'nested', 'atlas.db');
    db = openDatabase({ filePath: dbPath });
  });
  afterEach(() => {
    db.close();
    temp.cleanup();
  });

  describe('migrations', () => {
    it('creates the database file and applies all migrations', () => {
      expect(getSchemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual(
        expect.arrayContaining(['application_settings', 'projects', 'schema_migrations']),
      );
    });

    it('is idempotent across reopen', () => {
      db.close();
      db = openDatabase({ filePath: dbPath });
      const count = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
        n: number;
      };
      expect(count.n).toBe(MIGRATIONS.length);
    });

    it('applies only pending migrations', () => {
      db.close();
      db = openDatabase({
        filePath: dbPath,
        migrations: [
          ...MIGRATIONS,
          { version: 99, name: 'add_test_table', sql: 'CREATE TABLE extra (id INTEGER) STRICT;' },
        ],
      });
      expect(getSchemaVersion(db)).toBe(99);
    });

    it('rolls back a failing migration', () => {
      db.close();
      expect(() =>
        openDatabase({
          filePath: dbPath,
          migrations: [
            ...MIGRATIONS,
            {
              version: 2,
              name: 'broken',
              sql: 'CREATE TABLE ok_part (id INTEGER); SELECT nope FROM missing;',
            },
          ],
        }),
      ).toThrow(AtlasError);
      db = openDatabase({ filePath: dbPath });
      expect(getSchemaVersion(db)).toBe(1);
      const leaked = db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_part'").get();
      expect(leaked).toBeUndefined();
    });

    it('refuses to open a database from a newer version', () => {
      db.prepare("INSERT INTO schema_migrations VALUES (500, 'future', '2030-01-01')").run();
      db.close();
      try {
        openDatabase({ filePath: dbPath });
        expect.unreachable();
      } catch (error) {
        expect((error as AtlasError).code).toBe('PROJECT_PERSISTENCE_ERROR');
      } finally {
        db = new DatabaseSync(dbPath);
      }
    });
  });

  describe('SqliteProjectRepository', () => {
    it('round-trips a project including tags and Git metadata', async () => {
      const repo = new SqliteProjectRepository(db);
      const stored = project({ description: 'Hello', lastOpenedAt: '2026-01-02T00:00:00.000Z' });
      await repo.insert({ project: stored, pathKey: '/work/atlas' });
      expect(await repo.findById(stored.id)).toEqual(stored);
      expect(await repo.findByPathKey('/work/atlas')).toEqual(stored);
      expect(await repo.findAll()).toEqual([stored]);
    });

    it('maps the unique path key constraint to PROJECT_ALREADY_EXISTS', async () => {
      const repo = new SqliteProjectRepository(db);
      await repo.insert({ project: project(), pathKey: '/work/atlas' });
      const duplicate = repo.insert({
        project: project({ id: '00000000-0000-4000-8000-000000000002' }),
        pathKey: '/work/atlas',
      });
      await expect(duplicate).rejects.toMatchObject({ code: 'PROJECT_ALREADY_EXISTS' });
    });

    it('updates and deletes records', async () => {
      const repo = new SqliteProjectRepository(db);
      await repo.insert({ project: project(), pathKey: '/work/atlas' });
      const changed = project({ name: 'Renamed', tags: [], git: { isRepository: false } });
      await repo.update({ project: changed, pathKey: '/work/atlas' });
      expect(await repo.findById(changed.id)).toEqual(changed);
      expect(await repo.delete(changed.id)).toBe(true);
      expect(await repo.delete(changed.id)).toBe(false);
      expect(await repo.findAll()).toEqual([]);
    });

    it('reports updates of missing records', async () => {
      const repo = new SqliteProjectRepository(db);
      await expect(repo.update({ project: project(), pathKey: '/x' })).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
      });
    });

    it('treats hostile values as data (parameterized queries)', async () => {
      const repo = new SqliteProjectRepository(db);
      const hostile = project({ name: "x'); DROP TABLE projects; --" });
      await repo.insert({ project: hostile, pathKey: "/work/'; DROP TABLE projects; --" });
      expect((await repo.findAll())[0]?.name).toBe(hostile.name);
    });

    it('enforces database constraints independently of the service', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository, created_at, updated_at)
             VALUES ('00000000-0000-4000-8000-000000000009', '', '/a', '/a', '[]', 0, 'now', 'now')`,
          )
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository, created_at, updated_at)
             VALUES ('00000000-0000-4000-8000-000000000009', 'a', '/a', '/a', 'not json', 0, 'now', 'now')`,
          )
          .run(),
      ).toThrow();
    });

    it('surfaces corrupted rows as persistence errors', async () => {
      db.prepare(
        `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository, created_at, updated_at)
         VALUES ('00000000-0000-4000-8000-000000000009', 'a', '/a', '/a', '[1]', 0, 'bad-date', 'bad-date')`,
      ).run();
      await expect(new SqliteProjectRepository(db).findAll()).rejects.toMatchObject({
        code: 'PROJECT_PERSISTENCE_ERROR',
      });
    });
  });

  describe('SqliteSettingsRepository', () => {
    it('sets, overwrites, reads and deletes values', async () => {
      const settings = new SqliteSettingsRepository(db);
      expect(await settings.get('k')).toBeNull();
      await settings.set('k', 'one');
      await settings.set('k', 'two');
      expect(await settings.get('k')).toBe('two');
      await settings.delete('k');
      expect(await settings.get('k')).toBeNull();
    });
  });

  it('persists data across connections (restart)', async () => {
    await new SqliteProjectRepository(db).insert({ project: project(), pathKey: '/work/atlas' });
    await new SqliteSettingsRepository(db).set('selected', project().id);
    db.close();
    db = openDatabase({ filePath: dbPath });
    expect(await new SqliteProjectRepository(db).findAll()).toHaveLength(1);
    expect(await new SqliteSettingsRepository(db).get('selected')).toBe(project().id);
  });
});
