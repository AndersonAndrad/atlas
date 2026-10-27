import {
  CreateJobSchema,
  JOB_ERROR_MAX,
  JOB_MAX_STORED,
  JOB_MESSAGE_MAX,
  JOB_STAGE_MAX,
  JobListQuerySchema,
  JobOutputQuerySchema,
  JobSettingsSchema,
  RETRYABLE_JOB_STATUSES,
  UpdateJobSettingsSchema,
  isFinalJobStatus,
  parseInput,
  type BackgroundJob,
  type JobAttempt,
  type JobDetails,
  type JobExecutionReference,
  type JobOrigin,
  type JobOutputPage,
  type JobPage,
  type JobProgress,
  type JobSettings,
  type JobStatus,
  type JobStatusChange,
  type JobSummary,
  type JobType,
} from '@atlas/contracts';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import type {
  CreateJobRequest,
  JobExecutionContext,
  JobExecutionResult,
  JobExecutor,
  JobProgressUpdate,
  JobRecord,
  JobRepository,
  KeyValueStore,
  PreparedJob,
} from './ports.js';
import { selectJobsToStart } from './queue.js';
import { assertTransition } from './state-machine.js';

export const JOB_SETTINGS_KEY = 'jobs.settings';
/** Progress is saved and published at most this often per job (FR-1208). */
export const DEFAULT_PROGRESS_INTERVAL_MS = 1000;
const DEFAULT_OUTPUT_PAGE = 1000;

export interface JobServiceOptions {
  repository: JobRepository;
  /** Absent in clients that do not own processes (e.g. the CLI): jobs are only read. */
  executors?: readonly JobExecutor[];
  settings: KeyValueStore;
  clock: { now(): Date };
  generateId: () => string;
  logger: Logger;
  progressIntervalMs?: number;
  /** Finished jobs kept (default JOB_MAX_STORED). */
  keepFinished?: number;
}

/** A job of this Engine that has not finished. */
interface ActiveJob {
  job: JobRecord;
  executor: JobExecutor;
  resource: string | null;
  controller: AbortController;
  attempt: JobAttempt | null;
  /** Serializes the job's writes, so they land in order. */
  saving: Promise<void>;
  progressTimer: ReturnType<typeof setTimeout> | null;
  /** Settles once a running job finished. */
  done: Promise<void>;
}

type JobListener = (job: BackgroundJob) => void;

const EMPTY_PROGRESS: JobProgress = {
  percent: null,
  stage: null,
  message: null,
  lastActivityAt: null,
};

