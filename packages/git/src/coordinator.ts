import type {
  GitFailureCode,
  GitOperation,
  GitOperationKind,
  GitPreCommitStepResult,
} from '@atlas/contracts';
import { AtlasError, describeError, noopLogger, type Logger } from '@atlas/shared';
import { parseProgress } from './porcelain.js';
import { GitCommandError } from './runner.js';

/**
 * Resources an operation mutates. `index` covers the index, HEAD, branches and
 * the working tree; `remote` covers remote-tracking refs and the network.
 * Operations on different lanes of one repository may run concurrently.
 */
export type GitLane = 'index' | 'remote';

/** An expected Git failure reported on the operation instead of thrown. */
export class GitOperationFailure extends Error {
  constructor(
    readonly code: GitFailureCode,
    message: string,
    /** Already sanitized Git output. */
    readonly output: string | null = null,
  ) {
    super(message);
    this.name = 'GitOperationFailure';
  }
}

export interface GitOperationContext {
  signal: AbortSignal;
  /** Feeds a raw Git progress line; the coordinator parses and throttles it. */
  progress(line: string): void;
  /** Publishes the current state of pre-commit steps. */
  setSteps(steps: GitPreCommitStepResult[]): void;
  /** Whether cancelling is safe from now on (e.g. only before a commit is created). */
  setCancellable(cancellable: boolean): void;
}

export interface GitOperationRequest {
  repositoryRoot: string;
  kind: GitOperationKind;
  lanes: readonly GitLane[];
  cancellable: boolean;
}

export interface GitOperationOutcome<T> {
  operation: GitOperation;
  value: T | null;
}

export interface GitOperationCoordinatorOptions {
  generateId: () => string;
  now?: () => Date;
  logger?: Logger;
  onChange?: (operation: GitOperation) => void;
  historyLimit?: number;
  progressIntervalMs?: number;
}

interface Tracked {
  operation: GitOperation;
  controller: AbortController;
  /** Settles when `run` returned or threw. */
  done: Promise<void>;
}

/** Waiting for a lane ended because the operation was cancelled while queued. */
class CancelledWhileQueued extends Error {}

interface Lane {
  held: boolean;
  /** FIFO of operations waiting for the lane. */
  waiters: { grant: () => void }[];
}

const copy = (operation: GitOperation): GitOperation => ({
  ...operation,
  steps: operation.steps?.map((step) => ({ ...step })) ?? null,
});

const LANE_ORDER: Record<GitLane, number> = { index: 0, remote: 1 };

/**
 * Serializes conflicting Git mutations per repository and keeps a bounded
 * history of operations. Read-only inspection does not go through it.
 */
export class GitOperationCoordinator {
  private readonly lanes = new Map<string, Lane>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly logger: Logger;
  private readonly now: () => Date;
  private closed = false;

  constructor(private readonly options: GitOperationCoordinatorOptions) {
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? (() => new Date());
  }

  /** Recent operations, oldest first. */
  list(): GitOperation[] {
    return [...this.tracked.values()].map((entry) => copy(entry.operation));
  }

  /** Whether a mutation is queued or running for the repository. */
  isBusy(repositoryRoot: string): boolean {
    return [...this.tracked.values()].some(
      ({ operation }) =>
        operation.repositoryRoot === repositoryRoot &&
        (operation.status === 'queued' || operation.status === 'running'),
    );
  }

  /**
   * Cancels a queued operation, which settles immediately and leaves the queue, or a
   * running one that is safe to interrupt. Returns the operation's current state.
   */
  cancel(id: string): GitOperation {
    const entry = this.tracked.get(id);
    if (!entry) throw new AtlasError('GIT_OPERATION_NOT_FOUND');
    const { operation, controller } = entry;
    if (operation.status === 'queued') {
      this.finish(operation, 'cancelled', 'Cancelled before it started.');
      controller.abort();
    } else if (operation.status === 'running' && operation.cancellable) {
      controller.abort();
    } else if (operation.status === 'running') {
      throw new AtlasError('VALIDATION_FAILED', 'Operation cannot be cancelled safely.', {
        issues: [{ field: 'operation', message: 'This operation cannot be cancelled safely.' }],
      });
    }
    return copy(operation);
  }

  /**
   * Cancels every queued operation and every running one that is safe to interrupt,
   * e.g. on shutdown. Running operations that cannot be interrupted keep running.
   */
  cancelAll(): void {
    for (const { operation } of [...this.tracked.values()]) {
      if (
        operation.status === 'queued' ||
        (operation.status === 'running' && operation.cancellable)
      ) {
        this.cancel(operation.id);
      }
    }
  }

  /**
   * Stops accepting operations (e.g. on shutdown) and cancels what is safe to stop.
   * Operations requested afterwards, such as the push that follows a commit which
   * was still finishing, settle as cancelled without running.
   */
  close(): void {
    this.closed = true;
    this.cancelAll();
  }

  /** Whether `close` was called. */
  get closing(): boolean {
    return this.closed;
  }

