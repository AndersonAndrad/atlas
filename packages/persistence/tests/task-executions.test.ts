import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskExecution } from '@atlas/contracts';
import {
  MIGRATIONS,
  SqliteContextRepository,
  SqliteTaskExecutionRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 27, 12, minute)).toISOString();
const PROJECT = id(500);
const TASK = id(600);
const OTHER_TASK = id(601);
const TERMINAL = id(700);

const execution = (n: number, overrides: Partial<TaskExecution> = {}): TaskExecution => ({
  id: id(n),
  requestId: id(n + 100),
  taskId: TASK,
  projectId: PROJECT,
  workspacePath: null,
  mode: 'new-terminal',
  provider: 'claude',
  profileId: null,
  profileName: null,
  terminalId: TERMINAL,
  terminalTitle: 'Claude Code · Task',
  aiSessionId: null,
  runRef: null,
  status: 'LAUNCHING',
  exitCode: null,
  endReason: null,
  createdAt: at(n),
  startedAt: null,
  endedAt: null,
  cancelRequestedAt: null,
  reviewedAt: null,
  ...overrides,
});

describe('SqliteTaskExecutionRepository (SDD-025 Task 02)', () => {
  let db: Database;
  let repository: SqliteTaskExecutionRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    db.prepare(
      `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
         created_at, updated_at) VALUES (?, 'P', '/work/app', '/work/app', '[]', 0, 'x', 'x')`,
    ).run(PROJECT);
    for (const task of [TASK, OTHER_TASK]) {
      db.prepare(
        `INSERT INTO context_tasks (id, project_id, title, objective, status, created_at, updated_at)
         VALUES (?, ?, 'Task', 'Objective', 'open', 'x', 'x')`,
      ).run(task, PROJECT);
    }
    repository = new SqliteTaskExecutionRepository(db);
  });
  afterEach(() => db.close());

  it('is created by migration v20', () => {
    expect(getSchemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(MIGRATIONS.find((migration) => migration.version === 20)!.name).toBe('task_executions');
  });

  it('stores, updates and lists executions newest first', async () => {
    await repository.insert(execution(1));
    await repository.insert(execution(2, { taskId: OTHER_TASK }));
    await repository.insert(execution(3, { mode: 'existing-terminal', profileName: 'work' }));
    const updated = execution(1, {
      status: 'REVIEW_REQUIRED',
      runRef: '20261027T120000-1',
      exitCode: 0,
      startedAt: at(4),
      endedAt: at(5),
      reviewedAt: at(6),
    });
    await repository.update(updated);
    expect(await repository.get(id(1))).toEqual(updated);
    expect(await repository.findByRequestId(id(103))).toEqual(
      execution(3, { mode: 'existing-terminal', profileName: 'work' }),
    );
    expect((await repository.listForTask(TASK, 10)).map((item) => item.id)).toEqual([id(3), id(1)]);
    expect(await repository.listForTask(TASK, 1)).toHaveLength(1);
    expect(await repository.get(id(99))).toBeNull();
  });

  it('refuses a second execution with the same request id', async () => {
    await repository.insert(execution(1));
    await expect(repository.insert(execution(2, { requestId: id(101) }))).rejects.toMatchObject({
      code: 'PROJECT_PERSISTENCE_ERROR',
    });
  });

  it('lists active and unreviewed finished executions', async () => {
    await repository.insert(execution(1, { status: 'RUNNING' }));
    await repository.insert(execution(2, { status: 'FAILED', endReason: 'exit-code' }));
    await repository.insert(execution(3, { status: 'REVIEW_REQUIRED', reviewedAt: at(9) }));
    await repository.insert(execution(4, { status: 'UNTRACKED', terminalId: id(701) }));
    expect((await repository.listActive()).map((item) => item.id)).toEqual([id(1)]);
    expect((await repository.listUnreviewedForTerminal(TERMINAL)).map((item) => item.id)).toEqual([
      id(2),
    ]);
  });

  it('removes executions with their task and moves them with a removed project', async () => {
    await repository.insert(execution(1));
    await repository.insert(execution(2, { taskId: OTHER_TASK }));
    db.prepare('DELETE FROM context_tasks WHERE id = ?').run(TASK);
    expect(await repository.get(id(1))).toBeNull();
    // As the Engine does before removing a project: records keep its folder as owner.
    await new SqliteContextRepository(db).reassignProject(PROJECT, '/work/app');
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT);
    expect(await repository.get(id(2))).toMatchObject({
      projectId: null,
      workspacePath: '/work/app',
    });
  });

  it('rejects values outside the schema', async () => {
    await expect(
      repository.insert(execution(1, { status: 'DONE' as TaskExecution['status'] })),
    ).rejects.toMatchObject({ code: 'PROJECT_PERSISTENCE_ERROR' });
  });
});