/** Single-line plain text: control characters removed, whitespace collapsed, length capped. */
function oneLine(value: string, max: number): string {
  const text = value
    // eslint-disable-next-line no-control-regex -- removing control characters is the point.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const optionalLine = (value: string | null | undefined, max: number) =>
  value === null || value === undefined ? null : oneLine(value, max) || null;

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** What a failure says to the user: AtlasError messages are safe, anything else is not. */
function failureSummary(error: unknown): string {
  if (!(error instanceof AtlasError)) return 'The job could not run.';
  const issue = error.issues[0]?.message;
  return oneLine(issue ? `${error.userMessage} ${issue}` : error.userMessage, JOB_ERROR_MAX);
}

/**
 * Background jobs (SDD-012 Milestone A): a persistent, local queue in front of the
 * services that already run things. The Engine owns every job; closing a window or a
 * terminal never stops one, but jobs stop with the Engine and are then reported as
 * interrupted. A job is completed only when its executor says the work succeeded.
 */
export class JobService {
  /** In queue order: Map iteration keeps insertion order. */
  private readonly queued = new Map<string, ActiveJob>();
  private readonly running = new Map<string, ActiveJob>();
  /** Jobs whose retry is being saved, so two retries cannot both queue them. */
  private readonly retrying = new Set<string>();
  /** Duplicate keys of jobs being created, so two equal submissions cannot both pass. */
  private readonly creatingKeys = new Set<string>();
  private readonly listeners = new Set<JobListener>();
  private readonly finishedListeners = new Set<JobListener>();
  private readonly executors = new Map<JobType, JobExecutor>();
  private limits: JobSettings | null = null;
  private closing = false;

  constructor(private readonly options: JobServiceOptions) {
    for (const executor of options.executors ?? []) this.executors.set(executor.type, executor);
  }

  /** Called with a copy of a job after every change. Returns the unsubscribe function. */
  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async create(input: unknown, origin: JobOrigin): Promise<BackgroundJob> {
    const request = parseInput(CreateJobSchema, input);
    const executor = this.requireExecutor(request.type);
    const prepared = await executor.prepare(request);
    const key = executor.duplicateKey?.(prepared.payload) ?? null;
    const scopedKey = key === null ? null : `${request.type}\0${key}`;
    if (scopedKey !== null) {
      const active = [...this.queued.values(), ...this.running.values()].some(
        (job) =>
          job.job.type === request.type && job.executor.duplicateKey?.(job.job.payload) === key,
      );
      if (active || this.creatingKeys.has(scopedKey)) {
        throw new AtlasError(
          'JOB_TRANSITION_INVALID',
          'The same operation is already queued or running.',
        );
      }
      this.creatingKeys.add(scopedKey);
    }
    try {
      return await this.queue(request, executor, prepared, origin);
    } finally {
      if (scopedKey !== null) this.creatingKeys.delete(scopedKey);
    }
  }

  private async queue(
    request: CreateJobRequest,
    executor: JobExecutor,
    prepared: PreparedJob,
    origin: JobOrigin,
  ): Promise<BackgroundJob> {
    await this.settings();
    if (this.closing) throw new AtlasError('ENGINE_UNAVAILABLE', 'The Engine is stopping.');
    const at = this.now();
    const job: JobRecord = {
      id: this.options.generateId(),
      type: request.type,
      status: 'QUEUED',
      priority: request.priority,
      projectId: prepared.projectId,
      workspacePath: prepared.workspacePath,
      sessionId: null,
      title:
        oneLine(('title' in request ? request.title : undefined) ?? prepared.title, 120) ||
        'Background job',
      description: prepared.description,
      origin,
      payload: prepared.payload,
      createdAt: at,
      queuedAt: at,
      startedAt: null,
      finishedAt: null,
      progress: { ...EMPTY_PROGRESS },
      retryCount: 0,
      maxRetries: 0,
      executionReference: null,
      errorSummary: null,
      exitCode: null,
      cancelRequested: false,
    };
    // Saved before it can be dispatched (FR-1204).
    await this.options.repository.insert(job, this.change(job, 'QUEUED', 'Queued'));
    const active = this.activate(job, executor);
    // Ids and types only: commands and paths may hold private details.
    this.options.logger.info('Background job queued', { jobId: job.id, type: job.type });
    this.queued.set(job.id, active);
    this.emit(active);
    // As queued: the job may start (and change) before this call returns.
    const queued = this.view(job);
    if (this.closing) {
      await this.stopQueued(active);
    } else {
      this.pump();
    }
    return queued;
  }

  /**
   * Cancels a queued job at once; asks a running one to stop (FR-1207). A running job
   * stays RUNNING with `cancelRequested` until its executor reports how it ended.
   */
  async cancel(id: string): Promise<BackgroundJob> {
    const queued = this.queued.get(id);
    if (queued !== undefined) {
      this.queued.delete(id);
      this.transition(queued, 'CANCELLED');
      queued.job.finishedAt = this.now();
      await this.persist(queued, 'Cancelled before it started');
      this.emit(queued);
      return this.view(queued.job);
    }
    const running = this.running.get(id);
    if (running !== undefined) {
      if (!this.cancellable(running.executor, running.job)) {
        throw new AtlasError('JOB_NOT_CANCELLABLE');
      }
      if (running.job.cancelRequested) return this.view(running.job);
      running.job.cancelRequested = true;
      // As the request left it: the executor may stop (and finish the job) at once.
      const requested = this.view(running.job);
      this.emit(running);
      running.controller.abort();
      this.options.logger.info('Background job cancellation requested', { jobId: id });
      await this.persist(running, null);
      return requested;
    }
    const stored = await this.options.repository.find(id);
    if (stored === null) throw new AtlasError('JOB_NOT_FOUND');
    throw new AtlasError('JOB_TRANSITION_INVALID', 'The job already finished.');
  }

  /** Queues a failed, cancelled or interrupted job again, as a new attempt. */
  async retry(id: string): Promise<BackgroundJob> {
    if (this.queued.has(id) || this.running.has(id) || this.retrying.has(id)) {
      throw new AtlasError('JOB_TRANSITION_INVALID', 'The job has not finished.');
    }
    this.retrying.add(id);
    try {
      const stored = await this.options.repository.find(id);
      if (stored === null) throw new AtlasError('JOB_NOT_FOUND');
      if (!(RETRYABLE_JOB_STATUSES as readonly JobStatus[]).includes(stored.status)) {
        throw new AtlasError('JOB_TRANSITION_INVALID', `A ${stored.status} job is not retried.`);
      }
      const executor = this.requireExecutor(stored.type);
      if (executor.retryable === false) {
        throw new AtlasError('JOB_TRANSITION_INVALID', 'This kind of job is not retried.');
      }
      await this.settings();
      if (this.closing) throw new AtlasError('ENGINE_UNAVAILABLE', 'The Engine is stopping.');
      const active = this.activate(
        {
          ...stored,
          payload: executor.retryPayload?.(stored.payload) ?? stored.payload,
          retryCount: stored.retryCount + 1,
          queuedAt: this.now(),
          startedAt: null,
          finishedAt: null,
          progress: { ...EMPTY_PROGRESS },
          executionReference: null,
          errorSummary: null,
          exitCode: null,
          cancelRequested: false,
        },
        executor,
      );
      this.transition(active, 'QUEUED', stored.status);
      await this.persist(active, 'Retried by the user');
      this.options.logger.info('Background job retried', {
        jobId: id,
        attempt: stored.retryCount + 2,
      });
      this.queued.set(id, active);
      this.emit(active);
      const queued = this.view(active.job);
      this.pump();
      return queued;
    } finally {
      this.retrying.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async get(id: string): Promise<JobDetails> {
    const job = await this.record(id);
    const [attempts, history] = await Promise.all([
      this.options.repository.attempts(id),
      this.options.repository.history(id),
    ]);
    return { job: this.view(job), attempts, history };
  }

  async list(input: unknown): Promise<JobPage> {
    const query = parseInput(JobListQuerySchema, input);
    if (query.before !== undefined && (await this.options.repository.find(query.before)) === null) {
      throw new AtlasError('JOB_NOT_FOUND');
    }
    const rows = await this.options.repository.list({ ...query, limit: query.limit + 1 });
    const page = rows.slice(0, query.limit).map((row) => this.view(this.current(row)));
    return {
      jobs: page,
      nextBefore: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  summary(): JobSummary {
    const running = [...this.running.values()];
    return {
      running: running.filter((active) => active.job.status === 'RUNNING').length,
      queued: this.queued.size,
      waitingApproval: running.filter((active) => active.job.status === 'WAITING_APPROVAL').length,
    };
  }

  /** Jobs of this Engine that have not finished, oldest first. */
  unfinished(): BackgroundJob[] {
    return [...this.running.values(), ...this.queued.values()].map((active) =>
      this.view(active.job),
    );
  }

  async output(input: unknown): Promise<JobOutputPage> {
    const query = parseInput(JobOutputQuerySchema, input);
    const job = await this.record(query.jobId);
    const executor = this.executors.get(job.type);
    if (executor?.output === undefined) {
      throw new AtlasError('VALIDATION_FAILED', 'This job keeps no log.', {
        issues: [{ field: 'jobId', message: 'This type of job keeps no log.' }],
      });
    }
    const attempt = query.attempt ?? job.retryCount + 1;
    return executor.output(job, attempt, query.after, query.limit ?? DEFAULT_OUTPUT_PAGE);
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async settings(): Promise<JobSettings> {
    if (this.limits === null) {
      const raw = await this.options.settings.get(JOB_SETTINGS_KEY);
      const parsed = raw === null ? null : JobSettingsSchema.safeParse(safeJson(raw));
      if (parsed !== null && !parsed.success) {
        this.options.logger.warn('Stored background job settings are invalid; using defaults');
      }
      this.limits = parsed?.success ? parsed.data : JobSettingsSchema.parse({});
    }
    return { ...this.limits };
  }

  async updateSettings(input: unknown): Promise<JobSettings> {
    const changes = parseInput(UpdateJobSettingsSchema, input);
    const next = JobSettingsSchema.parse({ ...(await this.settings()), ...changes });
    await this.options.settings.set(JOB_SETTINGS_KEY, JSON.stringify(next));
    this.limits = next;
    // Higher limits may let queued jobs start now; lower ones never stop running jobs.
    this.pump();
    return { ...next };
  }

  // -------------------------------------------------------------------------
  // Engine lifetime
  // -------------------------------------------------------------------------

  /**
   * Jobs a previous Engine left unfinished are reported INTERRUPTED (FR-1220, Milestone A
   * policy): their processes cannot be verified, and nothing is started again by itself.
   */
  async recover(): Promise<BackgroundJob[]> {
    const interrupted = await this.options.repository.interruptUnfinished(
      this.now(),
      'ATLAS stopped before the job finished.',
    );
    if (interrupted.length > 0) {
      this.options.logger.warn('Background jobs were interrupted by an Engine stop', {
        count: interrupted.length,
      });
    }
    const jobs = interrupted.map((job) => this.view(job));
    for (const job of jobs) this.notify(job);
    return jobs;
  }

  /** Something outside the queue was released (e.g. a Preflight run ended): try again. */
  resourceReleased(): void {
    this.pump();
  }

  /**
   * Stops for an Engine shutdown: queued jobs never start and running ones are asked to
   * stop. Both are reported INTERRUPTED unless they finished meanwhile.
   */
  async close(): Promise<void> {
    this.closing = true;
    for (const active of [...this.queued.values()]) await this.stopQueued(active);
    const running = [...this.running.values()];
    for (const active of running) {
      if (active.executor.cancellable) active.controller.abort();
    }
    await Promise.all(running.map((active) => active.done));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private activate(job: JobRecord, executor: JobExecutor): ActiveJob {
    return {
      job,
      executor,
      resource: executor.resourceKey?.(job) ?? null,
      controller: new AbortController(),
      attempt: null,
      saving: Promise.resolve(),
      progressTimer: null,
      done: Promise.resolve(),
    };
  }

  private async stopQueued(active: ActiveJob): Promise<void> {
    this.queued.delete(active.job.id);
    this.transition(active, 'INTERRUPTED');
    active.job.finishedAt = this.now();
    active.job.errorSummary = 'ATLAS quit before the job started.';
    await this.persist(active, 'ATLAS quit before the job started.');
    this.emit(active);
  }

  /**
   * Starts what the limits allow. Selection and registration are synchronous, so a job
   * is never picked twice (FR-1205); the RUNNING state is saved before execution.
   */
  private pump(): void {
    if (this.closing || this.limits === null || this.queued.size === 0) return;
    const candidates = [...this.queued.values()].map((active) => ({
      id: active.job.id,
      priority: active.job.priority,
      projectId: active.job.projectId,
      resource: active.resource,
      ready: this.isReady(active),
      exempt: active.executor.exemptFromLimits === true,
    }));
    const slots = [...this.running.values()].map((active) => ({
      projectId: active.job.projectId,
      resource: active.resource,
      exempt: active.executor.exemptFromLimits === true,
    }));
    for (const id of selectJobsToStart(candidates, slots, this.limits)) {
      const active = this.queued.get(id)!;
      this.queued.delete(id);
      this.running.set(id, active);
      active.done = this.run(active).catch((error: unknown) =>
        this.options.logger.error('Background job failed unexpectedly', {
          jobId: id,
          error: describeError(error),
        }),
      );
    }
  }

  private isReady(active: ActiveJob): boolean {
    try {
      return active.executor.isReady?.(active.job) ?? true;
    } catch (error) {
      this.options.logger.warn('Background job readiness check failed', {
        jobId: active.job.id,
        error: describeError(error),
      });
      return false;
    }
  }

  private async run(active: ActiveJob): Promise<void> {
    const { job } = active;
    const at = this.now();
    this.transition(active, 'RUNNING');
    job.startedAt = at;
    job.progress = { ...EMPTY_PROGRESS, lastActivityAt: at };
    active.attempt = {
      jobId: job.id,
      attempt: job.retryCount + 1,
      status: 'RUNNING',
      startedAt: at,
      finishedAt: null,
      exitCode: null,
      errorSummary: null,
      executionReference: null,
    };
    try {
      await this.options.repository.save({ ...job }, this.change(job, 'RUNNING', 'Started'), {
        ...active.attempt,
      });
    } catch (error) {
      this.options.logger.error('Background job could not be saved before it started', {
        jobId: job.id,
        error: describeError(error),
      });
      await this.finish(active, {
        status: 'FAILED',
        errorSummary: 'The job could not be saved, so it did not start.',
      });
      return;
    }
    this.options.logger.info('Background job started', { jobId: job.id, type: job.type });
    this.emit(active);
    let result: JobExecutionResult;
    try {
      result = await active.executor.execute(this.context(active));
    } catch (error) {
      this.options.logger.warn('Background job executor failed', {
        jobId: job.id,
        error: describeError(error),
      });
      result = { status: 'FAILED', errorSummary: failureSummary(error) };
    }
    await this.finish(active, result);
  }

  private context(active: ActiveJob): JobExecutionContext {
    return {
      job: this.view(active.job),
      attempt: active.attempt!.attempt,
      signal: active.controller.signal,
      progress: (update) => this.progress(active, update),
      reference: (reference) => this.reference(active, reference),
    };
  }

  private progress(active: ActiveJob, update: JobProgressUpdate): void {
    if (!this.running.has(active.job.id)) return;
    const progress = active.job.progress;
    if (update.percent !== undefined) {
      progress.percent =
        update.percent === null || !Number.isFinite(update.percent)
          ? null
          : Math.min(100, Math.max(0, Math.round(update.percent)));
    }
    if (update.stage !== undefined) progress.stage = optionalLine(update.stage, JOB_STAGE_MAX);
    if (update.message !== undefined) {
      progress.message = optionalLine(update.message, JOB_MESSAGE_MAX);
    }
    progress.lastActivityAt = this.now();
    // At most one write and one event per interval (FR-1208).
    active.progressTimer ??= setTimeout(() => {
      active.progressTimer = null;
      if (!this.running.has(active.job.id)) return;
      void this.persist(active, null);
      this.emit(active);
    }, this.options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
  }

  private reference(active: ActiveJob, reference: JobExecutionReference): void {
    if (!this.running.has(active.job.id)) return;
    active.job.executionReference = reference;
    if (active.attempt !== null) active.attempt.executionReference = reference;
    void this.persist(active, null);
    this.emit(active);
  }

  private async finish(active: ActiveJob, result: JobExecutionResult): Promise<void> {
    const { job } = active;
    let status: JobStatus = result.status;
    let detail: string;
    if (status === 'CANCELLED' && this.closing && !job.cancelRequested) {
      status = 'INTERRUPTED';
      detail = 'ATLAS quit while the job was running.';
    } else if (status === 'CANCELLED') {
      detail = job.cancelRequested ? 'Cancelled by the user' : 'Stopped outside the job';
    } else {
      detail = status === 'COMPLETED' ? 'Completed' : 'Failed';
    }
    if (active.progressTimer !== null) clearTimeout(active.progressTimer);
    active.progressTimer = null;
    this.transition(active, status);
    const at = this.now();
    job.finishedAt = at;
    job.exitCode = result.exitCode ?? null;
    // An interruption is explained by why it happened, not by how the executor stopped.
    job.errorSummary =
      status === 'COMPLETED'
        ? null
        : status === 'INTERRUPTED'
          ? detail
          : optionalLine(result.errorSummary, JOB_ERROR_MAX);
    if (status === 'COMPLETED' && job.progress.percent !== null) job.progress.percent = 100;
    if (active.attempt !== null) {
      Object.assign(active.attempt, {
        status,
        finishedAt: at,
        exitCode: job.exitCode,
        errorSummary: job.errorSummary,
      });
    }
    this.running.delete(job.id);
    await this.persist(active, detail);
    this.options.logger.info('Background job finished', { jobId: job.id, status });
    this.emit(active);
    this.notify(this.view(job));
    this.pump();
    await this.prune();
  }

  /** Saves the job (and its open attempt) after the writes before it. Never throws. */
  private persist(active: ActiveJob, detail: string | null): Promise<void> {
    const job = { ...active.job, progress: { ...active.job.progress } };
    const change = detail === null ? null : this.change(job, job.status, detail);
    const attempt = active.attempt === null ? null : { ...active.attempt };
    active.saving = active.saving
      .then(() => this.options.repository.save(job, change, attempt))
      .catch((error: unknown) =>
        this.options.logger.error('Background job could not be saved', {
          jobId: job.id,
          error: describeError(error),
        }),
      );
    return active.saving;
  }

  private async prune(): Promise<void> {
    try {
      const removed = await this.options.repository.prune(
        this.options.keepFinished ?? JOB_MAX_STORED,
      );
      for (const jobId of removed) {
        for (const executor of this.executors.values()) await executor.removeLogs?.(jobId);
      }
    } catch (error) {
      this.options.logger.warn('Old background jobs could not be removed', {
        error: describeError(error),
      });
    }
  }

  private transition(active: ActiveJob, to: JobStatus, from: JobStatus = active.job.status) {
    assertTransition(from, to);
    active.job.status = to;
    if (active.attempt !== null && to !== 'QUEUED') active.attempt.status = to;
  }

  private change(job: JobRecord, status: JobStatus, detail: string | null): JobStatusChange {
    return { jobId: job.id, status, at: this.now(), detail };
  }

  /** The newest state: a job of this Engine is fresher in memory than in storage. */
  private current(stored: JobRecord): JobRecord {
    return (this.running.get(stored.id) ?? this.queued.get(stored.id))?.job ?? stored;
  }

  private async record(id: string): Promise<JobRecord> {
    const active = this.running.get(id) ?? this.queued.get(id);
    if (active !== undefined) return active.job;
    const stored = await this.options.repository.find(id);
    if (stored === null) throw new AtlasError('JOB_NOT_FOUND');
    return stored;
  }

  private requireExecutor(type: JobType): JobExecutor {
    const executor = this.executors.get(type);
    if (executor === undefined) {
      throw new AtlasError(
        this.executors.size === 0 ? 'ENGINE_UNAVAILABLE' : 'VALIDATION_FAILED',
        'This type of job cannot run here.',
        { issues: [{ field: 'type', message: 'This type of job is not available.' }] },
      );
    }
    return executor;
  }

  private cancellable(executor: JobExecutor, job: JobRecord): boolean {
    return executor.isCancellable?.(job) ?? executor.cancellable;
  }

  private view(job: JobRecord): BackgroundJob {
    const executor = this.executors.get(job.type);
    const running = this.running.has(job.id);
    return {
      ...structuredClone(job),
      capabilities: {
        cancel:
          this.queued.has(job.id) ||
          (running &&
            executor !== undefined &&
            this.cancellable(executor, job) &&
            !job.cancelRequested),
        retry:
          executor !== undefined &&
          executor.retryable !== false &&
          (RETRYABLE_JOB_STATUSES as readonly JobStatus[]).includes(job.status),
        logs: executor?.output !== undefined && (job.startedAt !== null || job.retryCount > 0),
      },
    };
  }

  private emit(active: ActiveJob): void {
    if (this.listeners.size === 0) return;
    const job = this.view(active.job);
    for (const listener of this.listeners) {
      try {
        listener(job);
      } catch (error) {
        this.options.logger.warn('Background job listener failed', {
          error: describeError(error),
        });
      }
    }
  }

  /** Finished jobs whose executor does not report its own outcome reach `onFinished`. */
  private notify(job: BackgroundJob): void {
    if (!isFinalJobStatus(job.status)) return;
    const executor = this.executors.get(job.type);
    // An interrupted job's executor never got to report anything.
    if (executor?.notifiesOutcome === true && job.status !== 'INTERRUPTED') return;
    for (const listener of this.finishedListeners) {
      try {
        listener(job);
      } catch (error) {
        this.options.logger.warn('Background job listener failed', {
          error: describeError(error),
        });
      }
    }
  }

  /**
   * Called once per finished job that needs a notification of its own: its executor's
   * service does not report outcomes, or the job was interrupted (FR-1228).
   */
  onFinished(listener: JobListener): () => void {
    this.finishedListeners.add(listener);
    return () => {
      this.finishedListeners.delete(listener);
    };
  }

  private now(): string {
    return this.options.clock.now().toISOString();
  }
}
