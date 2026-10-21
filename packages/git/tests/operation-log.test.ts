import { describe, expect, it } from 'vitest';
import type { GitCommandRecord, GitOperation, GitOperationLogEntry } from '@atlas/contracts';
import {
  GIT_LOG_OPERATION_OUTPUT_BUDGET,
  GIT_LOG_OUTPUT_LIMIT,
  GIT_LOG_OUTPUT_MINIMUM,
  GIT_LOG_SETTINGS_KEY,
  GitCommandError,
  GitOperationCoordinator,
  GitOperationFailure,
  GitOperationLog,
  matchReflog,
  parseNameStatus,
  parseReflog,
  recordingExecutor,
  type GitExecutor,
  type GitOperationLogFilter,
  type GitOperationLogStore,
} from '../src/index.js';

/** In-memory store with the same semantics as the SQLite repository. */
class MemoryStore implements GitOperationLogStore {
  operations = new Map<string, GitOperation>();
  commands: GitCommandRecord[] = [];
  pruned: { before: string; keep: number }[] = [];
  failSaves = false;

  async saveOperation(operation: GitOperation) {
    if (this.failSaves) throw new Error('disk full');
    this.operations.set(operation.id, operation);
  }
  async saveCommand(record: GitCommandRecord) {
    this.commands.push(record);
  }
  private entry(operation: GitOperation): GitOperationLogEntry {
    return {
      ...operation,
      commandCount: this.commands.filter((c) => c.operationId === operation.id).length,
    };
  }
  async listOperations(filter: GitOperationLogFilter) {
    return [...this.operations.values()]
      .filter((o) => !filter.repositoryRoot || o.repositoryRoot === filter.repositoryRoot)
      .filter((o) => !filter.before || o.startedAt < filter.before)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, filter.limit)
      .map((o) => this.entry(o));
  }
  async getOperation(id: string) {
    const operation = this.operations.get(id);
    return operation ? this.entry(operation) : null;
  }
  async listCommands(operationId: string) {
    return this.commands.filter((c) => c.operationId === operationId);
  }
  async operationsBetween(root: string, from: string, to: string) {
    return [...this.operations.values()].filter(
      (o) =>
        o.repositoryRoot === root && o.startedAt <= to && (o.finishedAt ?? o.startedAt) >= from,
    );
  }
  async interruptUnfinished() {
    return 0;
  }
  async prune(before: string, keep: number) {
    this.pruned.push({ before, keep });
    return 0;
  }
}

const settingsStore = () => {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => void values.set(key, value),
  };
};

const ok = (stdout = '', stderr = '') => ({ stdout, stderr, exitCode: 0, truncated: false });

