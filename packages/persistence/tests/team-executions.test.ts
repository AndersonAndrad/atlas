import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TeamExecution } from '@atlas/contracts';
import {
  MIGRATIONS,
  SqliteContextRepository,
  SqliteTeamExecutionRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 27, 12, minute)).toISOString();
const PROJECT = id(500);
const TASK = id(600);

const team = (n: number, overrides: Partial<TeamExecution> = {}): TeamExecution => ({
  id: id(n),
  requestId: id(n + 100),
  taskId: TASK,
  projectId: PROJECT,
  workspacePath: null,
  status: 'RUNNING',
  pause: null,
  pauseDetail: null,
  advance: 'automatic',
  terminalGroupId: null,
  stages: [
    {
      role: 'executor',
      provider: 'claude',
      profileId: null,
      profileName: null,
      status: 'RUNNING',
      executionIds: [id(n + 200)],
      sessionIds: [null],
      terminalId: id(n + 300),
      exitCode: null,
      startedAt: at(n),
      endedAt: null,
      changedFiles: [],
      commits: [],
    },
  ],
  currentStage: 0,
  complexity: 'simple',
  preflight: null,
  summary: null,
  approvedAt: at(n),
  finishedAt: null,
  reviewedAt: null,
  ...overrides,
});

describe('SqliteTeamExecutionRepository (SDD-026 Task 02)', () => {
  let db: Database;
  let repository: SqliteTeamExecutionRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    db.prepare(
      `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
         created_at, updated_at) VALUES (?, 'P', '/work/app', '/work/app', '[]', 0, 'x', 'x')`,
    ).run(PROJECT);
    db.prepare(
      `INSERT INTO context_tasks (id, project_id, title, objective, status, created_at, updated_at)
       VALUES (?, ?, 'Task', 'Objective', 'open', 'x', 'x')`,
    ).run(TASK, PROJECT);
    repository = new SqliteTeamExecutionRepository(db);
  });
  afterEach(() => db.close());

  it('is created by migration v22', () => {
    expect(getSchemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(MIGRATIONS.find((migration) => migration.version === 22)!.name).toBe('team_executions');
  });

  it('round-trips, updates and finds executions by request', async () => {
    await repository.insert(team(1));
    expect(await repository.get(id(1))).toEqual(team(1));
    expect((await repository.findByRequestId(id(101)))?.id).toBe(id(1));
    const done = team(1, { status: 'REVIEW_REQUIRED', currentStage: null, finishedAt: at(9) });
    await repository.update(done);
    expect(await repository.get(id(1))).toEqual(done);
  });

  it('never stores the same request twice', async () => {
    await repository.insert(team(1));
    await expect(repository.insert(team(2, { requestId: id(101) }))).rejects.toMatchObject({
      code: 'PROJECT_PERSISTENCE_ERROR',
    });
  });

  it('lists per task newest first and the active ones', async () => {
    await repository.insert(team(1, { status: 'CANCELLED' }));
    await repository.insert(team(2, { status: 'PAUSED' }));
    await repository.insert(team(3, { status: 'REVIEW_REQUIRED' }));
    expect((await repository.listForTask(TASK, 10)).map((item) => item.id)).toEqual([
      id(3),
      id(2),
      id(1),
    ]);
    expect((await repository.listActive()).map((item) => item.id)).toEqual([id(2)]);
  });

  it('follows its task: moved with a removed project, deleted with the task', async () => {
    await repository.insert(team(1));
    await new SqliteContextRepository(db).reassignProject(PROJECT, '/work/app');
    expect(await repository.get(id(1))).toMatchObject({
      projectId: null,
      workspacePath: '/work/app',
    });
    db.prepare('DELETE FROM context_tasks WHERE id = ?').run(TASK);
    expect(await repository.get(id(1))).toBeNull();
  });
});