  /**
   * Resolves once no operation is queued or running, or after `timeoutMs`.
   * Returns whether every operation settled in time.
   */
  async idle(timeoutMs: number): Promise<boolean> {
    const pending = [...this.tracked.values()]
      .filter(({ operation }) => operation.status === 'queued' || operation.status === 'running')
      .map((entry) => entry.done);
    if (pending.length === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([Promise.all(pending).then(() => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async run<T>(
    request: GitOperationRequest,
    task: (context: GitOperationContext) => Promise<{ summary: string; value: T }>,
  ): Promise<GitOperationOutcome<T>> {
    const controller = new AbortController();
    const operation: GitOperation = {
      id: this.options.generateId(),
      kind: request.kind,
      repositoryRoot: request.repositoryRoot,
      status: 'queued',
      startedAt: this.now().toISOString(),
      finishedAt: null,
      progress: null,
      summary: null,
      error: null,
      cancellable: true,
      steps: null,
    };
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    this.track({ operation, controller, done });
    this.emit(operation);
    if (this.closed) {
      settle();
      return {
        operation: this.finish(operation, 'cancelled', 'Cancelled because ATLAS is shutting down.'),
        value: null,
      };
    }

    const releases: (() => void)[] = [];
    const lanes = [...new Set(request.lanes)].sort((a, b) => LANE_ORDER[a] - LANE_ORDER[b]);
    try {
      for (const lane of lanes) {
        releases.push(await this.acquire(`${request.repositoryRoot}\0${lane}`, controller.signal));
      }
      // `cancel` already settled a queued operation; it never starts.
      if (operation.status === 'cancelled') return { operation: copy(operation), value: null };
      operation.status = 'running';
      operation.cancellable = request.cancellable;
      this.emit(operation);

      let lastProgress = 0;
      const interval = this.options.progressIntervalMs ?? 200;
      const result = await task({
        signal: controller.signal,
        progress: (line) => {
          const parsed = parseProgress(line);
          if (parsed === null) return;
          operation.progress = parsed;
          const now = Date.now();
          if (now - lastProgress >= interval || parsed.percent === 100) {
            lastProgress = now;
            this.emit(operation);
          }
        },
        setSteps: (steps) => {
          operation.steps = steps.map((step) => ({ ...step }));
          this.emit(operation);
        },
        setCancellable: (cancellable) => {
          if (operation.cancellable === cancellable) return;
          operation.cancellable = cancellable;
          this.emit(operation);
        },
      });
      return {
        operation: this.finish(operation, 'succeeded', result.summary),
        value: result.value,
      };
    } catch (error) {
      if (error instanceof CancelledWhileQueued) return { operation: copy(operation), value: null };
      if (error instanceof GitCommandError && error.kind === 'cancelled') {
        return { operation: this.finish(operation, 'cancelled', 'Cancelled.'), value: null };
      }
      if (error instanceof GitOperationFailure) {
        operation.error = { code: error.code, message: error.message, output: error.output };
        return { operation: this.finish(operation, 'failed', null), value: null };
      }
      if (error instanceof AtlasError) {
        // Issues are safe to show and explain the failure more precisely.
        const message = error.issues[0]?.message ?? error.userMessage;
        operation.error = { code: 'unavailable', message, output: null };
        this.finish(operation, 'failed', null);
        throw error;
      }
      this.logger.error('Git operation failed unexpectedly', {
        kind: operation.kind,
        error: describeError(error),
      });
      operation.error = {
        code: 'unavailable',
        message: 'Git could not complete the operation.',
        output: null,
      };
      return { operation: this.finish(operation, 'failed', null), value: null };
    } finally {
      for (const release of releases.reverse()) release();
      settle();
    }
  }

  private finish(
    operation: GitOperation,
    status: GitOperation['status'],
    summary: string | null,
  ): GitOperation {
    operation.status = status;
    operation.summary = summary;
    operation.finishedAt = this.now().toISOString();
    operation.cancellable = false;
    this.emit(operation);
    return copy(operation);
  }

  private emit(operation: GitOperation): void {
    this.options.onChange?.(copy(operation));
  }

  private track(entry: Tracked): void {
    this.tracked.set(entry.operation.id, entry);
    const limit = this.options.historyLimit ?? 100;
    for (const [id, { operation }] of this.tracked) {
      if (this.tracked.size <= limit) break;
      if (operation.status !== 'queued' && operation.status !== 'running') this.tracked.delete(id);
    }
  }

  /**
   * FIFO mutex per key; resolves with the release function. Rejects with
   * `CancelledWhileQueued` when `signal` aborts before the lock was granted, removing
   * the waiter so the operations behind it keep their order.
   */
  private acquire(key: string, signal: AbortSignal): Promise<() => void> {
    let lane = this.lanes.get(key);
    if (lane === undefined) {
      lane = { held: false, waiters: [] };
      this.lanes.set(key, lane);
    }
    const current = lane;
    const release = () => {
      const next = current.waiters.shift();
      if (next !== undefined) next.grant();
      else {
        current.held = false;
        this.lanes.delete(key);
      }
    };
    if (signal.aborted) return Promise.reject(new CancelledWhileQueued());
    if (!current.held) {
      current.held = true;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          resolve(release);
        },
      };
      const onAbort = () => {
        const index = current.waiters.indexOf(waiter);
        if (index !== -1) current.waiters.splice(index, 1);
        reject(new CancelledWhileQueued());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      current.waiters.push(waiter);
    });
  }
}
