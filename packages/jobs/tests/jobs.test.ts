import type {
  BackgroundJob,
  JobAttempt,
  JobOutputPage,
  JobPayload,
  JobStatus,
  JobStatusChange,
} from '@atlas/contracts';
import {
  JOB_TRANSITIONS,
  JobService,
  canTransition,
  selectJobsToStart,
  type CreateJobRequest,
  type JobExecutionContext,
  type JobExecutionResult,
  type JobExecutor,
  type JobRecord,
  type JobRepository,
  type KeyValueStore,
} from '@atlas/jobs';
import { AtlasError, noopLogger } from '@atlas/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT_A = id(901);
const PROJECT_B = id(902);

/** In-memory repository with the same semantics as the SQLite one. */
class MemoryRepository implements JobRepository {
  jobs = new Map<string, JobRecord>();
  changes: JobStatusChange[] = [];
  attemptRows = new Map<string, JobAttempt>();
  saves = 0;
  failSaves = false;
  async insert(job: JobRecord, change: JobStatusChange) {
    this.jobs.set(job.id, structuredClone(job));
    this.changes.push(change);
  }
  async save(job: JobRecord, change: JobStatusChange | null, attempt: JobAttempt | null) {
    this.saves += 1;
    if (this.failSaves) throw new Error('disk full');
    if (!this.jobs.has(job.id)) return;
    this.jobs.set(job.id, structuredClone(job));
    if (change !== null) this.changes.push(change);
    if (attempt !== null)
      this.attemptRows.set(`${attempt.jobId}:${attempt.attempt}`, { ...attempt });
  }
  async find(target: string) {
    return structuredClone(this.jobs.get(target) ?? null);
  }
  async list(query: { statuses?: readonly JobStatus[]; projectId?: string; limit: number }) {
    return [...this.jobs.values()]
      .reverse()
      .filter((job) => !query.statuses || query.statuses.includes(job.status))
      .filter((job) => !query.projectId || job.projectId === query.projectId)
      .slice(0, query.limit);
  }
  async attempts(jobId: string) {
    return [...this.attemptRows.values()].filter((attempt) => attempt.jobId === jobId);
  }
  async history(jobId: string) {
    return this.changes.filter((change) => change.jobId === jobId);
  }
  async interruptUnfinished(at: string, detail: string) {
    const changed: JobRecord[] = [];
    for (const job of this.jobs.values()) {
      if (!['QUEUED', 'RUNNING', 'WAITING_APPROVAL'].includes(job.status)) continue;
      Object.assign(job, { status: 'INTERRUPTED', finishedAt: at, errorSummary: detail });
      this.changes.push({ jobId: job.id, status: 'INTERRUPTED', at, detail });
      changed.push(structuredClone(job));
    }
    return changed;
  }
  pruned: number[] = [];
  async prune(keep: number) {
    this.pruned.push(keep);
    return [];
  }
}

class MemorySettings implements KeyValueStore {
  values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
}

interface Execution {
  context: JobExecutionContext;
  resolve(result: JobExecutionResult): void;
  reject(error: unknown): void;
}

