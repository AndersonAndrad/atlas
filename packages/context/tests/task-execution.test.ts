import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskExecution } from '@atlas/contracts';
import { TaskExecutionTracker, type TaskExecutionStore } from '../src/index.js';

const TERMINAL = '00000000-0000-4000-8000-000000000001';
const OTHER_TERMINAL = '00000000-0000-4000-8000-000000000002';
const TASK = '00000000-0000-4000-8000-0000000000a1';

/** In-memory store with the SQLite repository's semantics. */
class MemoryStore implements TaskExecutionStore {
  readonly rows = new Map<string, TaskExecution>();
  async insert(execution: TaskExecution) {
    if ([...this.rows.values()].some((row) => row.requestId === execution.requestId)) {
      throw new Error('UNIQUE constraint failed');
    }
    this.rows.set(execution.id, { ...execution });
  }
  async update(execution: TaskExecution) {
    this.rows.set(execution.id, { ...execution });
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async findByRequestId(requestId: string) {
    return [...this.rows.values()].find((row) => row.requestId === requestId) ?? null;
  }
  async listForTask(taskId: string, limit: number) {
    return [...this.rows.values()]
      .filter((row) => row.taskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  async listActive() {
    return [...this.rows.values()].filter((row) => ['LAUNCHING', 'RUNNING'].includes(row.status));
  }
  async listUnreviewedForTerminal(terminalId: string) {
    return [...this.rows.values()].filter(
      (row) =>
        row.terminalId === terminalId &&
        !['LAUNCHING', 'RUNNING'].includes(row.status) &&
        row.reviewedAt === null,
    );
  }
}

describe('TaskExecutionTracker (SDD-025 Task 02)', () => {
  let store: MemoryStore;
  let finished: TaskExecution[];
  let changes: TaskExecution[];
  let tracker: TaskExecutionTracker;
  let clock: number;
  let ids = 0;

  const create = (
    overrides: { terminalId?: string; tracked?: boolean; provider?: 'claude' | 'codex' } = {},
  ) =>
    tracker.create({
      id: `00000000-0000-4000-8000-00000000${String((ids += 1)).padStart(4, '0')}`,
      requestId: `00000000-0000-4000-9000-00000000${String(ids).padStart(4, '0')}`,
      taskId: TASK,
      projectId: '00000000-0000-4000-8000-0000000000b1',
      workspacePath: null,
      mode: 'new-terminal',
      provider: overrides.provider ?? 'claude',
      profileId: null,
      profileName: null,
      terminalId: overrides.terminalId ?? TERMINAL,
      terminalTitle: 'Claude Code · Task',
      aiSessionId: null,
      tracked: overrides.tracked ?? true,
    });
  const start = (run: string, terminalId = TERMINAL, provider: 'claude' | 'codex' = 'claude') =>
    tracker.aiStarted({ terminalId, provider, run });
  const end = (run: string, exitCode: number | null, terminalId = TERMINAL) =>
    tracker.aiEnded({ terminalId, provider: 'claude', run, exitCode });

  beforeEach(() => {
    store = new MemoryStore();
    finished = [];
    changes = [];
    clock = Date.parse('2026-10-27T12:00:00Z');
    tracker = new TaskExecutionTracker({
      store,
      now: () => new Date((clock += 1000)),
      onChange: (execution) => changes.push(execution),
      onFinished: async (execution) => {
        finished.push(execution);
      },
      launchTimeoutMs: 300,
    });
  });

  afterEach(() => {
    tracker.close();
    vi.useRealTimers();
  });

  it('runs from launching to review required on a successful end, and notifies once', async () => {
    const execution = await create();
    expect(execution.status).toBe('LAUNCHING');
    await start('run-1');
    expect((await tracker.get(execution.id)).status).toBe('RUNNING');
    expect((await tracker.get(execution.id)).runRef).toBe('run-1');
    await end('run-1', 0);
    await end('run-1', 1); // repeated or late events change nothing
    await start('run-1');
    const done = await tracker.get(execution.id);
    expect(done).toMatchObject({ status: 'REVIEW_REQUIRED', exitCode: 0, endReason: null });
    expect(done.endedAt).not.toBeNull();
    expect(finished.map((item) => item.status)).toEqual(['REVIEW_REQUIRED']);
    expect(changes.map((item) => item.status)).toEqual(['LAUNCHING', 'RUNNING', 'REVIEW_REQUIRED']);
  });

  it('records a failure with its exit code, also when the end arrives without a start', async () => {
    const failed = await create();
    await start('run-1');
    await end('run-1', 2);
    expect(await tracker.get(failed.id)).toMatchObject({
      status: 'FAILED',
      exitCode: 2,
      endReason: 'exit-code',
    });
    const missedStart = await create();
    await end('run-2', null);
    expect(await tracker.get(missedStart.id)).toMatchObject({
      status: 'FAILED',
      runRef: 'run-2',
      exitCode: null,
    });
    expect(finished).toHaveLength(2);
  });

  it('binds a start only to a launching execution of the same terminal and provider', async () => {
    const execution = await create();
    await start('other-terminal', OTHER_TERMINAL);
    await start('other-provider', TERMINAL, 'codex');
    expect((await tracker.get(execution.id)).status).toBe('LAUNCHING');
    await end('unrelated', 0, OTHER_TERMINAL);
    expect((await tracker.get(execution.id)).status).toBe('LAUNCHING');
  });

  it('becomes untracked when no start is reported in time, and ignores a late start', async () => {
    const execution = await create();
    await vi.waitFor(async () =>
      expect((await tracker.get(execution.id)).status).toBe('UNTRACKED'),
    );
    await start('late');
    await end('late', 0);
    expect((await tracker.get(execution.id)).status).toBe('UNTRACKED');
    expect(finished).toEqual([]);
  });

  it('starts untracked when the wrapper cannot report', async () => {
    const execution = await create({ tracked: false });
    expect(execution.status).toBe('UNTRACKED');
    await tracker.terminalEnded(TERMINAL);
    expect((await tracker.get(execution.id)).status).toBe('UNTRACKED');
  });

  it('interrupts active executions when their terminal ends', async () => {
    const running = await create();
    await start('run-1');
    const other = await create({ terminalId: OTHER_TERMINAL });
    await tracker.terminalEnded(TERMINAL);
    expect(await tracker.get(running.id)).toMatchObject({
      status: 'INTERRUPTED',
      endReason: 'terminal-ended',
    });
    expect((await tracker.get(other.id)).status).toBe('LAUNCHING');
    expect(finished.map((item) => item.id)).toEqual([running.id]);
  });

  it('cancels a launching execution at once and a running one when it ends, silently', async () => {
    const launching = await create();
    expect((await tracker.requestCancel(launching.id)).status).toBe('CANCELLED');

    const running = await create();
    await start('run-2');
    const pending = await tracker.requestCancel(running.id);
    expect(pending.status).toBe('RUNNING');
    expect(pending.cancelRequestedAt).not.toBeNull();
    await end('run-2', 0);
    expect(await tracker.get(running.id)).toMatchObject({
      status: 'CANCELLED',
      endReason: 'cancelled',
    });
    await expect(tracker.requestCancel(running.id)).rejects.toMatchObject({
      code: 'TASK_EXECUTION_INVALID_STATE',
    });
    expect(finished).toEqual([]);
  });

  it('records active executions as interrupted after a restart, without notifying', async () => {
    const execution = await create();
    await start('run-1');
    tracker.close();
    const restarted = new TaskExecutionTracker({
      store,
      now: () => new Date((clock += 1000)),
      onChange: () => undefined,
      onFinished: async (item) => {
        finished.push(item);
      },
    });
    await restarted.recover();
    expect(await restarted.get(execution.id)).toMatchObject({
      status: 'INTERRUPTED',
      endReason: 'engine-restart',
    });
    expect(finished).toEqual([]);
  });

  it('ignores terminal ends after shutdown: the next start records them', async () => {
    const execution = await create();
    tracker.close();
    await tracker.terminalEnded(TERMINAL);
    expect((await tracker.get(execution.id)).status).toBe('LAUNCHING');
  });

  it('reviews only finished executions, explicitly or through their terminal', async () => {
    const execution = await create();
    await expect(tracker.markReviewed(execution.id)).rejects.toMatchObject({
      code: 'TASK_EXECUTION_INVALID_STATE',
    });
    await start('run-1');
    await end('run-1', 0);
    const reviewed = await tracker.markReviewed(execution.id);
    expect(reviewed.reviewedAt).not.toBeNull();
    expect((await tracker.markReviewed(execution.id)).reviewedAt).toBe(reviewed.reviewedAt);

    const second = await create();
    await start('run-2');
    await end('run-2', 1);
    await tracker.markTerminalReviewed(TERMINAL);
    expect((await tracker.get(second.id)).reviewedAt).not.toBeNull();
    await expect(tracker.get('00000000-0000-4000-8000-00000000ffff')).rejects.toMatchObject({
      code: 'TASK_EXECUTION_NOT_FOUND',
    });
  });

  it('reports the active execution of a task and of a terminal', async () => {
    const execution = await create();
    expect((await tracker.activeForTask(TASK))?.id).toBe(execution.id);
    expect((await tracker.activeForTerminal(TERMINAL))?.id).toBe(execution.id);
    expect(await tracker.activeForTerminal(OTHER_TERMINAL)).toBeNull();
    await tracker.launchFailed(execution.id);
    expect(await tracker.get(execution.id)).toMatchObject({
      status: 'FAILED',
      endReason: 'launch-failed',
    });
    expect(await tracker.activeForTask(TASK)).toBeNull();
    expect(finished).toEqual([]);
  });
});
