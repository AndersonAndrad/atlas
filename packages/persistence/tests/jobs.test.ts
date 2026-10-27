import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobRecord } from '@atlas/jobs';
import {
  MIGRATIONS,
  SqliteJobRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import { createTempDir } from '../../../tests/support/temp.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 26, 12, minute)).toISOString();
const PROJECT = id(500);

const job = (n: number, overrides: Partial<JobRecord> = {}): JobRecord => ({
  id: id(n),
  type: 'COMMAND',
  status: 'QUEUED',
  priority: 'NORMAL',
  projectId: PROJECT,
  workspacePath: '/work/app',
  sessionId: null,
  title: `Job ${n}`,
  description: null,
  origin: 'desktop',
  payload: { type: 'COMMAND', command: 'npm test', timeoutMinutes: 30, confirmedDangerous: false },
  createdAt: at(n),
  queuedAt: at(n),
  startedAt: null,
  finishedAt: null,
  progress: { percent: null, stage: null, message: null, lastActivityAt: null },
  retryCount: 0,
  maxRetries: 0,
  executionReference: null,
  errorSummary: null,
  exitCode: null,
  cancelRequested: false,
  ...overrides,
});

function insertProject(db: Database, projectId: string, folder: string) {
  db.prepare(
    `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
       created_at, updated_at) VALUES (?, 'P', ?, ?, '[]', 0, 'x', 'x')`,
  ).run(projectId, folder, folder);
}

const queued = (record: JobRecord, minute: number) => ({
  jobId: record.id,
  status: record.status,
  at: at(minute),
  detail: 'Queued',
});

describe('SqliteJobRepository', () => {
  let db: Database;
  let repository: SqliteJobRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    insertProject(db, PROJECT, '/work/app');
    repository = new SqliteJobRepository(db);
  });
  afterEach(() => db.close());

  it('stores jobs with their status history and attempts', async () => {
    const record = job(1);
    await repository.insert(record, queued(record, 1));
    expect(await repository.find(id(1))).toEqual(record);
    const reference = { type: 'preflight-run' as const, workspaceId: id(70), runId: id(71) };
    const running = job(1, {
      status: 'RUNNING',
      startedAt: at(2),
      progress: { percent: 40, stage: 'Running', message: null, lastActivityAt: at(3) },
      executionReference: reference,
    });
    await repository.save(
      running,
      { jobId: id(1), status: 'RUNNING', at: at(2), detail: 'Started' },
      {
        jobId: id(1),
        attempt: 1,
        status: 'RUNNING',
        startedAt: at(2),
        finishedAt: null,
        exitCode: null,
        errorSummary: null,
        executionReference: reference,
      },
    );
    // Progress only: no history entry, the attempt stays as it was.
    await repository.save({ ...running, cancelRequested: true }, null, null);
    expect(await repository.find(id(1))).toEqual({ ...running, cancelRequested: true });
    expect((await repository.history(id(1))).map((change) => change.status)).toEqual([
      'QUEUED',
      'RUNNING',
    ]);
    expect(await repository.attempts(id(1))).toEqual([
      expect.objectContaining({ attempt: 1, status: 'RUNNING', executionReference: reference }),
    ]);
  });

  it('does not recreate a job removed meanwhile', async () => {
    await repository.save(job(9), null, null);
    expect(await repository.find(id(9))).toBeNull();
  });

  it('lists newest first with status and project filters and stable paging', async () => {
    for (const n of [1, 2, 3, 4]) {
      const record = job(n, { status: n % 2 === 0 ? 'FAILED' : 'QUEUED', createdAt: at(n) });
      await repository.insert(record, queued(record, n));
    }
    // Same creation time: the later insert comes first.
    const twin = job(5, { createdAt: at(4) });
    await repository.insert(twin, queued(twin, 4));
    const ids = async (query: Parameters<SqliteJobRepository['list']>[0]) =>
      (await repository.list(query)).map((record) => record.id);
    expect(await ids({ limit: 10 })).toEqual([id(5), id(4), id(3), id(2), id(1)]);
    expect(await ids({ limit: 2, before: id(4) })).toEqual([id(3), id(2)]);
    expect(await ids({ limit: 10, statuses: ['FAILED'] })).toEqual([id(4), id(2)]);
    expect(await ids({ limit: 10, projectId: id(999) })).toEqual([]);
    expect(await ids({ limit: 10, before: id(888) })).toEqual([]);
  });

  it('marks unfinished jobs and their open attempts interrupted', async () => {
    const done = job(1, { status: 'COMPLETED', finishedAt: at(2) });
    const running = job(2, { status: 'RUNNING', startedAt: at(3), cancelRequested: true });
    const waiting = job(3);
    for (const record of [done, running, waiting]) {
      await repository.insert(record, queued(record, 1));
    }
    await repository.save(running, null, {
      jobId: id(2),
      attempt: 1,
      status: 'RUNNING',
      startedAt: at(3),
      finishedAt: null,
      exitCode: null,
      errorSummary: null,
      executionReference: null,
    });
    const interrupted = await repository.interruptUnfinished(at(10), 'ATLAS stopped.');
    expect(interrupted.map((record) => [record.id, record.status])).toEqual([
      [id(2), 'INTERRUPTED'],
      [id(3), 'INTERRUPTED'],
    ]);
    expect(await repository.find(id(2))).toMatchObject({
      status: 'INTERRUPTED',
      finishedAt: at(10),
      errorSummary: 'ATLAS stopped.',
      cancelRequested: false,
    });
    expect((await repository.find(id(1)))?.status).toBe('COMPLETED');
    expect(await repository.attempts(id(2))).toEqual([
      expect.objectContaining({ status: 'INTERRUPTED', finishedAt: at(10) }),
    ]);
    expect((await repository.history(id(3))).at(-1)).toMatchObject({
      status: 'INTERRUPTED',
      detail: 'ATLAS stopped.',
    });
    expect(await repository.interruptUnfinished(at(11), 'again')).toEqual([]);
  });

  it('prunes only finished jobs beyond the newest kept, with their history', async () => {
    for (const n of [1, 2, 3, 4]) {
      const record = job(n, { status: n === 1 ? 'RUNNING' : 'COMPLETED' });
      await repository.insert(record, queued(record, n));
    }
    expect(await repository.prune(2)).toEqual([id(2)]);
    expect(await repository.find(id(1))).not.toBeNull();
    expect(await repository.history(id(2))).toEqual([]);
  });

  it('keeps jobs of a removed project without the association', async () => {
    const record = job(1);
    await repository.insert(record, queued(record, 1));
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT);
    expect(await repository.find(id(1))).toMatchObject({
      projectId: null,
      workspacePath: '/work/app',
    });
  });

  it('rejects rows that break the schema', async () => {
    await expect(repository.insert(job(1, { title: '' }), queued(job(1), 1))).rejects.toMatchObject(
      { code: 'PROJECT_PERSISTENCE_ERROR' },
    );
    expect(await repository.find(id(1))).toBeNull();
  });
});

describe('migration v13 from a v12 database', () => {
  it('adds background jobs without touching existing data', () => {
    const temp = createTempDir();
    try {
      const file = path.join(temp.dir, 'v12.db');
      let db = openDatabase({ filePath: file, migrations: MIGRATIONS.slice(0, 12) });
      insertProject(db, PROJECT, '/work/app');
      db.close();
      db = openDatabase({ filePath: file });
      expect(getSchemaVersion(db)).toBe(14);
      expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM background_jobs').get()).toEqual({ n: 0 });
      db.close();
    } finally {
      temp.cleanup();
    }
  });
});