function setup(exec: GitExecutor) {
  const store = new MemoryStore();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 20, 12, 0, 0, (tick += 5)));
  const log = new GitOperationLog({ store, settings: settingsStore(), now });
  let next = 0;
  const coordinator = new GitOperationCoordinator({
    generateId: () => `00000000-0000-4000-8000-${String((next += 1)).padStart(12, '0')}`,
    journal: log,
    progressIntervalMs: 0,
    now,
  });
  const recorded = recordingExecutor(exec, coordinator, log, now);
  return { store, log, coordinator, recorded };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('operation log (PLAN-016)', () => {
  it('records the commands run inside an operation, and only those', async () => {
    const { store, coordinator, recorded } = setup(async (args) =>
      args[0] === 'status' ? ok('?? a\0?? b\0') : ok('[main abc] feat: x\n'),
    );
    await recorded(['status'], { cwd: '/repo', timeoutMs: 1000 }); // polling: not recorded
    const outcome = await coordinator.run(
      { repositoryRoot: '/repo', kind: 'commit', lanes: ['index'], cancellable: false },
      async () => {
        await recorded(['status', '--porcelain=v2', '-z'], { cwd: '/repo', timeoutMs: 1000 });
        await recorded(['commit', '-F', '-'], {
          cwd: '/repo',
          timeoutMs: 1000,
          input: 'feat: secret message body',
        });
        return { summary: 'Committed', value: null };
      },
    );
    await flush();
    expect(outcome.operation.status).toBe('succeeded');
    expect(store.commands.map((c) => [c.sequence, c.args[0], c.outcome])).toEqual([
      [1, 'status', 'succeeded'],
      [2, 'commit', 'succeeded'],
    ]);
    // NUL-separated porcelain output becomes lines; standard input is never stored.
    expect(store.commands[0]!.stdout).toBe('?? a\n?? b\n');
    expect(JSON.stringify(store.commands)).not.toContain('secret message body');
    expect(store.operations.get(outcome.operation.id)?.status).toBe('succeeded');
  });

  it('journals status changes, not progress, and survives journal failures', async () => {
    const statuses: string[] = [];
    let next = 0;
    const coordinator = new GitOperationCoordinator({
      generateId: () => `op-${(next += 1)}`,
      progressIntervalMs: 0,
      journal: { operationChanged: (operation) => statuses.push(operation.status) },
    });
    await coordinator.run(
      { repositoryRoot: '/repo', kind: 'fetch', lanes: ['remote'], cancellable: true },
      async ({ progress }) => {
        progress('Receiving objects:  50% (1/2)');
        progress('Receiving objects: 100% (2/2)');
        return { summary: 'Fetched', value: null };
      },
    );
    expect(statuses).toEqual(['queued', 'running', 'succeeded']);

    const failing = new GitOperationCoordinator({
      generateId: () => 'op-x',
      journal: {
        operationChanged: () => {
          throw new Error('disk full');
        },
      },
    });
    const outcome = await failing.run(
      { repositoryRoot: '/repo', kind: 'stage', lanes: ['index'], cancellable: false },
      async () => ({ summary: 'Staged', value: 1 }),
    );
    expect(outcome).toMatchObject({ value: 1, operation: { status: 'succeeded' } });
  });

  it('records failed and cancelled commands with sanitized output and arguments', async () => {
    const { store, coordinator, recorded } = setup(async (args) => {
      if (args[0] === 'push') {
        throw new GitCommandError('failed', 'git exited with 128', 128, {
          stdout: '',
          stderr: 'fatal: could not read from https://user:hunter2@example.com/repo.git',
        });
      }
      throw new GitCommandError('cancelled', 'cancelled');
    });
    await coordinator.run(
      { repositoryRoot: '/repo', kind: 'push', lanes: ['remote'], cancellable: true },
      async () => {
        try {
          await recorded(['push', 'https://user:hunter2@example.com/repo.git', 'main'], {
            cwd: '/repo',
            timeoutMs: 1000,
          });
        } catch {
          // expected
        }
        await recorded(['fetch'], { cwd: '/repo', timeoutMs: 1000 }).catch(() => undefined);
        throw new GitOperationFailure('rejected', 'Push was rejected.');
      },
    );
    await flush();
    const [push, fetch] = store.commands;
    expect(push).toMatchObject({ outcome: 'failed', exitCode: 128 });
    expect(JSON.stringify(push)).not.toContain('hunter2');
    expect(fetch).toMatchObject({ outcome: 'cancelled', exitCode: null });
    expect([...store.operations.values()][0]).toMatchObject({
      status: 'failed',
      error: { code: 'rejected' },
    });
  });

  it('keeps only the end of very long output and marks it truncated', async () => {
    const long = `${'line\n'.repeat(GIT_LOG_OUTPUT_LIMIT / 2)}last line\n`;
    const { store, coordinator, recorded } = setup(async () => ok(long));
    await coordinator.run(
      { repositoryRoot: '/repo', kind: 'stage', lanes: ['index'], cancellable: false },
      async () => {
        await recorded(['add', '--', 'a'], { cwd: '/repo', timeoutMs: 1000 });
        return { summary: 'Staged', value: null };
      },
    );
    await flush();
    const [command] = store.commands;
    expect(command!.truncated).toBe(true);
    expect(command!.stdout!.length).toBeLessThanOrEqual(GIT_LOG_OUTPUT_LIMIT);
    expect(command!.stdout!.endsWith('last line\n')).toBe(true);
  });

  it('bounds the output stored for one operation', async () => {
    const { store, coordinator, recorded } = setup(async () =>
      ok(`${'x'.repeat(99)}\n`.repeat(2000)),
    );
    await coordinator.run(
      { repositoryRoot: '/repo', kind: 'stage', lanes: ['index'], cancellable: false },
      async () => {
        for (let index = 0; index < 8; index += 1) {
          await recorded(['status'], { cwd: '/repo', timeoutMs: 1000 });
        }
        return { summary: 'Staged', value: null };
      },
    );
    await flush();
    const sizes = store.commands.map((command) => command.stdout!.length);
    expect(sizes[0]).toBeGreaterThan(60_000);
    expect(sizes.at(-1)).toBeLessThanOrEqual(GIT_LOG_OUTPUT_MINIMUM);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(
      GIT_LOG_OPERATION_OUTPUT_BUDGET + 2 * GIT_LOG_OUTPUT_MINIMUM * 8,
    );
    expect(store.commands.every((command) => command.truncated)).toBe(true);
  });

  it('pages operations, returns details and attributes reflog entries by time', async () => {
    const { log, store } = setup(async () => ok());
    for (let index = 0; index < 3; index += 1) {
      await store.saveOperation({
        id: `op-${index}`,
        kind: 'commit',
        repositoryRoot: '/repo',
        status: 'succeeded',
        startedAt: `2026-10-20T12:0${index}:00.000Z`,
        finishedAt: `2026-10-20T12:0${index}:02.000Z`,
        progress: null,
        summary: null,
        error: null,
        cancellable: false,
        steps: null,
      });
    }
    const first = await log.list({ repositoryRoot: '/repo', limit: 2 });
    expect(first.operations.map((o) => o.id)).toEqual(['op-2', 'op-1']);
    expect(first.nextBefore).toBe('2026-10-20T12:01:00.000Z');
    const second = await log.list({ repositoryRoot: '/repo', limit: 2, before: first.nextBefore! });
    expect(second).toMatchObject({ operations: [{ id: 'op-0' }], nextBefore: null });
    await expect(log.details('missing')).rejects.toMatchObject({ code: 'GIT_OPERATION_NOT_FOUND' });

    const entries = await log.attribute('/repo', [
      {
        index: 0,
        hash: 'a',
        action: 'commit',
        message: 'x',
        date: '2026-10-20T12:02:01.000Z',
        identity: 'Ana',
        commitSubject: '',
      },
      {
        index: 1,
        hash: 'b',
        action: 'checkout',
        message: 'y',
        date: '2026-10-20T12:05:00.000Z',
        identity: 'Ana',
        commitSubject: '',
      },
      {
        index: 2,
        hash: 'c',
        action: 'reset',
        message: 'z',
        date: null,
        identity: 'Ana',
        commitSubject: '',
      },
    ]);
    expect(entries.map((entry) => entry.atlasOperationId)).toEqual(['op-2', null, null]);

    // A commit made in a terminal while ATLAS was only staging is not attributed to it.
    await store.saveOperation({
      ...(await store.getOperation('op-0'))!,
      id: 'op-stage',
      kind: 'stage',
      startedAt: '2026-10-20T12:10:00.000Z',
      finishedAt: '2026-10-20T12:10:02.000Z',
    });
    const [terminal] = await log.attribute('/repo', [
      {
        index: 0,
        hash: 'd',
        action: 'commit',
        message: 'from a terminal',
        date: '2026-10-20T12:10:01.000Z',
        identity: 'Ana',
        commitSubject: '',
      },
    ]);
    expect(terminal!.atlasOperationId).toBeNull();
  });

  it('stores retention settings, prunes with them and closes unfinished runs on start', async () => {
    const store = new MemoryStore();
    const settings = settingsStore();
    const log = new GitOperationLog({
      store,
      settings,
      now: () => new Date('2026-10-20T00:00:00.000Z'),
    });
    expect(await log.settings()).toEqual({ retentionDays: 90, maxOperations: 5000 });
    await log.start();
    expect(store.pruned.at(-1)).toEqual({ before: '2026-07-22T00:00:00.000Z', keep: 5000 });
    expect(await log.updateSettings({ retentionDays: 7 })).toEqual({
      retentionDays: 7,
      maxOperations: 5000,
    });
    expect(store.pruned.at(-1)).toEqual({ before: '2026-10-13T00:00:00.000Z', keep: 5000 });
    await expect(log.updateSettings({ maxOperations: 5 })).rejects.toThrow();
    settings.values.set(GIT_LOG_SETTINGS_KEY, 'not json');
    expect(await log.settings()).toEqual({ retentionDays: 90, maxOperations: 5000 });
  });

  it('parses the reflog and removes credentials from its subjects', () => {
    const line = (hash: string, date: string, subject: string) =>
      [hash, `HEAD@{${date}}`, subject, 'Ana'].join('\x1f');
    const entries = parseReflog(
      [
        line('a'.repeat(40), '2026-10-20T19:41:37-03:00', 'checkout: moving from feat to main'),
        line(
          'b'.repeat(40),
          '2026-10-20T19:40:00-03:00',
          'pull https://user:hunter2@example.com/r.git: Fast-forward',
        ),
        line('c'.repeat(40), 'not a date', 'commit (initial): first'),
        '',
      ].join('\n'),
    );
    expect(entries.map((entry) => [entry.index, entry.action, entry.date])).toEqual([
      [0, 'checkout', '2026-10-20T22:41:37.000Z'],
      [1, expect.not.stringContaining('hunter2'), '2026-10-20T22:40:00.000Z'],
      [2, 'commit (initial)', null],
    ]);
    expect(entries[0]!.message).toBe('moving from feat to main');
    expect(JSON.stringify(entries)).not.toContain('hunter2');
  });

  it('searches reflog entries by message, commit subject and hash prefix (PLAN-022)', () => {
    const entry = (hash: string, action: string, message: string, commitSubject: string) => ({
      index: 0,
      hash,
      action,
      message,
      date: null,
      identity: 'Ana',
      commitSubject,
    });
    const entries = [
      entry('abcd1234'.repeat(5), 'commit', 'feat: Login form', 'feat: Login form'),
      entry('ef015678'.repeat(5), 'checkout', 'moving from main to feat', 'fix: header'),
      entry('99990000'.repeat(5), 'reset', 'moving to HEAD~1', 'chore: init'),
    ];
    expect(matchReflog(entries, 'LOGIN').map((e) => e.action)).toEqual(['commit']);
    // A checkout is found by the subject of the commit it moved to.
    expect(matchReflog(entries, 'header').map((e) => e.action)).toEqual(['checkout']);
    expect(matchReflog(entries, 'ef01').map((e) => e.action)).toEqual(['checkout']);
    // Short hex text is matched as text only.
    expect(matchReflog(entries, 'abc')).toEqual([]);
    expect(matchReflog(entries, 'reset: moving')).toHaveLength(1);
    expect(matchReflog(entries, '  ')).toHaveLength(3);
  });

  it('parses name-status output with renames and spaces (PLAN-022)', () => {
    expect(
      parseNameStatus(
        [
          'M',
          'src/a b.ts',
          'R087',
          'old.ts',
          'new.ts',
          'A',
          'img.png',
          'D',
          'gone.ts',
          'T',
          'link',
          '',
        ].join('\0'),
      ),
    ).toEqual([
      { path: 'src/a b.ts', originalPath: null, change: 'modified' },
      { path: 'new.ts', originalPath: 'old.ts', change: 'renamed' },
      { path: 'img.png', originalPath: null, change: 'added' },
      { path: 'gone.ts', originalPath: null, change: 'deleted' },
      { path: 'link', originalPath: null, change: 'type-changed' },
    ]);
    expect(parseNameStatus('')).toEqual([]);
  });
});
