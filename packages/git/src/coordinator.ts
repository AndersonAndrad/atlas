import type { GitFailureCode, GitOperation, GitOperationKind } from '@atlas/contracts';
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
}

const LANE_ORDER: Record<GitLane, number> = { index: 0, remote: 1 };

/**
 * Serializes conflicting Git mutations per repository and keeps a bounded
 * history of operations. Read-only inspection does not go through it.
 */
export class GitOperationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(private readonly options: GitOperationCoordinatorOptions) {
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? (() => new Date());
  }

  /** Recent operations, oldest first. */
  list(): GitOperation[] {
    return [...this.tracked.values()].map((entry) => ({ ...entry.operation }));
  }

  /** Whether a mutation is queued or running for the repository. */
  isBusy(repositoryRoot: string): boolean {
    return [...this.tracked.values()].some(
      ({ operation }) =>
        operation.repositoryRoot === repositoryRoot &&
        (operation.status === 'queued' || operation.status === 'running'),
    );
  }

  /** Cancels a queued operation, or a running one that is safe to interrupt. */
  cancel(id: string): GitOperation {
    const entry = this.tracked.get(id);
    if (!entry) throw new AtlasError('GIT_OPERATION_NOT_FOUND');
    const { operation, controller } = entry;
    if (
      operation.status === 'queued' ||
      (operation.status === 'running' && operation.cancellable)
    ) {
      controller.abort();
    } else if (operation.status === 'running') {
      throw new AtlasError('VALIDATION_FAILED', 'Operation cannot be cancelled safely.', {
        issues: [{ field: 'operation', message: 'This operation cannot be cancelled safely.' }],
      });
    }
    return { ...operation };
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
    };
    this.track({ operation, controller });
    this.emit(operation);

    const releases: (() => void)[] = [];
    const lanes = [...new Set(request.lanes)].sort((a, b) => LANE_ORDER[a] - LANE_ORDER[b]);
    try {
      for (const lane of lanes)
        releases.push(await this.acquire(`${request.repositoryRoot}\0${lane}`));
      if (controller.signal.aborted) {
        return {
          operation: this.finish(operation, 'cancelled', 'Cancelled before it started.'),
          value: null,
        };
      }
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
      });
      return {
        operation: this.finish(operation, 'succeeded', result.summary),
        value: result.value,
      };
    } catch (error) {
      if (error instanceof GitCommandError && error.kind === 'cancelled') {
        return { operation: this.finish(operation, 'cancelled', 'Cancelled.'), value: null };
      }
      if (error instanceof GitOperationFailure) {
        operation.error = { code: error.code, message: error.message, output: error.output };
        return { operation: this.finish(operation, 'failed', null), value: null };
      }
      if (error instanceof AtlasError) {
        operation.error = { code: 'unavailable', message: error.userMessage, output: null };
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
    return { ...operation };
  }

  private emit(operation: GitOperation): void {
    this.options.onChange?.({ ...operation });
  }

  private track(entry: Tracked): void {
    this.tracked.set(entry.operation.id, entry);
    const limit = this.options.historyLimit ?? 100;
    for (const [id, { operation }] of this.tracked) {
      if (this.tracked.size <= limit) break;
      if (operation.status !== 'queued' && operation.status !== 'running') this.tracked.delete(id);
    }
  }

  /** FIFO mutex per key; resolves with the release function. */
  private async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}
