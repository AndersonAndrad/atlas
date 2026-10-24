import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AtlasSession, Project, TerminalSession } from '@atlas/contracts';
import type { StoredSessionTask } from '@atlas/sessions';
import { AtlasError } from '@atlas/shared';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  MIGRATIONS,
  SqliteProjectRepository,
  SqliteSessionRepository,
  SqliteSettingsRepository,
  SqliteTerminalGroupRepository,
  SqliteTerminalSessionRepository,
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

function terminalSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    projectId: project().id,
    title: 'atlas',
    customTitle: null,
    autoTitle: 'atlas',
    groupId: null,
    groupPosition: 0,
    shell: { id: 'zsh', name: 'zsh', path: '/bin/zsh' },
    cwd: '/work/atlas',
    currentCwd: '/work/atlas',
    cwdSource: 'initial',
    status: 'RUNNING',
    pid: 4242,
    columns: 80,
    rows: 24,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function atlasSession(overrides: Partial<AtlasSession> = {}): AtlasSession {
  return {
    id: '00000000-0000-4000-8000-0000000000e1',
    name: 'NOVA auth',
    objective: 'Implement authentication',
    projectId: null,
    workspacePath: null,
    status: 'DRAFT',
    executionProfile: 'BALANCED',
    constraints: ['No network'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function sessionTask(overrides: Partial<StoredSessionTask> = {}): StoredSessionTask {
  return {
    id: '00000000-0000-4000-8000-0000000000f1',
    sessionId: atlasSession().id,
    title: 'Design',
    description: '',
    status: 'PENDING',
    dependencies: [],
    assignedAgentId: null,
    validationCriteria: ['Reviewed'],
    position: 0,
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
              version: MIGRATIONS.length + 1,
              name: 'broken',
              sql: 'CREATE TABLE ok_part (id INTEGER); SELECT nope FROM missing;',
            },
          ],
        }),
      ).toThrow(AtlasError);
      db = openDatabase({ filePath: dbPath });
      expect(getSchemaVersion(db)).toBe(MIGRATIONS.length);
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

  describe('SqliteTerminalSessionRepository', () => {
    let sessions: SqliteTerminalSessionRepository;

    beforeEach(async () => {
      await new SqliteProjectRepository(db).insert({ project: project(), pathKey: '/work/atlas' });
      sessions = new SqliteTerminalSessionRepository(db);
    });

    it('stores metadata only and round-trips optional fields', async () => {
      await sessions.save(terminalSession());
      await sessions.save(
        terminalSession({
          title: 'Renamed',
          customTitle: 'Renamed',
          status: 'EXITED',
          exitCode: 130,
          signal: 2,
          endReason: 'exited',
          endedAt: '2026-01-01T00:01:00.000Z',
        }),
      );
      expect(await sessions.findAll()).toEqual([
        terminalSession({
          title: 'Renamed',
          customTitle: 'Renamed',
          status: 'EXITED',
          exitCode: 130,
          signal: 2,
          endReason: 'exited',
          endedAt: '2026-01-01T00:01:00.000Z',
        }),
      ]);
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('terminal_sessions')")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(columns).not.toContain('output');
    });

    it('marks sessions left running by a previous Engine as lost', async () => {
      await sessions.save(terminalSession());
      await sessions.save(
        terminalSession({
          id: '00000000-0000-4000-8000-0000000000a2',
          status: 'EXITED',
          exitCode: 0,
          endReason: 'exited',
        }),
      );
      expect(await sessions.markInterrupted('2026-01-02T00:00:00.000Z')).toBe(1);
      const [lost, exited] = await sessions.findAll();
      expect(lost).toMatchObject({
        status: 'TERMINATED',
        endReason: 'engine-lost',
        endedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(exited).toMatchObject({ status: 'EXITED', endReason: 'exited' });
    });

    it('deletes sessions with their project and rejects invalid rows', async () => {
      await sessions.save(terminalSession());
      await expect(
        sessions.save(
          terminalSession({ id: '00000000-0000-4000-8000-0000000000a3', status: 'BOGUS' as never }),
        ),
      ).rejects.toMatchObject({ code: 'PROJECT_PERSISTENCE_ERROR' });
      await expect(
        sessions.save(
          terminalSession({
            id: '00000000-0000-4000-8000-0000000000a4',
            projectId: '00000000-0000-4000-8000-00000000ffff',
          }),
        ),
      ).rejects.toMatchObject({ code: 'PROJECT_PERSISTENCE_ERROR' });

      // Removing a project keeps its terminals; they become standalone.
      await new SqliteProjectRepository(db).delete(project().id);
      expect(await sessions.findAll()).toEqual([terminalSession({ projectId: null })]);
    });

    it('stores standalone terminals, custom names, detected directories and groups', async () => {
      const groups = new SqliteTerminalGroupRepository(db);
      await groups.save({
        id: '00000000-0000-4000-8000-0000000000b1',
        name: 'Dev',
        position: 0,
        collapsed: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const standalone = terminalSession({
        projectId: null,
        title: 'Docker Services',
        customTitle: 'Docker Services',
        autoTitle: 'srv',
        cwd: '/srv',
        currentCwd: '/srv/compose',
        cwdSource: 'detected',
        groupId: '00000000-0000-4000-8000-0000000000b1',
        groupPosition: 3,
      });
      await sessions.save(standalone);
      expect(await sessions.findAll()).toEqual([standalone]);

      await groups.delete('00000000-0000-4000-8000-0000000000b1');
      expect((await sessions.findAll())[0]).toMatchObject({ groupId: null, groupPosition: 3 });
    });
  });

  describe('SqliteTerminalGroupRepository', () => {
    it('orders groups and saves positions atomically', async () => {
      const groups = new SqliteTerminalGroupRepository(db);
      const make = (n: number, position: number) => ({
        id: `00000000-0000-4000-8000-0000000000c${n}`,
        name: `G${n}`,
        position,
        collapsed: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      await groups.save(make(1, 0));
      await groups.save(make(2, 1));
      await groups.saveAll([make(1, 1), make(2, 0)]);
      expect((await groups.findAll()).map((group) => group.name)).toEqual(['G2', 'G1']);
      await expect(groups.save({ ...make(3, 2), name: '' })).rejects.toMatchObject({
        code: 'PROJECT_PERSISTENCE_ERROR',
      });
    });
  });

  describe('migration v6 from a v5 database', () => {
    it('keeps shared context and adds retrieval columns with neutral defaults', () => {
      db.close();
      const v5Path = path.join(temp.dir, 'v5.db');
      db = openDatabase({ filePath: v5Path, migrations: MIGRATIONS.slice(0, 5) });
      db.prepare(
        `INSERT INTO context_tasks (id, project_id, workspace_path, title, objective, status,
           base_commit, created_at, updated_at)
         VALUES ('00000000-0000-4000-8000-0000000000e1', NULL, '/repo', 'T', 'O', 'open', NULL, 'x', 'x')`,
      ).run();
      db.prepare(
        `INSERT INTO context_entries (id, scope, project_id, workspace_path, task_id, session_id,
           category, title, body, status, verification, source_kind, source_ref, recorded_by,
           created_at, updated_at)
         VALUES ('00000000-0000-4000-8000-0000000000e2', 'workspace', NULL, '/repo', NULL, NULL,
           'note', 'Kept', '', 'active', 'user', 'user', NULL, 'desktop', 'x', 'x')`,
      ).run();
      db.close();

      db = openDatabase({ filePath: v5Path });
      expect(getSchemaVersion(db)).toBe(12);
      expect(db.prepare('SELECT title, required FROM context_entries').all()).toEqual([
        { title: 'Kept', required: 0 },
      ]);
      expect(db.prepare('SELECT base_branch, budget_tokens FROM context_tasks').all()).toEqual([
        { base_branch: null, budget_tokens: null },
      ]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM context_reconciliations').get()).toEqual({
        n: 0,
      });
      expect(() =>
        db.prepare("UPDATE context_tasks SET budget_tokens = 10 WHERE title = 'T'").run(),
      ).toThrow();
    });
  });

  describe('migration v3 from a v2 database', () => {
    it('keeps sessions, separates names and drops per-project layouts', () => {
      db.close();
      const v2Path = path.join(temp.dir, 'v2.db');
      db = openDatabase({ filePath: v2Path, migrations: MIGRATIONS.slice(0, 2) });
      db.prepare(
        `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
           created_at, updated_at) VALUES (?, 'A', '/a', '/a', '[]', 0, 'x', 'x')`,
      ).run(project().id);
      const insert = db.prepare(
        `INSERT INTO terminal_sessions (id, project_id, title, shell_id, shell_name, shell_path, cwd,
           status, columns, rows, created_at)
         VALUES (?, ?, ?, 'zsh', 'zsh', '/bin/zsh', '/a', 'TERMINATED', 80, 24, ?)`,
      );
      insert.run('00000000-0000-4000-8000-0000000000d1', project().id, 'zsh', '2026-01-01');
      insert.run('00000000-0000-4000-8000-0000000000d2', project().id, 'zsh 2', '2026-01-02');
      insert.run('00000000-0000-4000-8000-0000000000d3', project().id, 'Dev server', '2026-01-03');
      db.prepare("INSERT INTO application_settings VALUES ('terminal.layout.x', '{}')").run();
      db.prepare("INSERT INTO application_settings VALUES ('terminal.preferences', '{}')").run();
      db.close();

      db = openDatabase({ filePath: v2Path });
      expect(getSchemaVersion(db)).toBe(12);
      const rows = db
        .prepare(
          'SELECT auto_title, custom_title, group_position, current_cwd FROM terminal_sessions ORDER BY created_at',
        )
        .all();
      expect(rows).toEqual([
        { auto_title: 'zsh', custom_title: null, group_position: 0, current_cwd: '/a' },
        { auto_title: 'zsh', custom_title: null, group_position: 1, current_cwd: '/a' },
        { auto_title: 'zsh', custom_title: 'Dev server', group_position: 2, current_cwd: '/a' },
      ]);
      const keys = db
        .prepare('SELECT key FROM application_settings ORDER BY key')
        .all()
        .map((row) => (row as { key: string }).key);
      expect(keys).toEqual(['terminal.preferences']);
    });
  });

  describe('SqliteSessionRepository', () => {
    const event = (type: 'SESSION_CREATED' | 'TASK_CREATED' = 'SESSION_CREATED') => ({
      type,
      occurredAt: '2026-01-01T00:00:00.000Z',
      metadata: {},
    });

    it('stores sessions and commits changes guarded by the revision', async () => {
      const repo = new SqliteSessionRepository(db);
      await repo.insert(atlasSession(), [event()]);
      const stored = await repo.findById(atlasSession().id);
      expect(stored).toEqual({ session: atlasSession(), revision: 0 });

      const ready = atlasSession({ status: 'READY', updatedAt: '2026-01-02T00:00:00.000Z' });
      expect(
        await repo.commit({ sessionId: ready.id, expectedRevision: 0, session: ready, events: [] }),
      ).toBe(true);
      // A writer that read revision 0 loses: nothing it sent is applied.
      expect(
        await repo.commit({
          sessionId: ready.id,
          expectedRevision: 0,
          session: atlasSession({ name: 'Stale' }),
          upsertTasks: [sessionTask()],
          events: [event('TASK_CREATED')],
        }),
      ).toBe(false);
      expect(await repo.findById(ready.id)).toEqual({ session: ready, revision: 1 });
      expect(await repo.findTasks(ready.id)).toEqual([]);
      expect((await repo.findEvents(ready.id, 10)).map((item) => item.type)).toEqual([
        'SESSION_CREATED',
      ]);
    });

    it('persists tasks, dependencies and events in order', async () => {
      const repo = new SqliteSessionRepository(db);
      await repo.insert(atlasSession(), [event()]);
      const design = sessionTask();
      const build = sessionTask({
        id: '00000000-0000-4000-8000-0000000000f2',
        title: 'Build',
        position: 1,
        dependencies: [design.id],
        status: 'COMPLETED',
      });
      // Both tasks in one change: dependencies are written after the tasks exist.
      await repo.commit({
        sessionId: design.sessionId,
        expectedRevision: 0,
        upsertTasks: [build, design],
        events: [event('TASK_CREATED'), event('TASK_CREATED')],
      });
      expect(await repo.findTasks(design.sessionId)).toEqual([design, build]);
      expect(await repo.countTasks([design.sessionId])).toEqual(
        new Map([[design.sessionId, { total: 2, completed: 1 }]]),
      );
      const events = await repo.findEvents(design.sessionId, 2);
      expect(events.map((item) => item.type)).toEqual(['TASK_CREATED', 'TASK_CREATED']);
      expect(events[0]!.id).toBeLessThan(events[1]!.id);

      // A task others depend on cannot be deleted at the database level either.
      await expect(
        repo.commit({
          sessionId: design.sessionId,
          expectedRevision: 1,
          removeTaskIds: [design.id],
          events: [],
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_PERSISTENCE_ERROR' });
      expect(await repo.findTasks(design.sessionId)).toHaveLength(2);
    });

    it('rejects dependencies and task ids across sessions', async () => {
      const repo = new SqliteSessionRepository(db);
      const other = atlasSession({ id: '00000000-0000-4000-8000-0000000000e2' });
      await repo.insert(atlasSession(), []);
      await repo.insert(other, []);
      const foreign = sessionTask({
        id: '00000000-0000-4000-8000-0000000000f9',
        sessionId: other.id,
      });
      await repo.commit({
        sessionId: other.id,
        expectedRevision: 0,
        upsertTasks: [foreign],
        events: [],
      });
      await expect(
        repo.commit({
          sessionId: atlasSession().id,
          expectedRevision: 0,
          upsertTasks: [sessionTask({ dependencies: [foreign.id] })],
          events: [],
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_PERSISTENCE_ERROR' });
      await expect(
        repo.commit({
          sessionId: atlasSession().id,
          expectedRevision: 0,
          upsertTasks: [{ ...foreign, sessionId: atlasSession().id, title: 'Hijack' }],
          events: [],
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_PERSISTENCE_ERROR' });
      expect((await repo.findTasks(other.id))[0]!.title).toBe('Design');
    });

    it('filters archived sessions and clears removed projects', async () => {
      await new SqliteProjectRepository(db).insert({ project: project(), pathKey: '/work/atlas' });
      const repo = new SqliteSessionRepository(db);
      await repo.insert(atlasSession({ projectId: project().id }), []);
      await repo.insert(
        atlasSession({
          id: '00000000-0000-4000-8000-0000000000e3',
          status: 'CANCELLED',
          archivedAt: '2026-01-03T00:00:00.000Z',
          createdAt: '2026-01-02T00:00:00.000Z',
        }),
        [],
      );
      expect((await repo.findAll({ includeArchived: false })).map((s) => s.name)).toHaveLength(1);
      expect(await repo.findAll({ includeArchived: true })).toHaveLength(2);
      expect(await repo.findAll({ includeArchived: true, projectId: project().id })).toHaveLength(
        1,
      );
      expect((await repo.findByProject(project().id)).map((item) => item.session.id)).toEqual([
        atlasSession().id,
      ]);
      expect(await repo.findByStatuses(['CANCELLED'])).toHaveLength(1);

      await new SqliteProjectRepository(db).delete(project().id);
      expect((await repo.findById(atlasSession().id))?.session.projectId).toBeNull();
    });

    it('enforces session invariants in the schema', async () => {
      const repo = new SqliteSessionRepository(db);
      await expect(
        repo.insert(atlasSession({ projectId: project().id, workspacePath: '/x' }), []),
      ).rejects.toMatchObject({ code: 'PROJECT_PERSISTENCE_ERROR' });
      await expect(
        repo.insert(atlasSession({ archivedAt: '2026-01-02T00:00:00.000Z' }), []),
      ).rejects.toMatchObject({ code: 'PROJECT_PERSISTENCE_ERROR' });
      await expect(
        repo.insert(
          atlasSession({ completedAt: '2026-01-02T00:00:00.000Z', status: 'CANCELLED' }),
          [],
        ),
      ).rejects.toMatchObject({ code: 'PROJECT_PERSISTENCE_ERROR' });
      expect(await repo.findAll({ includeArchived: true })).toEqual([]);
    });

    it('lists pending approvals only', async () => {
      const repo = new SqliteSessionRepository(db);
      await repo.insert(atlasSession(), []);
      const insert = db.prepare(
        `INSERT INTO session_approvals (id, session_id, summary, status, requested_at)
         VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
      );
      insert.run(
        '00000000-0000-4000-8000-0000000000b1',
        atlasSession().id,
        'Run npm install',
        'PENDING',
      );
      insert.run('00000000-0000-4000-8000-0000000000b2', atlasSession().id, 'Old', 'APPROVED');
      expect((await repo.findPendingApprovals(atlasSession().id)).map((a) => a.summary)).toEqual([
        'Run npm install',
      ]);
    });
  });
});
