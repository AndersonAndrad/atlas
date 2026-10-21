import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitCommandRecord, GitOperation } from '@atlas/contracts';
import { SqliteGitOperationLogRepository, openDatabase, type Database } from '../src/index.js';

const operation = (index: number, overrides: Partial<GitOperation> = {}): GitOperation => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  kind: 'commit',
  repositoryRoot: '/repo',
  status: 'succeeded',
  startedAt: `2026-10-${String(10 + index).padStart(2, '0')}T12:00:00.000Z`,
  finishedAt: `2026-10-${String(10 + index).padStart(2, '0')}T12:00:05.000Z`,
  progress: { phase: 'Writing', percent: 50 },
  summary: 'Committed',
  error: null,
  cancellable: false,
  steps: null,
  ...overrides,
});

const command = (operationId: string, sequence: number): GitCommandRecord => ({
  operationId,
  sequence,
  args: ['--literal-pathspecs', 'commit', '-F', '-'],
  startedAt: '2026-10-11T12:00:01.000Z',
  durationMs: 12,
  exitCode: 0,
  outcome: 'succeeded',
  stdout: '[main abc] feat: x',
  stderr: null,
  truncated: false,
});

describe('SqliteGitOperationLogRepository', () => {
  let db: Database;
  let repo: SqliteGitOperationLogRepository;
  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    repo = new SqliteGitOperationLogRepository(db);
  });
  afterEach(() => db.close());

  it('upserts operations, stores commands and filters newest first', async () => {
    const first = operation(1, { status: 'running', finishedAt: null, summary: null });
    await repo.saveOperation(first);
    await repo.saveCommand(command(first.id, 1));
    await repo.saveCommand(command(first.id, 2));
    await repo.saveOperation({
      ...first,
      status: 'failed',
      finishedAt: '2026-10-11T12:00:09.000Z',
      error: { code: 'hook-or-command-failed', message: 'Hook failed', output: 'boom' },
      steps: [
        {
          name: 'lint',
          command: 'pnpm lint',
          mode: 'start',
          status: 'failed',
          durationMs: 5,
          exitCode: 1,
          detail: 'exited with code 1',
          output: 'error',
        },
      ],
    });
    await repo.saveOperation(operation(2, { kind: 'push', repositoryRoot: '/other' }));

    const stored = await repo.getOperation(first.id);
    expect(stored).toMatchObject({
      status: 'failed',
      commandCount: 2,
      progress: null,
      error: { code: 'hook-or-command-failed' },
      steps: [{ name: 'lint', status: 'failed' }],
    });
    expect((await repo.listCommands(first.id)).map((c) => c.sequence)).toEqual([1, 2]);
    expect((await repo.listOperations({ limit: 10 })).map((o) => o.kind)).toEqual([
      'push',
      'commit',
    ]);
    expect(
      await repo.listOperations({ repositoryRoot: '/repo', status: 'failed', limit: 10 }),
    ).toHaveLength(1);
    expect(
      await repo.listOperations({ kind: 'push', before: '2026-10-12T00:00:00Z', limit: 10 }),
    ).toEqual([]);
    expect(
      (await repo.operationsBetween('/repo', '2026-10-11T12:00:03Z', '2026-10-11T12:00:04Z')).map(
        (o) => o.id,
      ),
    ).toEqual([first.id]);
  });

  it('closes unfinished operations and prunes by age and count with their commands', async () => {
    for (let index = 1; index <= 5; index += 1) {
      await repo.saveOperation(operation(index));
      await repo.saveCommand(command(operation(index).id, 1));
    }
    await repo.saveOperation(operation(6, { status: 'running', finishedAt: null }));
    expect(await repo.interruptUnfinished('2026-10-20T00:00:00.000Z')).toBe(1);
    expect(await repo.getOperation(operation(6).id)).toMatchObject({
      status: 'cancelled',
      summary: 'ATLAS stopped before the operation finished.',
    });

    // Older than the 13th: operations 1 and 2; then keep the newest 2 of the rest.
    expect(await repo.prune('2026-10-13T00:00:00.000Z', 2)).toBe(4);
    expect((await repo.listOperations({ limit: 10 })).map((o) => o.id)).toEqual([
      operation(6).id,
      operation(5).id,
    ]);
    const orphans = db.prepare('SELECT COUNT(*) AS n FROM git_command_log').get() as { n: number };
    expect(orphans.n).toBe(1);
  });
});
