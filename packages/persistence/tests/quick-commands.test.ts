import path from 'node:path';
import {
  MIGRATIONS,
  SqliteQuickCommandRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir } from '../../../tests/support/temp.js';

const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const GONE = '00000000-0000-4000-8000-0000000000ff';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const insertProject = (db: Database, projectId: string, name: string) =>
  db
    .prepare(
      `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
         created_at, updated_at) VALUES (?, ?, ?, ?, '[]', 0, 'x', 'x')`,
    )
    .run(projectId, name, `/${name}`, `/${name}`);

const setting = (db: Database, key: string, value: unknown) =>
  db
    .prepare('INSERT INTO application_settings (key, value) VALUES (?, ?)')
    .run(key, typeof value === 'string' ? value : JSON.stringify(value));

const command = (n: number, prioritized: boolean) => ({
  id: id(n),
  name: `c${n}`,
  command: `echo ${n}`,
  prioritized,
});

describe('quick command scopes in SQLite (migration v25, SDD-025 Task 03)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let db: Database;
  let file: string;

  /** A v24 database with projects and the PLAN-023 settings, then migrated. */
  const migrate = (prepare: (db: Database) => void) => {
    db = openDatabase({ filePath: file, migrations: MIGRATIONS.slice(0, 24) });
    insertProject(db, P1, 'beta');
    insertProject(db, P2, 'alpha');
    prepare(db);
    db.close();
    db = openDatabase({ filePath: file });
    return new SqliteQuickCommandRepository(db);
  };
  const settingsKeys = () =>
    (
      db.prepare("SELECT key FROM application_settings WHERE key LIKE 'quickCommands.%'").all() as {
        key: string;
      }[]
    ).map((row) => row.key);

  beforeEach(() => {
    temp = createTempDir();
    file = path.join(temp.dir, 'atlas.db');
  });
  afterEach(() => {
    db.close();
    temp.cleanup();
  });

  it('keeps every command, its order and its meaning', async () => {
    const repository = migrate((db) => {
      setting(db, 'quickCommands.library', {
        version: 1,
        commands: [
          command(1, true), // hidden nowhere: all projects
          command(2, true), // hidden in P1: only P2
          command(3, false), // enabled in P1 and P2
          command(4, false), // enabled nowhere: no project, never all
          command(5, false), // enabled only in a removed project
        ],
      });
      setting(db, `quickCommands.project.${P1}`, { hidden: [id(2)], enabled: [id(3)] });
      // Saved by PLAN-023 revision 1, before `enabled` existed.
      setting(db, `quickCommands.project.${P2}`, { hidden: [], enabled: [id(3)] });
      setting(db, `quickCommands.project.${GONE}`, { hidden: [id(1)], enabled: [id(5)] });
    });
    expect(getSchemaVersion(db)).toBe(25);
    expect(await repository.list()).toEqual([
      { id: id(1), name: 'c1', command: 'echo 1', scope: 'ALL', projectIds: [] },
      { id: id(2), name: 'c2', command: 'echo 2', scope: 'PROJECTS', projectIds: [P2] },
      // Projects in name order: alpha (P2), beta (P1).
      { id: id(3), name: 'c3', command: 'echo 3', scope: 'PROJECTS', projectIds: [P2, P1] },
      { id: id(4), name: 'c4', command: 'echo 4', scope: 'PROJECTS', projectIds: [] },
      { id: id(5), name: 'c5', command: 'echo 5', scope: 'PROJECTS', projectIds: [] },
    ]);
    expect(settingsKeys()).toEqual([]);
  });

  it('reads project settings without `enabled` and skips invalid entries', async () => {
    const repository = migrate((db) => {
      setting(db, 'quickCommands.library', {
        version: 1,
        commands: [command(1, true), { id: 'short', name: 'x', command: 'y' }, 'text'],
      });
      setting(db, `quickCommands.project.${P1}`, { hidden: [id(1)] });
      setting(db, `quickCommands.project.${P2}`, 'not json');
    });
    expect(await repository.list()).toEqual([
      { id: id(1), name: 'c1', command: 'echo 1', scope: 'PROJECTS', projectIds: [P2] },
    ]);
  });

  it('leaves an unreadable library untouched and works without one', async () => {
    let repository = migrate((db) => setting(db, 'quickCommands.library', '{"version":2}'));
    expect(await repository.list()).toEqual([]);
    expect(settingsKeys()).toEqual(['quickCommands.library']);
    db.close();
    file = path.join(temp.dir, 'other.db');
    repository = migrate((db) => setting(db, 'quickCommands.library', 'not json'));
    expect(await repository.list()).toEqual([]);
    db.close();
    file = path.join(temp.dir, 'empty.db');
    repository = migrate(() => undefined);
    expect(await repository.list()).toEqual([]);
  });

  it('removes a deleted project from commands without making them global', async () => {
    const repository = migrate(() => undefined);
    const now = '2026-10-28T12:00:00.000Z';
    await repository.insert(
      { id: id(1), name: 'Test', command: 'pnpm test', scope: 'PROJECTS', projectIds: [P1] },
      now,
    );
    await repository.insert(
      { id: id(2), name: 'Both', command: 'ls', scope: 'PROJECTS', projectIds: [P1, P2] },
      now,
    );
    db.prepare('DELETE FROM projects WHERE id = ?').run(P1);
    expect(await repository.list()).toEqual([
      expect.objectContaining({ id: id(1), scope: 'PROJECTS', projectIds: [] }),
      expect.objectContaining({ id: id(2), scope: 'PROJECTS', projectIds: [P2] }),
    ]);
    await repository.setAssignment(id(1), P2, true, now);
    await repository.swap(id(1), id(2));
    expect((await repository.list()).map((item) => [item.id, item.projectIds])).toEqual([
      [id(2), [P2]],
      [id(1), [P2]],
    ]);
    expect(await repository.update({ ...(await repository.list())[0]!, id: id(99) }, now)).toBe(
      false,
    );
    expect(await repository.remove(id(1))).toBe(true);
    expect(await repository.count()).toBe(1);
  });
});
