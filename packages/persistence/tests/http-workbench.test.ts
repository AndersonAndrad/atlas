import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyHttpRequestDefinition, type HttpRequestDefinition } from '@atlas/contracts';
import {
  MIGRATIONS,
  SqliteHttpWorkbenchRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import { AtlasError } from '@atlas/shared';
import { createTempDir } from '../../../tests/support/temp.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 26, 12, minute)).toISOString();
const PROJECT = id(900);
const OTHER = id(901);

function insertProject(db: Database, projectId: string, folder: string) {
  db.prepare(
    `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
       created_at, updated_at) VALUES (?, 'P', ?, ?, '[]', 0, 'x', 'x')`,
  ).run(projectId, folder, folder);
}

const definition = (url: string, extra: Partial<HttpRequestDefinition> = {}) => ({
  ...emptyHttpRequestDefinition(),
  url,
  ...extra,
});

describe('SqliteHttpWorkbenchRepository', () => {
  let db: Database;
  let repository: SqliteHttpWorkbenchRepository;

  const collection = (
    n: number,
    scope: Parameters<typeof repository.createCollection>[0]['scope'],
  ) =>
    repository.createCollection({
      id: id(n),
      name: `C${n}`,
      description: '',
      scope,
      cookieJar: true,
      createdAt: at(n),
    });

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    repository = new SqliteHttpWorkbenchRepository(db);
    insertProject(db, PROJECT, '/work/app');
    insertProject(db, OTHER, '/work/other');
  });

  afterEach(() => db.close());

  it('lists global collections, those of the project and those shared with it (FR-1417)', () => {
    collection(1, { kind: 'global' });
    collection(2, { kind: 'project', projectId: PROJECT });
    collection(3, { kind: 'project', projectId: OTHER });
    collection(4, { kind: 'shared', projectIds: [PROJECT, OTHER] });
    collection(5, { kind: 'shared', projectIds: [OTHER] });
    const names = (list: { name: string }[]) => list.map((c) => c.name);
    expect(names(repository.listCollections({ kind: 'project', projectId: PROJECT }))).toEqual([
      'C1',
      'C2',
      'C4',
    ]);
    expect(names(repository.listCollections({ kind: 'project', projectId: null }))).toEqual(['C1']);
    expect(names(repository.listCollections({ kind: 'all' }))).toHaveLength(5);
    expect(repository.getCollection(id(4))?.scope).toEqual({
      kind: 'shared',
      projectIds: [PROJECT, OTHER].sort(),
    });
  });

  it('keeps a removed project collection out of every project', () => {
    collection(2, { kind: 'project', projectId: PROJECT });
    collection(4, { kind: 'shared', projectIds: [PROJECT] });
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT);
    expect(repository.getCollection(id(2))?.scope).toEqual({ kind: 'project', projectId: null });
    expect(repository.getCollection(id(4))?.scope).toEqual({ kind: 'shared', projectIds: [] });
    expect(repository.listCollections({ kind: 'project', projectId: OTHER })).toEqual([]);
    expect(repository.listCollections({ kind: 'all' })).toHaveLength(2);
  });

  it('updates names, the cookie jar and the scope', () => {
    collection(1, { kind: 'shared', projectIds: [PROJECT] });
    expect(
      repository.updateCollection(
        id(1),
        { name: 'Renamed', cookieJar: false, scope: { kind: 'global' } },
        at(30),
      ),
    ).toBe(true);
    expect(repository.getCollection(id(1))).toMatchObject({
      name: 'Renamed',
      cookieJar: false,
      scope: { kind: 'global' },
      updatedAt: at(30),
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM http_collection_projects').get()).toEqual({
      n: 0,
    });
    expect(repository.updateCollection(id(99), { name: 'x' }, at(31))).toBe(false);
  });

  it('saves requests in order and updates them in place (FR-1409, FR-1418)', () => {
    collection(1, { kind: 'global' });
    const folder = repository.createFolder(
      { id: id(10), collectionId: id(1), parentId: null, name: 'Users' },
      at(1),
    );
    expect(folder.position).toBe(0);
    const save = (n: number, folderId: string | null, url: string) =>
      repository.saveRequest(
        { id: id(n), collectionId: id(1), folderId, name: `R${n}`, definition: definition(url) },
        at(n),
      );
    save(20, null, 'http://h/a');
    save(21, null, 'http://h/b');
    const third = save(22, id(10), 'http://h/c');
    expect(third).toMatchObject({
      folderId: id(10),
      position: 0,
      method: 'GET',
      url: 'http://h/c',
    });
    const updated = repository.saveRequest(
      {
        id: id(21),
        collectionId: id(1),
        folderId: null,
        name: 'Renamed',
        definition: definition('http://h/b2', { method: 'POST' }),
      },
      at(40),
    );
    expect(updated).toMatchObject({
      name: 'Renamed',
      position: 1,
      method: 'POST',
      url: 'http://h/b2',
    });
    expect(updated.definition.method).toBe('POST');
    const tree = repository.getCollection(id(1))!;
    expect(tree.requests.map((r) => [r.name, r.folderId, r.position])).toEqual([
      ['R20', null, 0],
      ['R22', id(10), 0],
      ['Renamed', null, 1],
    ]);
    expect(tree.updatedAt).toBe(at(40));
  });

  it('moves requests and folders, with their subtree, and refuses cycles (FR-1416)', () => {
    collection(1, { kind: 'global' });
    collection(2, { kind: 'global' });
    repository.createFolder({ id: id(10), collectionId: id(1), parentId: null, name: 'A' }, at(1));
    repository.createFolder(
      { id: id(11), collectionId: id(1), parentId: id(10), name: 'B' },
      at(1),
    );
    for (const n of [20, 21, 22]) {
      repository.saveRequest(
        {
          id: id(n),
          collectionId: id(1),
          folderId: n === 22 ? id(11) : null,
          name: `R${n}`,
          definition: definition('http://h/'),
        },
        at(n),
      );
    }
    repository.move(
      { kind: 'request', id: id(21), collectionId: id(1), folderId: null, position: 0 },
      at(50),
    );
    expect(
      repository
        .getCollection(id(1))!
        .requests.filter((r) => r.folderId === null)
        .map((r) => r.name),
    ).toEqual(['R21', 'R20']);

    expect(() =>
      repository.move(
        { kind: 'folder', id: id(10), collectionId: id(1), folderId: id(11), position: 0 },
        at(51),
      ),
    ).toThrow(AtlasError);

    repository.move(
      { kind: 'folder', id: id(10), collectionId: id(2), folderId: null, position: 0 },
      at(52),
    );
    const target = repository.getCollection(id(2))!;
    expect(target.folders.map((f) => f.name).sort()).toEqual(['A', 'B']);
    expect(target.requests.map((r) => r.name)).toEqual(['R22']);
    expect(repository.getCollection(id(1))!.folders).toEqual([]);
  });

  it('deletes folders with their contents and collections with everything', () => {
    collection(1, { kind: 'global' });
    repository.createFolder({ id: id(10), collectionId: id(1), parentId: null, name: 'A' }, at(1));
    repository.createFolder(
      { id: id(11), collectionId: id(1), parentId: id(10), name: 'B' },
      at(1),
    );
    repository.saveRequest(
      {
        id: id(20),
        collectionId: id(1),
        folderId: id(11),
        name: 'R',
        definition: definition('http://h/'),
      },
      at(2),
    );
    expect(repository.deleteFolder(id(10))).toBe(true);
    expect(repository.getRequest(id(20))).toBeNull();
    expect(repository.deleteCollection(id(1))).toBe(true);
    expect(repository.deleteCollection(id(1))).toBe(false);
  });

  it('copies a collection tree in one transaction', () => {
    repository.insertCollectionTree(
      {
        id: id(3),
        name: 'Copy',
        description: 'd',
        scope: { kind: 'global' },
        cookieJar: false,
        createdAt: at(1),
      },
      [
        { id: id(31), collectionId: id(3), parentId: id(30), name: 'Child', position: 0 },
        { id: id(30), collectionId: id(3), parentId: null, name: 'Root', position: 0 },
      ],
      [
        {
          id: id(32),
          collectionId: id(3),
          folderId: id(31),
          name: 'R',
          definition: definition('http://h/'),
        },
      ],
    );
    const copy = repository.getCollection(id(3))!;
    expect(copy.folders).toHaveLength(2);
    expect(copy.requests[0]).toMatchObject({ folderId: id(31), name: 'R' });
  });

  it('recognizes files referred to by saved requests', () => {
    collection(1, { kind: 'global' });
    repository.saveRequest(
      {
        id: id(20),
        collectionId: id(1),
        folderId: null,
        name: 'Upload',
        definition: definition('http://h/', {
          method: 'POST',
          body: {
            type: 'binary',
            file: { path: '/data/photo.png', name: 'photo.png' },
            contentType: null,
          },
        }),
      },
      at(1),
    );
    expect(repository.isStoredFile('/data/photo.png')).toBe(true);
    expect(repository.isStoredFile('/data/other.png')).toBe(false);
    expect(repository.isStoredFile('photo.png')).toBe(false);
  });

  it('keeps the newest history entries, pages them and suggests URLs (FR-1419)', () => {
    collection(1, { kind: 'global' });
    for (let n = 1; n <= 7; n += 1) {
      repository.addHistory(
        {
          requestId: null,
          collectionId: id(1),
          method: 'GET',
          url: n === 7 ? 'http://h/?token=[secret]' : `http://h/${n % 3}`,
          status: n === 5 ? null : 200,
          durationMs: n,
          responseBytes: n === 5 ? null : 10,
          errorCode: n === 5 ? 'HTTP_TIMEOUT' : null,
          errorSummary: n === 5 ? 'The server did not answer in time.' : null,
          executedAt: at(n),
        },
        5,
      );
    }
    const first = repository.history({ limit: 3 });
    expect(first.entries.map((e) => e.durationMs)).toEqual([7, 6, 5]);
    expect(first.hasMore).toBe(true);
    const second = repository.history({ limit: 3, before: first.entries[2]!.id });
    expect(second.entries.map((e) => e.durationMs)).toEqual([4, 3]);
    expect(second.hasMore).toBe(false);
    expect(first.entries[2]).toMatchObject({ status: null, errorCode: 'HTTP_TIMEOUT' });
    expect(repository.recentUrls(10)).toEqual(['http://h/0', 'http://h/2', 'http://h/1']);
    repository.clearHistory();
    expect(repository.history({ limit: 3 }).entries).toEqual([]);
  });

  it('stores saved responses and keeps them when their request is deleted', () => {
    collection(1, { kind: 'global' });
    repository.saveRequest(
      {
        id: id(20),
        collectionId: id(1),
        folderId: null,
        name: 'R',
        definition: definition('http://h/'),
      },
      at(1),
    );
    repository.saveSnapshot({
      id: id(40),
      requestId: id(20),
      name: 'Before',
      method: 'GET',
      url: 'http://h/',
      status: 200,
      statusText: 'OK',
      headers: [['Content-Type', 'application/json']],
      contentType: 'application/json',
      bodyKind: 'json',
      body: '{"a":1}',
      bodyTruncated: false,
      createdAt: at(2),
    });
    expect(repository.listSnapshots(id(20)).map((s) => s.name)).toEqual(['Before']);
    expect(repository.countSnapshots()).toBe(1);
    repository.deleteRequest(id(20));
    expect(repository.getSnapshot(id(40))).toMatchObject({
      requestId: null,
      headers: [['Content-Type', 'application/json']],
      body: '{"a":1}',
    });
    expect(repository.listSnapshots(null)).toHaveLength(1);
    expect(repository.deleteSnapshot(id(40))).toBe(true);
  });
});

describe('migration v14 from a v13 database', () => {
  it('adds the API Workbench without touching existing data', () => {
    const temp = createTempDir();
    try {
      const file = path.join(temp.dir, 'v13.db');
      let db = openDatabase({ filePath: file, migrations: MIGRATIONS.slice(0, 13) });
      insertProject(db, PROJECT, '/work/app');
      db.close();
      db = openDatabase({ filePath: file });
      expect(getSchemaVersion(db)).toBe(18);
      expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM http_collections').get()).toEqual({ n: 0 });
      db.close();
    } finally {
      temp.cleanup();
    }
  });
});