/** Runs nothing: each execution waits until the test settles it. */
class FakeExecutor implements JobExecutor {
  readonly type = 'COMMAND' as const;
  notifiesOutcome = false;
  executions: Execution[] = [];
  ready = true;
  resource: ((job: JobRecord) => string | null) | null = null;
  constructor(public cancellable = true) {}
  async prepare(request: CreateJobRequest) {
    if (request.type !== 'COMMAND') throw new AtlasError('VALIDATION_FAILED');
    return {
      title: request.command,
      description: null,
      projectId: request.projectId,
      workspacePath: `/work/${request.projectId}`,
      payload: {
        type: 'COMMAND',
        command: request.command,
        timeoutMinutes: request.timeoutMinutes,
        confirmedDangerous: false,
      } satisfies JobPayload,
    };
  }
  execute(context: JobExecutionContext) {
    return new Promise<JobExecutionResult>((resolve, reject) => {
      const execution = { context, resolve, reject };
      this.executions.push(execution);
      if (this.cancellable) {
        context.signal.addEventListener('abort', () =>
          resolve({ status: 'CANCELLED', errorSummary: 'The command was stopped.' }),
        );
      }
    });
  }
  resourceKey(job: JobRecord) {
    return this.resource?.(job) ?? null;
  }
  isReady() {
    return this.ready;
  }
  retryPayload(payload: JobPayload): JobPayload {
    return payload.type === 'COMMAND'
      ? { ...payload, command: `${payload.command} (retry)` }
      : payload;
  }
  async output(): Promise<JobOutputPage> {
    return { lines: [], next: -1, complete: true, truncatedBefore: false };
  }
  /** The execution of a job, by command. */
  of(command: string) {
    const found = this.executions.find(
      (execution) =>
        execution.context.job.payload.type === 'COMMAND' &&
        execution.context.job.payload.command.startsWith(command),
    );
    if (found === undefined) throw new Error(`${command} is not running`);
    return found;
  }
}

function setup(options: { executor?: FakeExecutor; progressIntervalMs?: number } = {}) {
  const repository = new MemoryRepository();
  const settings = new MemorySettings();
  const executor = options.executor ?? new FakeExecutor();
  let next = 0;
  let clock = Date.parse('2026-10-26T12:00:00.000Z');
  const service = new JobService({
    repository,
    executors: [executor],
    settings,
    clock: { now: () => new Date((clock += 1000)) },
    generateId: () => id(++next),
    logger: noopLogger,
    ...(options.progressIntervalMs === undefined
      ? {}
      : { progressIntervalMs: options.progressIntervalMs }),
  });
  const events: BackgroundJob[] = [];
  const finished: BackgroundJob[] = [];
  service.subscribe((job) => events.push(job));
  service.onFinished((job) => finished.push(job));
  const create = (command: string, extra: Record<string, unknown> = {}) =>
    service.create({ type: 'COMMAND', projectId: PROJECT_A, command, ...extra }, 'desktop');
  return { repository, settings, executor, service, events, finished, create };
}

/** Lets pending promise callbacks (saves, dispatches) run. */
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

afterEach(() => {
  vi.useRealTimers();
});

describe('job state machine', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('QUEUED', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'COMPLETED')).toBe(true);
    expect(canTransition('FAILED', 'QUEUED')).toBe(true);
    expect(canTransition('COMPLETED', 'QUEUED')).toBe(false);
    expect(canTransition('QUEUED', 'COMPLETED')).toBe(false);
    expect(canTransition('CANCELLED', 'RUNNING')).toBe(false);
    expect(JOB_TRANSITIONS.COMPLETED).toEqual([]);
  });
});

describe('queue selection', () => {
  const limits = { maxConcurrentJobs: 2, maxJobsPerProject: 1 };
  const job = (
    n: number,
    extra: Partial<Parameters<typeof selectJobsToStart>[0][number]> = {},
  ) => ({
    id: `j${n}`,
    priority: 'NORMAL' as const,
    projectId: null,
    resource: null,
    ready: true,
    ...extra,
  });

  it('starts in queue order, higher priorities first, within the global limit', () => {
    expect(selectJobsToStart([job(1), job(2), job(3)], [], limits)).toEqual(['j1', 'j2']);
    expect(
      selectJobsToStart([job(1, { priority: 'LOW' }), job(2), job(3, { priority: 'HIGH' })], [], {
        ...limits,
        maxConcurrentJobs: 3,
      }),
    ).toEqual(['j3', 'j2', 'j1']);
    expect(selectJobsToStart([job(1)], [{ projectId: null, resource: null }], limits)).toEqual([
      'j1',
    ]);
    expect(
      selectJobsToStart(
        [job(1)],
        [
          { projectId: null, resource: null },
          { projectId: null, resource: null },
        ],
        limits,
      ),
    ).toEqual([]);
  });

  it('passes over jobs of a busy project, a busy resource or that are not ready', () => {
    expect(
      selectJobsToStart(
        [job(1, { projectId: 'a' }), job(2, { projectId: 'a' }), job(3, { projectId: 'b' })],
        [],
        limits,
      ),
    ).toEqual(['j1', 'j3']);
    expect(
      selectJobsToStart([job(1, { resource: 'w' }), job(2, { resource: 'w' }), job(3)], [], limits),
    ).toEqual(['j1', 'j3']);
    expect(selectJobsToStart([job(1, { ready: false }), job(2)], [], limits)).toEqual(['j2']);
    expect(
      selectJobsToStart([job(1, { projectId: 'a' })], [{ projectId: 'a', resource: null }], limits),
    ).toEqual([]);
  });
});

