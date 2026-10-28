import type { AuditDecisionView } from '@atlas/contracts';

/** How a finding stands after the remembered decisions (PLAN-056). */
export type FindingState = 'to-review' | 'has-task' | 'resolved' | 'deferred' | 'rejected';

export const STATE_LABELS: Record<FindingState, string> = {
  'to-review': 'To review',
  'has-task': 'Has a task',
  resolved: 'Task finished · found again',
  deferred: 'Deferred',
  rejected: 'Rejected',
};

export function findingState(view: AuditDecisionView | undefined): FindingState {
  if (view === undefined) return 'to-review';
  switch (view.decision) {
    case 'REJECTED':
      return 'rejected';
    case 'DEFERRED':
      return 'deferred';
    case 'APPROVED':
    case 'RESOLVED':
      if (view.task?.status === 'open') return 'has-task';
      // The task was finished (or removed) and the audit found the issue again.
      return view.task === null ? 'to-review' : 'resolved';
    case 'NEEDS_REVIEW':
      return 'to-review';
  }
}
