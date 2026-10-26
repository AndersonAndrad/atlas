import type { JobStatus } from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';

/**
 * Allowed job status changes (FR-1202). Final statuses only leave through a manual
 * retry, which queues the job again; a completed job is never retried.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  QUEUED: ['RUNNING', 'CANCELLED', 'INTERRUPTED'],
  RUNNING: ['WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  WAITING_APPROVAL: ['RUNNING', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  COMPLETED: [],
  FAILED: ['QUEUED'],
  CANCELLED: ['QUEUED'],
  INTERRUPTED: ['QUEUED'],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** Throws JOB_TRANSITION_INVALID when the change is not allowed. */
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new AtlasError('JOB_TRANSITION_INVALID', `A ${from} job cannot become ${to}.`, {
      details: { from, to },
    });
  }
}
