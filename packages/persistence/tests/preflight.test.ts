import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreflightCheckResult, PreflightRun, PreflightWorkspace } from '@atlas/contracts';
import { SqlitePreflightRepository, openDatabase, type Database } from '@atlas/persistence';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const workspace = (n: number, path = `/w/${n}`): PreflightWorkspace => ({
  id: id(n),
  path,
  projectId: null,
  name: `W${n}`,
  createdAt: '2026-10-23T12:00:00.000Z',
  updatedAt: '2026-10-23T12:00:00.000Z',
});

const result = (status: PreflightCheckResult['status']): PreflightCheckResult => ({
  position: 0,
  checkId: 'lint',
  name: 'Lint',
  type: 'COMMAND',
  category: 'LINT',
  required: true,
  method: 'LOCAL_SHELL',
  reference: 'pnpm lint',
  status,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  exitCode: null,
  detail: null,
  environment: 'Local shell (/bin/sh)',
  digest: 'a'.repeat(64),
  outputLines: 0,
  outputTruncated: false,
});

const run = (
  n: number,
  workspaceId: string,
  startedAt: string,
  status: PreflightRun['status'],
): PreflightRun => ({
  id: id(100 + n),
  workspaceId,
  projectId: null,
  workspacePath: '/w/1',
  profileId: null,
  profileName: 'Selected checks',
  trigger: 'MANUAL',
  status,
  requiredOutcome: 'NONE',
  sourceRevision: 'abc',
  branch: 'main',
  sourceStateFingerprint: 'f'.repeat(64),
  sourceChangedDuringRun: false,
  retryOf: null,
  startedAt,
  finishedAt: null,
  results: [result(status === 'RUNNING' ? 'RUNNING' : 'PASSED')],
});

describe('SqlitePreflightRepository', () => {
  let db: Database;
  let repository: SqlitePreflightRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    repository = new SqlitePreflightRepository(db);
  });
  afterEach(() => db.close());

  it('stores workspaces with their configuration and one workspace per path', async () => {
    await repository.insertWorkspace(workspace(1), '{"checks":[],"profiles":[]}');
    expect(await repository.findWorkspaceByPath('/w/1')).toEqual(workspace(1));
    await repository.updateWorkspace({ ...workspace(1), name: 'Renamed' }, '{"checks":[1]}');
    expect(await repository.findWorkspace(id(1))).toEqual({
      workspace: { ...workspace(1), name: 'Renamed' },
      config: '{"checks":[1]}',
    });
    await expect(repository.insertWorkspace(workspace(2, '/w/1'), '{}')).rejects.toMatchObject({
      code: 'PROJECT_PERSISTENCE_ERROR',
    });
    await expect(repository.updateWorkspace(workspace(1), 'not json')).rejects.toMatchObject({
      code: 'PROJECT_PERSISTENCE_ERROR',
    });
  });

  it('tells current authorizations from earlier ones', async () => {
    await repository.insertWorkspace(workspace(1), '{}');
    expect(await repository.authorizationState(id(1), 'lint', 'a'.repeat(64))).toBe('none');
    await repository.authorize(id(1), 'lint', 'a'.repeat(64), 'now');
    await repository.authorize(id(1), 'lint', 'a'.repeat(64), 'later');
    expect(await repository.authorizationState(id(1), 'lint', 'a'.repeat(64))).toBe('current');
    expect(await repository.authorizationState(id(1), 'lint', 'b'.repeat(64))).toBe('other');
  });

  it('lists runs newest first with paging, closes interrupted runs and prunes old ones', async () => {
    await repository.insertWorkspace(workspace(1), '{}');
    for (let n = 1; n <= 4; n += 1) {
      await repository.insertRun(
        run(n, id(1), `2026-10-23T12:0${n}:00.000Z`, n === 4 ? 'RUNNING' : 'PASSED'),
      );
    }
    const page = await repository.listRuns(id(1), 2);
    expect(page.map((item) => item.id)).toEqual([id(104), id(103)]);
    expect(page[1]).toMatchObject({ counts: { PASSED: 1 } });
    expect((await repository.listRuns(id(1), 5, id(103))).map((item) => item.id)).toEqual([
      id(102),
      id(101),
    ]);

    expect(await repository.interruptRunning('2026-10-23T13:00:00.000Z')).toEqual([id(104)]);
    const interrupted = (await repository.findRun(id(104)))!;
    expect(interrupted).toMatchObject({ status: 'CANCELLED', requiredOutcome: 'INCOMPLETE' });
    expect(interrupted.results[0]).toMatchObject({
      status: 'CANCELLED',
      detail: 'The Engine stopped during the run.',
    });

    expect((await repository.pruneRuns(id(1), 2)).sort()).toEqual([id(101), id(102)]);
    expect((await repository.listRuns(id(1), 10)).map((item) => item.id)).toEqual([
      id(104),
      id(103),
    ]);
  });

  it('removes runs and authorizations with their workspace', async () => {
    await repository.insertWorkspace(workspace(1), '{}');
    await repository.authorize(id(1), 'lint', 'a'.repeat(64), 'now');
    await repository.insertRun(run(1, id(1), '2026-10-23T12:00:00.000Z', 'PASSED'));
    await repository.removeWorkspace(id(1));
    expect(await repository.findRun(id(101))).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM preflight_authorizations').get()).toEqual({
      n: 0,
    });
  });
});
