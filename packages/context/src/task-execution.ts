import {
  ACTIVE_TASK_EXECUTION_STATUSES,
  type AiProvider,
  type TaskExecution,
  type TaskExecutionEndReason,
  type TaskExecutionStatus,
} from '@atlas/contracts';
import { AtlasError, describeError, noopLogger, type Logger } from '@atlas/shared';

/** Storage of task executions (SQLite in the Engine). */
export interface TaskExecutionStore {
  insert(execution: TaskExecution): Promise<void>;
  update(execution: TaskExecution): Promise<void>;
  get(id: string): Promise<TaskExecution | null>;
  findByRequestId(requestId: string): Promise<TaskExecution | null>;
  /** Newest first. */
  listForTask(taskId: string, limit: number): Promise<TaskExecution[]>;
  listActive(): Promise<TaskExecution[]>;
  /** Finished, unreviewed executions of a terminal. */
  listUnreviewedForTerminal(terminalId: string): Promise<TaskExecution[]>;
}

export interface TaskExecutionTrackerOptions {
  store: TaskExecutionStore;
  now: () => Date;
  /** Every saved change (e.g. to publish an event). */
  onChange: (execution: TaskExecution) => void;
  /**
   * Once per execution that ended by itself: review required, failed or interrupted. Not
   * called for cancellations, untracked runs or launch failures the user already saw.
   */
  onFinished: (execution: TaskExecution) => Promise<void>;
  /** Every execution reaching a final status, notified or not (e.g. to end its AI session). */
  onSettled?: (execution: TaskExecution) => Promise<void>;
  /** How long a launched command may take to report its start before it is UNTRACKED. */
  launchTimeoutMs?: number;
  logger?: Logger;
}

export interface AiRunEvent {
  terminalId: string;
  provider: AiProvider;
  run: string;
}

/** A wrapper normally reports within seconds; slow shells start-up files get a margin. */
const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;
export const TASK_EXECUTION_HISTORY_LIMIT = 20;

const isActive = (status: TaskExecutionStatus) => ACTIVE_TASK_EXECUTION_STATUSES.includes(status);

/**
 * Lifecycle of task executions (SDD-025 Task 02), fed by the same explicit events as the
 * terminal tab status: the AI wrapper's start and end, and the terminal's end. Nothing is
 * inferred from terminal output. A finished execution never changes status again, so late
 * or repeated events cannot overwrite it, and it never completes its task.
 */
export class TaskExecutionTracker {
  private readonly logger: Logger;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: TaskExecutionTrackerOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  /** Executions still active when ATLAS stopped can no longer report: INTERRUPTED. */
  recover(): Promise<void> {
    return this.exclusive(async () => {
      for (const execution of await this.options.store.listActive()) {
        await this.finish(execution, 'INTERRUPTED', 'engine-restart', null, { notify: false });
      }
    });
  }

  /** Stops the launch timers (Engine shutdown). */
  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  get(id: string): Promise<TaskExecution> {
    return this.require(id);
  }

  findByRequestId(requestId: string): Promise<TaskExecution | null> {
    return this.options.store.findByRequestId(requestId);
  }

  listForTask(taskId: string): Promise<TaskExecution[]> {
    return this.options.store.listForTask(taskId, TASK_EXECUTION_HISTORY_LIMIT);
  }

  async activeForTerminal(terminalId: string): Promise<TaskExecution | null> {
    return (
      (await this.options.store.listActive()).find((item) => item.terminalId === terminalId) ?? null
    );
  }

  async activeForTask(taskId: string): Promise<TaskExecution | null> {
    return (await this.options.store.listActive()).find((item) => item.taskId === taskId) ?? null;
  }

  /**
   * Records an execution right before its command is typed. `tracked` is false when the
   * wrapper is known not to run (it can then never report): the record starts UNTRACKED.
   */
  create(
    fields: Omit<
      TaskExecution,
      | 'id'
      | 'runRef'
      | 'status'
      | 'exitCode'
      | 'endReason'
      | 'createdAt'
      | 'startedAt'
      | 'endedAt'
      | 'cancelRequestedAt'
      | 'reviewedAt'
    > & { id: string; tracked: boolean },
  ): Promise<TaskExecution> {
    return this.exclusive(async () => {
      const { tracked, ...rest } = fields;
      const execution: TaskExecution = {
        ...rest,
        runRef: null,
        status: tracked ? 'LAUNCHING' : 'UNTRACKED',
        exitCode: null,
        endReason: null,
        createdAt: this.timestamp(),
        startedAt: null,
        endedAt: null,
        cancelRequestedAt: null,
        reviewedAt: null,
      };
      await this.options.store.insert(execution);
      this.options.onChange(execution);
      if (tracked) this.startLaunchTimer(execution.id);
      return execution;
    });
  }

  /** The command could not be typed: the execution failed before it started. */
  launchFailed(id: string): Promise<TaskExecution> {
    return this.exclusive(async () => {
      const execution = await this.require(id);
      if (!isActive(execution.status) && execution.status !== 'UNTRACKED') return execution;
      return this.finish(execution, 'FAILED', 'launch-failed', null, { notify: false });
    });
  }

  /** The wrapper reported a start: the terminal's launching execution is now running. */
  aiStarted(event: AiRunEvent): Promise<void> {
    return this.exclusive(async () => {
      const execution = await this.launching(event);
      if (execution === null) return;
      this.clearTimer(execution.id);
      await this.save({
        ...execution,
        status: 'RUNNING',
        runRef: event.run,
        startedAt: this.timestamp(),
      });
    });
  }

