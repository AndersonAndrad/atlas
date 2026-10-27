import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectGitSnapshot } from '@atlas/contracts';
import {
  MIGRATIONS,
  SqliteProjectGitRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import { createTempDir } from '../../../tests/support/temp.js';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';

const insertProject = (db: Database, id: string, name: string) =>
  db
    .prepare(
      `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
         created_at, updated_at) VALUES (?, ?, ?, ?, '[]', 0, 'x', 'x')`,
    )
    .run(id, name, `/${name}`, `/${name}`);

const dirty: ProjectGitSnapshot = {
  state: 'repository',
  branch: 'main',
  headOid: 'b'.repeat(40),
  detachedHead: false,
  unbornHead: false,
  upstream: 'origin/main',
  ahead: 2,
  behind: 0,
  upstreamGone: false,
  changes: {
    modified: 1,
    staged: 1,
    untracked: 3,
    deleted: 0,
    renamed: 0,
    conflicted: 0,
    total: 5,
  },
  pending: {
    state: 'ok',
    commits: [
      {
        hash: 'c'.repeat(40),
        shortHash: 'ccccccc',
        subject: 'feat: add pending push',
        author: 'Ana Dev',
        committedAt: '2026-10-27T09:00:00-03:00',
      },
    ],
    total: 2,
  },
};

describe('project Git monitoring in SQLite (SDD-024)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let db: Database;
  let repository: SqliteProjectGitRepository;

  beforeEach(() => {
    temp = createTempDir();
    db = openDatabase({ filePath: path.join(temp.dir, 'atlas.db') });
    repository = new SqliteProjectGitRepository(db);
    insertProject(db, A, 'a');
  });

  afterEach(() => {
    db.close();
    temp.cleanup();
  });

  it('migrates existing projects with monitoring enabled and no snapshot', () => {
    db.close();
    const v16Path = path.join(temp.dir, 'v16.db');
    db = openDatabase({ filePath: v16Path, migrations: MIGRATIONS.slice(0, 16) });
    insertProject(db, B, 'b');
    db.close();

    db = openDatabase({ filePath: v16Path });
    expect(getSchemaVersion(db)).toBe(18);
    return expect(new SqliteProjectGitRepository(db).list()).resolves.toEqual([
      { projectId: B, monitoringEnabled: true, snapshot: null, refreshedAt: null, error: null },
    ]);
  });

  it('keeps v17 snapshots readable without pending commits after migrating to v18', async () => {
    db.close();
    const v17Path = path.join(temp.dir, 'v17.db');
    db = openDatabase({ filePath: v17Path, migrations: MIGRATIONS.slice(0, 17) });
    insertProject(db, B, 'b');
    db.prepare(
      `INSERT INTO project_git_snapshots (project_id, state, branch, changes, refreshed_at)
       VALUES (?, 'repository', 'main', '{"total":0}', '2026-10-27T10:00:00.000Z')`,
    ).run(B);
    db.close();

    db = openDatabase({ filePath: v17Path });
    expect(getSchemaVersion(db)).toBe(18);
    expect((await new SqliteProjectGitRepository(db).get(B))?.snapshot).toMatchObject({
      state: 'repository',
      branch: 'main',
      headOid: null,
      pending: null,
    });
  });

  it('stores the preference and the snapshot, and keeps them after reopening', async () => {
    expect(await repository.setMonitoring(A, false)).toBe(true);
    await repository.saveSnapshot(A, dirty, '2026-10-27T10:00:00.000Z');
    db.close();

    db = openDatabase({ filePath: path.join(temp.dir, 'atlas.db') });
    expect(await new SqliteProjectGitRepository(db).get(A)).toEqual({
      projectId: A,
      monitoringEnabled: false,
      snapshot: dirty,
      refreshedAt: '2026-10-27T10:00:00.000Z',
      error: null,
    });
  });

  it('keeps the last successful snapshot when a refresh fails, and clears the error on success', async () => {
    await repository.saveSnapshot(A, dirty, '2026-10-27T10:00:00.000Z');
    await repository.saveError(A, 'timeout', '2026-10-27T10:05:00.000Z');
    expect(await repository.get(A)).toMatchObject({
      snapshot: dirty,
      refreshedAt: '2026-10-27T10:00:00.000Z',
      error: { reason: 'timeout', at: '2026-10-27T10:05:00.000Z' },
    });

    await repository.saveSnapshot(A, { state: 'not-repository' }, '2026-10-27T10:06:00.000Z');
    expect(await repository.get(A)).toMatchObject({
      snapshot: { state: 'not-repository' },
      error: null,
    });
  });

  it('records an error without a snapshot', async () => {
    await repository.saveError(A, 'not-installed', '2026-10-27T10:00:00.000Z');
    expect(await repository.get(A)).toMatchObject({
      snapshot: null,
      refreshedAt: null,
      error: { reason: 'not-installed' },
    });
  });

  it('writes nothing for unknown projects and removes snapshots with their project', async () => {
    expect(await repository.setMonitoring(B, true)).toBe(false);
    await repository.saveSnapshot(B, dirty, '2026-10-27T10:00:00.000Z');
    await repository.saveError(B, 'error', '2026-10-27T10:00:00.000Z');
    expect(await repository.get(B)).toBeNull();

    await repository.saveSnapshot(A, dirty, '2026-10-27T10:00:00.000Z');
    db.prepare('DELETE FROM projects WHERE id = ?').run(A);
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_git_snapshots').get()).toEqual({ n: 0 });
  });

  it('clears a snapshot without touching the preference', async () => {
    await repository.setMonitoring(A, false);
    await repository.saveSnapshot(A, dirty, '2026-10-27T10:00:00.000Z');
    await repository.clearSnapshot(A);
    expect(await repository.get(A)).toEqual({
      projectId: A,
      monitoringEnabled: false,
      snapshot: null,
      refreshedAt: null,
      error: null,
    });
  });
});