describe('JobService (SDD-012 Milestone A)', () => {
  it('saves a queued job before it runs, then records the attempt and the outcome', async () => {
    const { service, repository, executor, events, finished, create } = setup();
    const job = await create('npm test');
    expect(job).toMatchObject({ status: 'QUEUED', title: 'npm test', origin: 'desktop' });
    expect(repository.changes[0]).toMatchObject({ status: 'QUEUED', detail: 'Queued' });
    await flush();
    expect(executor.executions).toHaveLength(1);
    expect((await repository.find(job.id))?.status).toBe('RUNNING');
    executor.of('npm test').resolve({ status: 'COMPLETED', exitCode: 0 });
    await flush();
    const details = await service.get(job.id);
    expect(details.job).toMatchObject({ status: 'COMPLETED', exitCode: 0, errorSummary: null });
    expect(details.history.map((change) => change.status)).toEqual([
      'QUEUED',
      'RUNNING',
      'COMPLETED',
    ]);
    expect(details.attempts).toEqual([
      expect.objectContaining({ attempt: 1, status: 'COMPLETED', exitCode: 0 }),
    ]);
    expect(events.map((event) => event.status)).toEqual(['QUEUED', 'RUNNING', 'COMPLETED']);
    expect(finished.map((item) => item.status)).toEqual(['COMPLETED']);
    expect(repository.pruned).toEqual([500]);
  });

  it('validates input and never fabricates a success for a failing executor', async () => {
    const { service, executor, create } = setup();
    await expect(create('')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.create({ type: 'COMMAND', projectId: 'x', command: 'ls' }, 'desktop'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const job = await create('make');
    await flush();
    executor.of('make').reject(new Error('/secret/path exploded'));
    await flush();
    expect((await service.get(job.id)).job).toMatchObject({
      status: 'FAILED',
      errorSummary: 'The job could not run.',
    });
    const other = await create('lint');
    await flush();
    executor.of('lint').reject(new AtlasError('PREFLIGHT_BUSY'));
    await flush();
    expect((await service.get(other.id)).job.errorSummary).toBe(
      'A Preflight run is already in progress for this workspace.',
    );
  });

  it('keeps jobs queued beyond the limits and starts the next when one finishes (Scenario D)', async () => {
    const { service, executor, create } = setup();
    await service.updateSettings({ maxConcurrentJobs: 2, maxJobsPerProject: 2 });
    await create('one');
    await create('two');
    const third = await create('three');
    await flush();
    expect(executor.executions).toHaveLength(2);
    expect(service.summary()).toEqual({ running: 2, queued: 1, waitingApproval: 0 });
    expect((await service.get(third.id)).job.status).toBe('QUEUED');
    executor.of('one').resolve({ status: 'COMPLETED' });
    await flush();
    expect(executor.executions).toHaveLength(3);
    expect(executor.of('three').context.job.id).toBe(third.id);
    // No job ran twice.
    expect(new Set(executor.executions.map((e) => e.context.job.id)).size).toBe(3);
  });

  it('limits jobs per project without blocking other projects', async () => {
    const { service, executor } = setup();
    await service.create({ type: 'COMMAND', projectId: PROJECT_A, command: 'a1' }, 'desktop');
    await service.create({ type: 'COMMAND', projectId: PROJECT_A, command: 'a2' }, 'desktop');
    await service.create({ type: 'COMMAND', projectId: PROJECT_B, command: 'b1' }, 'desktop');
    await flush();
    expect(executor.executions.map((e) => e.context.job.title)).toEqual(['a1', 'b1']);
  });

  it('starts higher priorities first', async () => {
    const { service, executor, create } = setup();
    await service.updateSettings({ maxConcurrentJobs: 1 });
    await create('blocker');
    await flush();
    await create('low', { priority: 'LOW' });
    await create('normal');
    await create('high', { priority: 'HIGH' });
    executor.of('blocker').resolve({ status: 'COMPLETED' });
    await flush();
    expect(executor.executions.at(-1)?.context.job.title).toBe('high');
  });

  it('never dispatches the same job twice when many are created at once', async () => {
    const { service, executor, create } = setup();
    await service.updateSettings({ maxConcurrentJobs: 8, maxJobsPerProject: 8 });
    await Promise.all(Array.from({ length: 12 }, (_, n) => create(`job-${n}`)));
    await flush();
    const ids = executor.executions.map((execution) => execution.context.job.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(service.summary().queued).toBe(4);
  });

  it('waits for a busy resource or an executor that is not ready', async () => {
    const executor = new FakeExecutor();
    executor.resource = () => 'preflight:w1';
    const { service, create } = setup({ executor });
    await service.updateSettings({ maxConcurrentJobs: 4, maxJobsPerProject: 4 });
    await create('first');
    await create('second');
    await flush();
    expect(executor.executions).toHaveLength(1);
    executor.ready = false;
    executor.of('first').resolve({ status: 'COMPLETED' });
    await flush();
    expect(executor.executions).toHaveLength(1);
    executor.ready = true;
    service.resourceReleased();
    await flush();
    expect(executor.executions).toHaveLength(2);
  });

  it('cancels queued jobs at once and running ones only when the executor stops (FR-1207)', async () => {
    const { service, executor, create } = setup();
    await service.updateSettings({ maxConcurrentJobs: 1 });
    const running = await create('sleep 100');
    const queued = await create('echo later');
    await flush();
    expect(await service.cancel(queued.id)).toMatchObject({ status: 'CANCELLED' });
    const asked = await service.cancel(running.id);
    expect(asked).toMatchObject({ status: 'RUNNING', cancelRequested: true });
    expect(asked.capabilities.cancel).toBe(false);
    await flush();
    const details = await service.get(running.id);
    expect(details.job.status).toBe('CANCELLED');
    expect(details.history.at(-1)).toMatchObject({ detail: 'Cancelled by the user' });
    await expect(service.cancel(running.id)).rejects.toMatchObject({
      code: 'JOB_TRANSITION_INVALID',
    });
    await expect(service.cancel(id(999))).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    // The cancelled queued job never ran.
    expect(executor.executions).toHaveLength(1);
  });

  it('refuses to cancel what cannot be stopped safely', async () => {
    const executor = new FakeExecutor(false);
    const { service, create } = setup({ executor });
    const job = await create('git push');
    await flush();
    expect(job.capabilities.cancel).toBe(true);
    expect((await service.get(job.id)).job.capabilities.cancel).toBe(false);
    await expect(service.cancel(job.id)).rejects.toMatchObject({ code: 'JOB_NOT_CANCELLABLE' });
    executor.of('git push').resolve({ status: 'COMPLETED' });
    await flush();
    expect((await service.get(job.id)).job.status).toBe('COMPLETED');
  });

  it('reports a cancellation that did not stop the work truthfully', async () => {
    const executor = new FakeExecutor();
    executor.execute = (context) =>
      new Promise((resolve) => {
        executor.executions.push({ context, resolve, reject: () => undefined });
      });
    const { service, create } = setup({ executor });
    const job = await create('stubborn');
    await flush();
    await service.cancel(job.id);
    executor.of('stubborn').resolve({ status: 'COMPLETED', exitCode: 0 });
    await flush();
    expect((await service.get(job.id)).job.status).toBe('COMPLETED');
  });

  it('retries finished jobs manually as a new attempt with the executor retry payload', async () => {
    const { service, executor, create } = setup();
    const job = await create('flaky');
    await flush();
    executor.of('flaky').resolve({ status: 'FAILED', exitCode: 1, errorSummary: 'exit 1' });
    await flush();
    const retried = await service.retry(job.id);
    expect(retried).toMatchObject({
      status: 'QUEUED',
      retryCount: 1,
      errorSummary: null,
      exitCode: null,
      payload: { command: 'flaky (retry)' },
    });
    await expect(service.retry(job.id)).rejects.toMatchObject({ code: 'JOB_TRANSITION_INVALID' });
    await flush();
    expect(executor.executions.at(-1)?.context.attempt).toBe(2);
    executor.executions.at(-1)!.resolve({ status: 'COMPLETED' });
    await flush();
    const details = await service.get(job.id);
    expect(details.attempts.map((attempt) => [attempt.attempt, attempt.status])).toEqual([
      [1, 'FAILED'],
      [2, 'COMPLETED'],
    ]);
    await expect(service.retry(job.id)).rejects.toMatchObject({ code: 'JOB_TRANSITION_INVALID' });
  });

  it('accepts only one of two simultaneous retries', async () => {
    const { service, executor, create } = setup();
    const job = await create('twice');
    await flush();
    executor.of('twice').resolve({ status: 'FAILED' });
    await flush();
    const results = await Promise.allSettled([service.retry(job.id), service.retry(job.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('rate-limits progress writes and events (FR-1208)', async () => {
    vi.useFakeTimers();
    const { service, repository, executor, events, create } = setup({ progressIntervalMs: 1000 });
    const job = await create('build');
    await vi.advanceTimersByTimeAsync(0);
    const execution = executor.of('build');
    const savesBefore = repository.saves;
    const eventsBefore = events.length;
    for (let n = 1; n <= 50; n += 1) {
      execution.context.progress({ percent: n * 2, stage: `step\n${n}` });
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(repository.saves - savesBefore).toBe(1);
    expect(events.length - eventsBefore).toBe(1);
    expect(events.at(-1)?.progress).toMatchObject({ percent: 100, stage: 'step 50' });
    execution.context.progress({ percent: 250 });
    execution.context.progress({ percent: Number.NaN });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await service.get(job.id)).job.progress.percent).toBeNull();
    execution.resolve({ status: 'COMPLETED' });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('saves the execution reference at once', async () => {
    const { service, repository, executor, create } = setup();
    const job = await create('preflight');
    await flush();
    const reference = { type: 'preflight-run' as const, workspaceId: id(70), runId: id(71) };
    executor.of('preflight').context.reference(reference);
    await flush();
    expect((await repository.find(job.id))?.executionReference).toEqual(reference);
    executor.of('preflight').resolve({ status: 'COMPLETED' });
    await flush();
    expect((await service.get(job.id)).attempts[0]?.executionReference).toEqual(reference);
  });

  it('fails a job whose RUNNING state cannot be saved instead of running it', async () => {
    const { service, repository, executor, create } = setup();
    repository.failSaves = true;
    const job = await create('unsaved');
    await flush();
    expect(executor.executions).toHaveLength(0);
    repository.failSaves = false;
    expect((await service.get(job.id)).job.status).toBe('QUEUED');
    // The in-memory job is final; the repository missed it while failing.
    expect(service.summary()).toEqual({ running: 0, queued: 0, waitingApproval: 0 });
  });

  it('interrupts queued and running jobs on shutdown (Engine lifetime)', async () => {
    const { service, executor, finished, create } = setup();
    await service.updateSettings({ maxConcurrentJobs: 1 });
    const running = await create('long');
    const queued = await create('waiting');
    await flush();
    await service.close();
    expect((await service.get(running.id)).job).toMatchObject({
      status: 'INTERRUPTED',
      errorSummary: 'ATLAS quit while the job was running.',
    });
    expect((await service.get(queued.id)).job).toMatchObject({
      status: 'INTERRUPTED',
      errorSummary: 'ATLAS quit before the job started.',
    });
    expect(executor.executions).toHaveLength(1);
    expect(finished.map((job) => job.status)).toContain('INTERRUPTED');
    await expect(create('after')).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });

  it('reports jobs of a stopped Engine as interrupted and restarts nothing (Scenario C)', async () => {
    const first = setup();
    const job = await first.create('deploy-like');
    await flush();
    const second = new JobService({
      repository: first.repository,
      executors: [new FakeExecutor()],
      settings: first.settings,
      clock: { now: () => new Date('2026-10-26T13:00:00.000Z') },
      generateId: () => id(500),
      logger: noopLogger,
    });
    const notified: BackgroundJob[] = [];
    second.onFinished((item) => notified.push(item));
    const interrupted = await second.recover();
    expect(interrupted.map((item) => [item.id, item.status])).toEqual([[job.id, 'INTERRUPTED']]);
    expect(interrupted[0]?.capabilities.retry).toBe(true);
    expect(notified).toHaveLength(1);
    expect(second.summary()).toEqual({ running: 0, queued: 0, waitingApproval: 0 });
  });

  it('notifies interrupted jobs even when their executor reports its own outcomes', async () => {
    const executor = new FakeExecutor();
    executor.notifiesOutcome = true;
    const { service, finished, create } = setup({ executor });
    await create('own');
    await flush();
    executor.of('own').resolve({ status: 'FAILED' });
    await flush();
    expect(finished).toHaveLength(0);
    await create('cut');
    await flush();
    await service.close();
    expect(finished.map((job) => job.status)).toEqual(['INTERRUPTED']);
  });

  it('lists newest first with paging and filters', async () => {
    const { service, create } = setup();
    await service.updateSettings({ maxConcurrentJobs: 1, maxJobsPerProject: 1 });
    const a = await create('a');
    const b = await create('b');
    const c = await create('c');
    const page = await service.list({ limit: 2 });
    expect(page.jobs.map((job) => job.id)).toEqual([c.id, b.id]);
    expect(page.nextBefore).toBe(b.id);
    expect((await service.list({ statuses: ['QUEUED'] })).jobs.map((job) => job.id)).toEqual([
      c.id,
      b.id,
    ]);
    expect((await service.list({ projectId: PROJECT_B })).jobs).toEqual([]);
    await expect(service.list({ before: id(777) })).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
    expect(a.id).toBeDefined();
  });

  it('keeps settings valid and falls back to defaults for a broken stored value', async () => {
    const { service, settings } = setup();
    settings.values.set('jobs.settings', '{"maxConcurrentJobs": 99}');
    expect(await service.settings()).toEqual({ maxConcurrentJobs: 2, maxJobsPerProject: 1 });
    await expect(service.updateSettings({})).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.updateSettings({ maxConcurrentJobs: 0 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await service.updateSettings({ maxJobsPerProject: 3 })).toEqual({
      maxConcurrentJobs: 2,
      maxJobsPerProject: 3,
    });
  });

  it('refuses jobs where no executor runs them (e.g. the CLI)', async () => {
    const repository = new MemoryRepository();
    const service = new JobService({
      repository,
      settings: new MemorySettings(),
      clock: { now: () => new Date() },
      generateId: () => id(1),
      logger: noopLogger,
    });
    await expect(
      service.create({ type: 'COMMAND', projectId: PROJECT_A, command: 'ls' }, 'cli'),
    ).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    expect((await service.list({})).jobs).toEqual([]);
  });

  it('offers logs only for executors that keep them', async () => {
    const { service, executor, create } = setup();
    const job = await create('logged');
    await flush();
    expect((await service.get(job.id)).job.capabilities.logs).toBe(true);
    expect(await service.output({ jobId: job.id, after: -1 })).toMatchObject({ complete: true });
    executor.of('logged').resolve({ status: 'COMPLETED' });
  });
});