  /** The wrapper reported an end; an end without a start finishes a launching execution. */
  aiEnded(event: AiRunEvent & { exitCode: number | null }): Promise<void> {
    return this.exclusive(async () => {
      const active = await this.options.store.listActive();
      const execution =
        active.find((item) => item.terminalId === event.terminalId && item.runRef === event.run) ??
        (await this.launching(event));
      if (execution === null) return;
      const withRun = { ...execution, runRef: execution.runRef ?? event.run };
      if (execution.cancelRequestedAt !== null) {
        await this.finish(withRun, 'CANCELLED', 'cancelled', event.exitCode, { notify: false });
      } else if (event.exitCode === 0) {
        await this.finish(withRun, 'REVIEW_REQUIRED', null, 0);
      } else {
        await this.finish(withRun, 'FAILED', 'exit-code', event.exitCode);
      }
    });
  }

  /** The terminal ended: what was still active can no longer report its end. */
  terminalEnded(terminalId: string): Promise<void> {
    return this.exclusive(async () => {
      // Terminals stopped by the shutdown itself are recorded at the next start.
      if (this.closed) return;
      for (const execution of await this.options.store.listActive()) {
        if (execution.terminalId !== terminalId) continue;
        if (execution.cancelRequestedAt !== null) {
          await this.finish(execution, 'CANCELLED', 'cancelled', null, { notify: false });
        } else {
          await this.finish(execution, 'INTERRUPTED', 'terminal-ended', null);
        }
      }
    });
  }

  /**
   * Records the user's cancellation. A launching execution is cancelled at once; a running
   * one when its end (or its terminal's) arrives. Returns the execution and whether keys
   * must be sent to its terminal.
   */
  requestCancel(id: string): Promise<TaskExecution> {
    return this.exclusive(async () => {
      const execution = await this.require(id);
      if (!isActive(execution.status)) {
        throw new AtlasError('TASK_EXECUTION_INVALID_STATE', undefined, {
          details: { status: execution.status },
        });
      }
      if (execution.status === 'LAUNCHING') {
        this.clearTimer(execution.id);
        return this.finish(
          { ...execution, cancelRequestedAt: this.timestamp() },
          'CANCELLED',
          'cancelled',
          null,
          { notify: false },
        );
      }
      if (execution.cancelRequestedAt !== null) return execution;
      return this.save({ ...execution, cancelRequestedAt: this.timestamp() });
    });
  }

  /** Explicit review of a finished execution (never automatic). */
  markReviewed(id: string): Promise<TaskExecution> {
    return this.exclusive(async () => {
      const execution = await this.require(id);
      if (isActive(execution.status)) {
        throw new AtlasError('TASK_EXECUTION_INVALID_STATE', undefined, {
          details: { status: execution.status },
        });
      }
      if (execution.reviewedAt !== null) return execution;
      return this.save({ ...execution, reviewedAt: this.timestamp() });
    });
  }

  /** "Mark as reviewed" on a terminal also reviews its finished executions. */
  markTerminalReviewed(terminalId: string): Promise<void> {
    return this.exclusive(async () => {
      const at = this.timestamp();
      for (const execution of await this.options.store.listUnreviewedForTerminal(terminalId)) {
        await this.save({ ...execution, reviewedAt: at });
      }
    });
  }

  /** The oldest launching execution of the terminal for this provider, if any. */
  private async launching(event: AiRunEvent): Promise<TaskExecution | null> {
    return (
      (await this.options.store.listActive())
        .filter(
          (item) =>
            item.terminalId === event.terminalId &&
            item.provider === event.provider &&
            item.status === 'LAUNCHING',
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null
    );
  }

  private startLaunchTimer(id: string): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.exclusive(async () => {
        const execution = await this.options.store.get(id);
        if (execution?.status !== 'LAUNCHING') return;
        await this.save({ ...execution, status: 'UNTRACKED' });
      }).catch((error: unknown) =>
        this.logger.warn('Task execution could not be updated', { error: describeError(error) }),
      );
    }, this.options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS);
    // Node timers must not keep the process alive; the package is also bundled for browsers.
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }

  private async finish(
    execution: TaskExecution,
    status: TaskExecutionStatus,
    endReason: TaskExecutionEndReason | null,
    exitCode: number | null,
    { notify = true }: { notify?: boolean } = {},
  ): Promise<TaskExecution> {
    this.clearTimer(execution.id);
    const finished = await this.save({
      ...execution,
      status,
      endReason,
      exitCode,
      endedAt: this.timestamp(),
    });
    // Each follow-up is independent: one failing never skips the other.
    const followUps = [this.options.onSettled, notify ? this.options.onFinished : undefined];
    for (const followUp of followUps) {
      try {
        await followUp?.(finished);
      } catch (error) {
        this.logger.warn('Task execution outcome could not be reported', {
          error: describeError(error),
        });
      }
    }
    return finished;
  }

  private async save(execution: TaskExecution): Promise<TaskExecution> {
    await this.options.store.update(execution);
    this.options.onChange(execution);
    return execution;
  }

  private async require(id: string): Promise<TaskExecution> {
    const execution = await this.options.store.get(id);
    if (execution === null) throw new AtlasError('TASK_EXECUTION_NOT_FOUND');
    return execution;
  }

  /** One change at a time, so events, timers and user actions never interleave. */
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private timestamp(): string {
    return this.options.now().toISOString();
  }
}
