import type { BackgroundJob, JobPriority, JobStatus, JobType } from '@atlas/contracts';

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  WAITING_APPROVAL: 'Waiting for approval',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  INTERRUPTED: 'Interrupted',
};

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  COMMAND: 'Command',
  GIT: 'Git',
  PREFLIGHT: 'Preflight',
  AGENT: 'Agent',
  ATLAS_SESSION: 'Session',
  INTEGRATION: 'Integration',
};

export const JOB_PRIORITY_LABELS: Record<JobPriority, string> = {
  HIGH: 'High',
  NORMAL: 'Normal',
  LOW: 'Low',
};

const STATUS_CLASSES: Record<JobStatus, string> = {
  QUEUED: 'text-muted-foreground',
  RUNNING: 'text-primary',
  WAITING_APPROVAL: 'text-warning',
  COMPLETED: 'text-success',
  FAILED: 'text-destructive',
  CANCELLED: 'text-muted-foreground',
  INTERRUPTED: 'text-warning',
};

export function jobStatusClass(status: JobStatus): string {
  return STATUS_CLASSES[status];
}

/** How long the job ran, or has been running at `now`; null before it started. */
export function jobDuration(job: Pick<BackgroundJob, 'startedAt' | 'finishedAt'>, now: number) {
  if (job.startedAt === null) return null;
  const end = job.finishedAt === null ? now : Date.parse(job.finishedAt);
  return Math.max(0, end - Date.parse(job.startedAt));
}

/** "Running 2 of 5 checks · 40 %", or what the job last said. */
export function jobProgressText(job: BackgroundJob): string | null {
  const parts = [job.progress.stage, job.progress.message].filter(
    (part): part is string => part !== null && part !== '',
  );
  if (job.progress.percent !== null) parts.push(`${job.progress.percent} %`);
  return parts.length === 0 ? null : parts.join(' · ');
}
