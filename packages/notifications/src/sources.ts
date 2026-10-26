import type {
  BackgroundJob,
  CreateNotificationInput,
  GitOperation,
  GitOperationKind,
  PreflightRun,
} from '@atlas/contracts';

// What existing modules report (FR-915: Git, Preflight and background jobs). Messages are short
// summaries: command output never goes into a notification (FR-924).

/** Operations worth a notification and how they are named when they finish. */
const GIT_OUTCOMES: Partial<
  Record<GitOperationKind, { done: string; failed: string; successes: boolean }>
> = {
  commit: { done: 'Commit created', failed: 'Commit failed', successes: true },
  push: { done: 'Push completed', failed: 'Push failed', successes: true },
  pull: { done: 'Pull completed', failed: 'Pull failed', successes: true },
  // A merge only prepares the merge commit (`--no-commit`): only its stops are reported.
  merge: { done: 'Merge ready', failed: 'Merge stopped', successes: false },
  'cherry-pick': { done: 'Cherry-pick completed', failed: 'Cherry-pick stopped', successes: true },
  'continue-cherry-pick': {
    done: 'Cherry-pick completed',
    failed: 'Cherry-pick stopped',
    successes: true,
  },
  // Fetches also run in the background; only their failures are worth a notification.
  fetch: { done: 'Fetch completed', failed: 'Fetch failed', successes: false },
};

export interface NotificationSourceContext {
  projectId: string | null;
  /** Project or repository name shown with the notification. */
  sourceName: string;
}

/** The notification for a finished Git operation; null when it is not worth one. */
export function gitOperationNotification(
  operation: GitOperation,
  context: NotificationSourceContext,
): CreateNotificationInput | null {
  const outcome = GIT_OUTCOMES[operation.kind];
  if (outcome === undefined) return null;
  const base = {
    category: 'GIT' as const,
    projectId: context.projectId,
    sourceName: context.sourceName,
    taskId: operation.id,
    action: {
      type: 'git-operation' as const,
      repositoryRoot: operation.repositoryRoot,
      operationId: operation.id,
    },
  };
  if (operation.status === 'succeeded') {
    if (!outcome.successes) return null;
    return {
      ...base,
      type: 'SUCCESS',
      title: outcome.done,
      message: operation.summary ?? `${context.sourceName}: done.`,
    };
  }
  if (operation.status !== 'failed') return null;
  const conflict = operation.error?.code === 'conflict';
  return {
    ...base,
    type: conflict ? 'ACTION_REQUIRED' : 'ERROR',
    title: conflict ? `${outcome.failed}: resolve the conflicts` : outcome.failed,
    message: operation.error?.message ?? 'The operation did not complete.',
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The notification for a finished Preflight run; null for runs the user cancelled. */
export function preflightRunNotification(
  run: PreflightRun,
  context: NotificationSourceContext,
): CreateNotificationInput | null {
  if (run.status === 'RUNNING' || run.status === 'CANCELLED') return null;
  const total = run.results.length;
  const passed = run.results.filter((result) => result.status === 'PASSED').length;
  const failed = run.results.filter(
    (result) => result.status === 'FAILED' || result.status === 'TIMED_OUT',
  ).length;
  const others = total - passed - failed;
  const parts = [`${passed} of ${plural(total, 'check')} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (others > 0) parts.push(`${others} did not run`);
  const message = `${run.profileName}: ${parts.join(', ')}.`;
  const base = {
    category: 'PREFLIGHT' as const,
    projectId: context.projectId,
    sourceName: context.sourceName,
    taskId: run.id,
    message,
    action: { type: 'preflight-run' as const, workspaceId: run.workspaceId, runId: run.id },
  };
  switch (run.status) {
    case 'PASSED':
      return { ...base, type: 'SUCCESS', title: 'Preflight passed' };
    case 'FAILED':
      return { ...base, type: 'ERROR', title: 'Preflight failed' };
    case 'INCOMPLETE':
      return { ...base, type: 'WARNING', title: 'Preflight incomplete' };
  }
}

/**
 * The notification for a finished background job (SDD-012 FR-1228); null for jobs the
 * user cancelled. The message is the job's short summary, never its output.
 */
export function backgroundJobNotification(
  job: BackgroundJob,
  context: NotificationSourceContext,
): CreateNotificationInput | null {
  const base = {
    category: 'BACKGROUND_TASK' as const,
    projectId: context.projectId,
    sourceName: context.sourceName,
    taskId: job.id,
    action: { type: 'background-job' as const, jobId: job.id },
  };
  switch (job.status) {
    case 'COMPLETED':
      return { ...base, type: 'SUCCESS', title: 'Background job completed', message: job.title };
    case 'FAILED':
      return {
        ...base,
        type: 'ERROR',
        title: 'Background job failed',
        message: job.errorSummary ? `${job.title}: ${job.errorSummary}` : job.title,
      };
    case 'INTERRUPTED':
      return {
        ...base,
        type: 'WARNING',
        title: 'Background job interrupted',
        message: `${job.title}: ${job.errorSummary ?? 'it did not finish.'} Retry it if it is safe to run again.`,
      };
    default:
      return null;
  }
}
