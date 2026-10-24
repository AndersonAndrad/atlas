import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectNote } from '@atlas/contracts';
import { ftsQuery, type NoteOwnerFilter } from '@atlas/notes';
import {
  MIGRATIONS,
  SqliteNoteRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import { createTempDir } from '../../../tests/support/temp.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 12, minute)).toISOString();
const PROJECT = id(500);
const OTHER = id(501);

const note = (n: number, overrides: Partial<ProjectNote> = {}): ProjectNote => ({
  id: id(n),
  projectId: PROJECT,
  workspacePath: '/work/app',
  title: `Note ${n}`,
  content: `Body ${n}`,
  category: null,
  pinned: false,
  archived: false,
  revision: 1,
  createdAt: at(n),
  updatedAt: at(n),
  ...overrides,
});

const projectOwner: NoteOwnerFilter = {
  kind: 'project',
  projectId: PROJECT,
  workspacePath: '/work/app',
};

function insertProject(db: Database, projectId: string, folder: string) {
  db.prepare(
    `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
       created_at, updated_at) VALUES (?, 'P', ?, ?, '[]', 0, 'x', 'x')`,
  ).run(projectId, folder, folder);
}

describe('SqliteNoteRepository', () => {
  let db: Database;
  let repository: SqliteNoteRepository;
  const list = (overrides: Partial<Parameters<SqliteNoteRepository['list']>[0]> = {}) =>
    repository.list({
      owner: projectOwner,
      filter: 'active',
      match: null,
      category: null,
      limit: 50,
      ...overrides,
    });

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    insertProject(db, PROJECT, '/work/app');
    insertProject(db, OTHER, '/work/other');
    repository = new SqliteNoteRepository(db);
  });
  afterEach(() => db.close());

  it('stores notes and lists pinned first, then the most recently updated', async () => {
    await repository.insert(note(1, { content: '# Heading\n\nFirst **bold** line' }));
    await repository.insert(note(2, { pinned: true }));
    await repository.insert(note(3));
    expect(await repository.get(id(1))).toEqual(
      note(1, { content: '# Heading\n\nFirst **bold** line' }),
    );
    const listed = await list();
    expect(listed.map((item) => item.id)).toEqual([id(2), id(3), id(1)]);
    expect(listed[2]).toEqual({
      ...note(1),
      content: undefined,
      excerpt: 'Heading First bold line',
    } as never);
    expect(listed[2]).not.toHaveProperty('content');
    expect(await repository.get(id(9))).toBeNull();
  });

  it('separates project, workspace and global notes', async () => {
    await repository.insert(note(1));
    await repository.insert(note(2, { projectId: OTHER, workspacePath: '/work/other' }));
    // A workspace note left in the project's folder by an earlier registration.
    await repository.insert(note(3, { projectId: null }));
    await repository.insert(note(4, { projectId: null, workspacePath: null }));
    const ids = async (owner: NoteOwnerFilter) =>
      (await list({ owner })).map((item) => item.id).sort();
    expect(await ids(projectOwner)).toEqual([id(1), id(3)]);
    expect(await ids({ kind: 'global' })).toEqual([id(4)]);
    expect(await ids({ kind: 'all' })).toEqual([id(1), id(2), id(3), id(4)]);
  });

  it('filters pinned and archived notes, counts them and lists categories', async () => {
    await repository.insert(note(1, { category: 'Backend' }));
    await repository.insert(note(2, { pinned: true, category: 'backend' }));
    await repository.insert(note(3, { archived: true, pinned: true, category: 'Docs' }));
    expect((await list({ filter: 'pinned' })).map((item) => item.id)).toEqual([id(2)]);
    expect((await list({ filter: 'archived' })).map((item) => item.id)).toEqual([id(3)]);
    expect((await list({ category: 'BACKEND' })).map((item) => item.id)).toEqual([id(2), id(1)]);
    expect(await repository.counts(projectOwner)).toEqual({ active: 2, pinned: 1, archived: 1 });
    expect(await repository.counts({ kind: 'global' })).toEqual({
      active: 0,
      pinned: 0,
      archived: 0,
    });
    expect(await repository.categories(projectOwner)).toEqual(['Backend', 'backend', 'Docs']);
    expect(await list({ limit: 1 })).toHaveLength(1);
  });

  it('searches titles and content, following updates and removals', async () => {
    await repository.insert(note(1, { title: 'Motor de tarifas', content: 'regras' }));
    await repository.insert(note(2, { title: 'Outro', content: 'Integração FitBank' }));
    const search = async (text: string) =>
      (await list({ match: ftsQuery(text) })).map((item) => item.id);
    expect(await search('tarif')).toEqual([id(1)]);
    expect(await search('fitbank')).toEqual([id(2)]);
    expect(await search('"NEAR( OR')).toEqual([]);

    const updated = note(2, { content: 'Webhooks', revision: 2, updatedAt: at(9) });
    expect(await repository.update(updated, 1)).toBe(true);
    expect(await search('fitbank')).toEqual([]);
    expect(await search('webhooks')).toEqual([id(2)]);

    expect(await repository.remove(id(1))).toBe(true);
    expect(await repository.remove(id(1))).toBe(false);
    expect(await search('tarif')).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes_search').get()).toEqual({ n: 1 });
  });

  it('refuses updates of a revision that is no longer stored', async () => {
    await repository.insert(note(1));
    expect(await repository.update(note(1, { title: 'B', revision: 2 }), 1)).toBe(true);
    expect(await repository.update(note(1, { title: 'C', revision: 2 }), 1)).toBe(false);
    expect((await repository.get(id(1)))?.title).toBe('B');
    expect(await repository.update(note(7, { revision: 2 }), 1)).toBe(false);
  });

  it('keeps notes of a removed project as workspace notes and follows folder changes', async () => {
    await repository.insert(note(1));
    await repository.insert(note(2, { projectId: OTHER, workspacePath: '/work/other' }));
    db.prepare("UPDATE projects SET workspace_path = '/moved/other' WHERE id = ?").run(OTHER);
    expect((await repository.get(id(2)))?.workspacePath).toBe('/moved/other');

    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT);
    expect(await repository.get(id(1))).toMatchObject({
      projectId: null,
      workspacePath: '/work/app',
    });
    // Registering the folder again shows the note in the new project.
    const owner: NoteOwnerFilter = {
      kind: 'project',
      projectId: id(502),
      workspacePath: '/work/app',
    };
    expect((await list({ owner })).map((item) => item.id)).toEqual([id(1)]);
  });

  it('enforces owners and limits in the schema', async () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO notes (id, project_id, workspace_path, title, content, revision,
             created_at, updated_at) VALUES (?, ?, NULL, 'T', '', 1, 'x', 'x')`,
        )
        .run(id(1), PROJECT),
    ).toThrow();
    await expect(repository.insert(note(2, { projectId: id(999) }))).rejects.toMatchObject({
      code: 'PROJECT_PERSISTENCE_ERROR',
    });
    await expect(repository.insert(note(3, { title: '' }))).rejects.toMatchObject({
      code: 'PROJECT_PERSISTENCE_ERROR',
    });
    // A failed insert leaves no search row behind.
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes_search').get()).toEqual({ n: 0 });
  });
});

describe('migration v12 from a v11 database', () => {
  it('adds notes without touching existing data', () => {
    const temp = createTempDir();
    try {
      const file = path.join(temp.dir, 'v11.db');
      let db = openDatabase({ filePath: file, migrations: MIGRATIONS.slice(0, 11) });
      insertProject(db, PROJECT, '/work/app');
      db.close();
      db = openDatabase({ filePath: file });
      expect(getSchemaVersion(db)).toBe(12);
      expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 0 });
      db.close();
    } finally {
      temp.cleanup();
    }
  });
});
