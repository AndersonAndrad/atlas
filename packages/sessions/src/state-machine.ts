import {
  isFinalSessionStatus,
  type AtlasSessionStatus,
  type SessionAction,
  type SessionEventType,
  type SessionTaskStatus,
} from '@atlas/contracts';

/**
 * What causes a status change:
 * - user triggers come from desktop and CLI requests;
 * - executor triggers are reserved for execution adapters (none before SDD-004);
 * - `interrupt` is applied by the Engine when work in flight was lost.
 */
export type SessionTrigger =
  | 'markReady'
  | 'returnToDraft'
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'run'
  | 'requestApproval'
  | 'approve'
  | 'complete'
  | 'fail'
  | 'interrupt';

/** Target of a trigger that depends on whether an executor can take the session. */
type Target = AtlasSessionStatus | 'EXECUTE';

const TRANSITIONS: Record<AtlasSessionStatus, Partial<Record<SessionTrigger, Target>>> = {
  DRAFT: { markReady: 'READY', cancel: 'CANCELLED' },
  READY: { returnToDraft: 'DRAFT', start: 'EXECUTE', cancel: 'CANCELLED' },
  WAITING_EXECUTOR: { pause: 'PAUSED', cancel: 'CANCELLED', run: 'RUNNING' },
  RUNNING: {
    pause: 'PAUSED',
    requestApproval: 'WAITING_APPROVAL',
    complete: 'COMPLETED',
    fail: 'FAILED',
    cancel: 'CANCELLED',
    interrupt: 'INTERRUPTED',
  },
  WAITING_APPROVAL: {
    approve: 'RUNNING',
    fail: 'FAILED',
    cancel: 'CANCELLED',
    interrupt: 'INTERRUPTED',
  },
  PAUSED: { resume: 'EXECUTE', cancel: 'CANCELLED' },
  INTERRUPTED: { resume: 'EXECUTE', cancel: 'CANCELLED' },
  COMPLETED: {},
  FAILED: {},
  CANCELLED: {},
};

export interface TransitionContext {
  /** Whether an execution adapter can take the session right now. */
  executorAvailable: boolean;
}

/**
 * Returns the status a trigger leads to, or `null` when the trigger is not valid
 * in `status`. Without an executor a started session waits for one instead of
 * pretending to run.
 */
export function nextSessionStatus(
  status: AtlasSessionStatus,
  trigger: SessionTrigger,
  context: TransitionContext,
): AtlasSessionStatus | null {
  const target = TRANSITIONS[status][trigger];
  if (target === undefined) return null;
  if (target !== 'EXECUTE') return target;
  return context.executorAvailable ? 'RUNNING' : 'WAITING_EXECUTOR';
}

const USER_TRIGGERS: readonly SessionTrigger[] = [
  'markReady',
  'returnToDraft',
  'start',
  'pause',
  'resume',
  'cancel',
];

/** Lifecycle actions a user may request in `status`. */
export function availableSessionActions(
  status: AtlasSessionStatus,
  archived: boolean,
  context: TransitionContext,
): SessionAction[] {
  const actions: SessionAction[] = USER_TRIGGERS.filter(
    (trigger) => nextSessionStatus(status, trigger, context) !== null,
  ) as SessionAction[];
  if (canArchive(status, archived)) actions.push('archive');
  return actions;
}

export function canArchive(status: AtlasSessionStatus, archived: boolean): boolean {
  return !archived && isFinalSessionStatus(status);
}

/** Tasks can be planned until the session ends. */
export function tasksEditable(status: AtlasSessionStatus, archived: boolean): boolean {
  return !archived && !isFinalSessionStatus(status);
}

/** Event recorded when a session enters `to` through `trigger`. */
export function transitionEventType(
  trigger: SessionTrigger,
  to: AtlasSessionStatus,
): SessionEventType {
  if (trigger === 'resume') return 'SESSION_RESUMED';
  switch (to) {
    case 'DRAFT':
      return 'SESSION_RETURNED_TO_DRAFT';
    case 'READY':
      return 'SESSION_READY';
    case 'WAITING_EXECUTOR':
      return 'SESSION_WAITING_EXECUTOR';
    case 'RUNNING':
      return trigger === 'approve' ? 'SESSION_RESUMED' : 'SESSION_STARTED';
    case 'PAUSED':
      return 'SESSION_PAUSED';
    case 'WAITING_APPROVAL':
      return 'APPROVAL_REQUESTED';
    case 'COMPLETED':
      return 'SESSION_COMPLETED';
    case 'FAILED':
      return 'SESSION_FAILED';
    case 'CANCELLED':
      return 'SESSION_CANCELLED';
    case 'INTERRUPTED':
      return 'SESSION_INTERRUPTED';
  }
}

const TASK_TRANSITIONS: Record<SessionTaskStatus, readonly SessionTaskStatus[]> = {
  PENDING: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  INTERRUPTED: ['PENDING', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionTask(from: SessionTaskStatus, to: SessionTaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function isFinalTaskStatus(status: SessionTaskStatus): boolean {
  return TASK_TRANSITIONS[status].length === 0;
}
