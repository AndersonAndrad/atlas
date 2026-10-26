import type { JobPayload, PreflightRun } from '@atlas/contracts';
import type {
  CreateJobRequest,
  JobExecutionContext,
  JobExecutionResult,
  JobExecutor,
  JobRecord,
  PreparedJob,
} from '@atlas/jobs';
import type { PreflightService } from '@atlas/preflight';
import { AtlasError } from '@atlas/shared';

/** How often the run is read for the job's progress. */
const PROGRESS_POLL_MS = 1000;

type PreflightPayload = Extract<JobPayload, { type: 'PREFLIGHT' }>;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The job's outcome; only a passed run completes it (FR-1224). */
export function preflightJobResult(run: PreflightRun): JobExecutionResult {
  const failed = run.results.filter(
    (result) => result.status === 'FAILED' || result.status === 'TIMED_OUT',
  ).length;
  switch (run.status) {
    case 'PASSED':
      return { status: 'COMPLETED' };
    case 'FAILED':
      return { status: 'FAILED', errorSummary: `${plural(failed, 'check')} failed.` };
    case 'INCOMPLETE':
      return { status: 'FAILED', errorSummary: 'Some checks did not run, so it is incomplete.' };
    case 'CANCELLED':
      return { status: 'CANCELLED', errorSummary: 'The Preflight run was cancelled.' };
    case 'RUNNING':
      return { status: 'FAILED', errorSummary: 'The Preflight run did not finish.' };
  }
}

/**
 * Runs a Preflight profile or selection as a background job (SDD-012 FR-1224) through
 * the existing Preflight service: same authorizations, logs, history and notification.
 * Checks need the authorizations the user gave when queueing; a retry gives none, so
 * checks that ask for authorization on every run fail it instead of running unattended.
 */
export class PreflightJobExecutor implements JobExecutor {
  readonly type = 'PREFLIGHT' as const;
  readonly cancellable = true;
  /** Preflight publishes the run's notification itself. */
  readonly notifiesOutcome = true;

  constructor(private readonly preflight: PreflightService) {}

  async prepare(request: CreateJobRequest): Promise<PreparedJob> {
    if (request.type !== 'PREFLIGHT') throw new AtlasError('VALIDATION_FAILED');
    const { authorizations, ...selection } = request.selection;
    const details = await this.preflight.workspace(selection.workspaceId);
    const planned = await this.preflight.plan(selection);
    const granted = new Map(authorizations.map((item) => [item.checkId, item.digest]));
    const missing = planned.checks.filter(
      (check) => check.authorization !== null && granted.get(check.checkId) !== check.digest,
    );
    if (missing.length > 0) {
      throw new AtlasError('PREFLIGHT_AUTHORIZATION_REQUIRED', undefined, {
        issues: missing.map((check) => ({
          field: `authorizations.${check.checkId}`,
          message: 'Review and authorize this check.',
        })),
      });
    }
    const profile =
      selection.profileId === null
        ? null
        : details.config.profiles.find((item) => item.id === selection.profileId);
    return {
      title: `Preflight: ${profile?.name ?? `${plural(planned.checks.length, 'check')}`}`,
      description: details.workspace.name,
      projectId: details.workspace.projectId,
      workspacePath: details.workspace.path,
      payload: {
        type: 'PREFLIGHT',
        workspaceId: selection.workspaceId,
        profileId: selection.profileId,
        checkIds: selection.checkIds,
        ...(selection.concurrency === undefined ? {} : { concurrency: selection.concurrency }),
        authorizations,
      },
    };
  }

  /** One run per workspace: jobs of the same workspace wait for each other. */
  resourceKey(job: JobRecord): string | null {
    return job.payload.type === 'PREFLIGHT' ? `preflight:${job.payload.workspaceId}` : null;
  }

  /** A run started from Preflight itself holds the workspace too. */
  isReady(job: JobRecord): boolean {
    return job.payload.type !== 'PREFLIGHT' || !this.preflight.isRunning(job.payload.workspaceId);
  }

  retryPayload(payload: JobPayload): JobPayload {
    return payload.type === 'PREFLIGHT' ? { ...payload, authorizations: [] } : payload;
  }

  async execute(context: JobExecutionContext): Promise<JobExecutionResult> {
    const payload = context.job.payload as PreflightPayload;
    if (context.signal.aborted) return { status: 'CANCELLED' };
    const run = await this.preflight.start({
      workspaceId: payload.workspaceId,
      profileId: payload.profileId,
      checkIds: payload.checkIds,
      ...(payload.concurrency === undefined ? {} : { concurrency: payload.concurrency }),
      authorizations: payload.authorizations,
    });
    context.reference({ type: 'preflight-run', workspaceId: run.workspaceId, runId: run.id });
    const cancel = () => void this.preflight.cancel(run.id).catch(() => undefined);
    context.signal.addEventListener('abort', cancel, { once: true });
    const report = async () => {
      try {
        const current = await this.preflight.run(run.id);
        const total = current.results.length;
        const done = current.results.filter(
          (result) => result.status !== 'PENDING' && result.status !== 'RUNNING',
        ).length;
        const running = current.results.filter((result) => result.status === 'RUNNING');
        context.progress({
          percent: total === 0 ? null : (done / total) * 100,
          stage: `${done} of ${plural(total, 'check')} finished`,
          message: running.length === 0 ? null : `Running ${running.map((r) => r.name).join(', ')}`,
        });
      } catch {
        // Progress is informative; the outcome comes from `settled`.
      }
    };
    void report();
    const timer = setInterval(() => void report(), PROGRESS_POLL_MS);
    try {
      return preflightJobResult(await this.preflight.settled(run.id));
    } finally {
      clearInterval(timer);
      context.signal.removeEventListener('abort', cancel);
    }
  }
}
