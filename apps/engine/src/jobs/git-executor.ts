import type {
  GitOperation,
  GitOperationLogDetails,
  JobOutputPage,
  JobPayload,
  PreflightOutputLine,
} from '@atlas/contracts';
import type { GitWorkspaceService } from '@atlas/git';
import type {
  CreateJobRequest,
  JobExecutionContext,
  JobExecutionResult,
  JobExecutor,
  JobRecord,
  PreparedJob,
} from '@atlas/jobs';
import { AtlasError } from '@atlas/shared';

type GitPayload = Extract<JobPayload, { type: 'GIT' }>;

export interface GitJobExecutorOptions {
  git: Pick<
    GitWorkspaceService,
    'push' | 'pull' | 'fetch' | 'preparePush' | 'preparePull' | 'prepareFetch'
  >;
  /** The root as the Engine resolved it; throws for repositories it does not know. */
  resolveRepository: (repositoryRoot: string) => Promise<string>;
  /** The registered project of a repository, when there is one. */
  projectOf: (repositoryRoot: string) => Promise<{ id: string; name: string } | null>;
  cancelOperation: (operationId: string) => void;
  operationDetails: (operationId: string) => Promise<GitOperationLogDetails>;
  /** How long a push or pull may still run once ATLAS quits (it cannot be interrupted). */
  shutdownGraceMs: number;
}

/** The job's outcome from its finished Git operation. */
export function gitJobResult(operation: GitOperation): JobExecutionResult {
  switch (operation.status) {
    case 'succeeded':
      return { status: 'COMPLETED' };
    case 'cancelled':
      return { status: 'CANCELLED', errorSummary: operation.summary ?? 'Cancelled.' };
    default:
      return {
        status: 'FAILED',
        errorSummary: operation.error?.message ?? 'The Git operation failed.',
      };
  }
}

/**
 * Runs a confirmed push, pull or fetch as a background job (SDD-025 Task 01) through the
 * existing Git workflow: the same validation, coordinator lanes, hooks, operation log and
 * notifications. The job follows the Git operation; it never retries and never forces.
 */
export class GitJobExecutor implements JobExecutor {
  readonly type = 'GIT' as const;
  readonly cancellable = true;
  /** Git operations already publish their notification. */
  readonly notifiesOutcome = true;
  /** A push or pull is never repeated by a click on Retry. */
  readonly retryable = false;
  /** The Git coordinator serializes operations per repository already. */
  readonly exemptFromLimits = true;

  constructor(private readonly options: GitJobExecutorOptions) {}

  async prepare(request: CreateJobRequest): Promise<PreparedJob> {
    if (request.type !== 'GIT') throw new AtlasError('VALIDATION_FAILED');
    const root = await this.options.resolveRepository(request.repositoryRoot);
    const project = await this.options.projectOf(root);
    const name = project?.name ?? root.split(/[\\/]/).pop() ?? root;
    let title: string;
    let payload: GitPayload;
    switch (request.action) {
      case 'push': {
        const plan = await this.options.git.preparePush(root, request.setUpstream);
        title = `Push ${plan.branch} → ${plan.destination}`;
        payload = {
          type: 'GIT',
          action: 'push',
          repositoryRoot: root,
          ...(request.setUpstream ? { setUpstream: { ...request.setUpstream } } : {}),
        };
        break;
      }
      case 'pull': {
        const plan = await this.options.git.preparePull(root);
        title = `Pull ${plan.upstream} → ${plan.branch}`;
        payload = { type: 'GIT', action: 'pull', repositoryRoot: root, mode: request.mode };
        break;
      }
      case 'fetch': {
        await this.options.git.prepareFetch(root, request.remote);
        title = `Fetch ${request.remote ?? 'default remote'}`;
        payload = {
          type: 'GIT',
          action: 'fetch',
          repositoryRoot: root,
          ...(request.remote ? { remote: request.remote } : {}),
        };
        break;
      }
    }
    return {
      title,
      description: name,
      projectId: project?.id ?? null,
      workspacePath: root,
      payload,
    };
  }

  /** One push, pull or fetch per repository at a time is already queued or running. */
  duplicateKey(payload: JobPayload): string | null {
    return payload.type === 'GIT' ? `${payload.action}\0${payload.repositoryRoot}` : null;
  }

  /** Only a fetch can stop once it runs; a queued job can always be cancelled. */
  isCancellable(job: JobRecord): boolean {
    return job.payload.type === 'GIT' && job.payload.action === 'fetch';
  }

  /** Same repository: also serialized by the coordinator, kept here so the queue shows it. */
  resourceKey(job: JobRecord): string | null {
    return job.payload.type === 'GIT' ? `git:${job.payload.repositoryRoot}` : null;
  }

  async execute(context: JobExecutionContext): Promise<JobExecutionResult> {
    const payload = context.job.payload as GitPayload;
    if (context.signal.aborted) return { status: 'CANCELLED' };
    let operationId: string | null = null;
    const observe = (operation: GitOperation) => {
      if (operationId === null) {
        operationId = operation.id;
        context.reference({
          type: 'git-operation',
          operationId: operation.id,
          repositoryRoot: operation.repositoryRoot,
        });
        if (context.signal.aborted) cancel();
      }
      // Git reports a percentage for some phases only; nothing is invented otherwise.
      context.progress({
        percent: operation.progress?.percent ?? null,
        stage: operation.status === 'queued' ? 'Waiting for other Git operations' : null,
        message: operation.progress?.phase ?? null,
      });
    };
    const cancel = () => {
      if (operationId === null || !this.isCancellable(context.job)) return;
      try {
        this.options.cancelOperation(operationId);
      } catch {
        // Already finished.
      }
    };
    const running = this.run(payload, observe);
    // A push or pull cannot be interrupted safely; when ATLAS quits it gets a bounded
    // time to finish, then the job is reported as interrupted.
    const aborted = new Promise<'aborted'>((resolve) => {
      context.signal.addEventListener(
        'abort',
        () => {
          cancel();
          if (this.isCancellable(context.job)) return;
          setTimeout(() => resolve('aborted'), this.options.shutdownGraceMs).unref?.();
        },
        { once: true },
      );
    });
    const outcome = await Promise.race([running, aborted]);
    if (outcome === 'aborted') return { status: 'CANCELLED' };
    return gitJobResult(outcome);
  }

  async output(
    job: JobRecord,
    _attempt: number,
    after: number,
    limit: number,
  ): Promise<JobOutputPage> {
    const reference = job.executionReference;
    const finished = job.finishedAt !== null;
    if (reference?.type !== 'git-operation') {
      return { lines: [], next: after, complete: finished, truncatedBefore: false };
    }
    let details: GitOperationLogDetails;
    try {
      details = await this.options.operationDetails(reference.operationId);
    } catch {
      return { lines: [], next: after, complete: finished, truncatedBefore: false };
    }
    const lines: Omit<PreflightOutputLine, 'seq'>[] = [];
    for (const command of details.commands) {
      lines.push({ stream: 'atlas', text: `$ git ${command.args.join(' ')}` });
      for (const [stream, text] of [
        ['out', command.stdout],
        ['err', command.stderr],
      ] as const) {
        if (text === null || text === '') continue;
        if (command.truncated) lines.push({ stream: 'atlas', text: '… (earlier output dropped)' });
        for (const line of text.replace(/\r/g, '\n').split('\n')) {
          if (line.trim() !== '') lines.push({ stream, text: line });
        }
      }
      lines.push({
        stream: 'atlas',
        text: `exit ${command.exitCode ?? '—'} · ${command.outcome} · ${command.durationMs} ms`,
      });
    }
    const { operation } = details;
    if (operation.summary) lines.push({ stream: 'atlas', text: operation.summary });
    if (operation.error) lines.push({ stream: 'atlas', text: operation.error.message });
    const numbered = lines.map((line, index) => ({ ...line, seq: index + 1 }));
    const page = numbered.filter((line) => line.seq > after).slice(0, limit);
    const next = page.at(-1)?.seq ?? after;
    return {
      lines: page,
      next,
      complete: finished && next >= numbered.length,
      truncatedBefore: false,
    };
  }

  private run(payload: GitPayload, observe: (operation: GitOperation) => void) {
    switch (payload.action) {
      case 'push':
        return this.options.git.push(payload.repositoryRoot, payload.setUpstream, observe);
      case 'pull':
        return this.options.git.pull(payload.repositoryRoot, payload.mode ?? 'ff-only', observe);
      case 'fetch':
        return this.options.git.fetch(payload.repositoryRoot, payload.remote, observe);
    }
  }
}
