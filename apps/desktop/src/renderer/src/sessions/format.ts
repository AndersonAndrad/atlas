import {
  EXECUTION_PROFILE_DEFINITIONS,
  type AtlasSessionStatus,
  type ExecutionProfile,
  type SessionAction,
  type SessionEvent,
  type SessionEventType,
  type SessionTaskStatus,
} from '@atlas/contracts';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const SESSION_STATUS: Record<AtlasSessionStatus, { label: string; tone: StatusTone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  READY: { label: 'Ready', tone: 'info' },
  WAITING_EXECUTOR: { label: 'Waiting for executor', tone: 'warning' },
  RUNNING: { label: 'Running', tone: 'success' },
  PAUSED: { label: 'Paused', tone: 'neutral' },
  WAITING_APPROVAL: { label: 'Waiting for approval', tone: 'warning' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  INTERRUPTED: { label: 'Interrupted', tone: 'danger' },
};

export const TASK_STATUS: Record<SessionTaskStatus, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  INTERRUPTED: 'Interrupted',
};

export function profileLabel(profile: ExecutionProfile): string {
  return EXECUTION_PROFILE_DEFINITIONS.find((item) => item.id === profile)?.label ?? profile;
}

export const ACTION_LABELS: Record<SessionAction, string> = {
  markReady: 'Mark ready',
  returnToDraft: 'Back to draft',
  start: 'Start',
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel session',
  archive: 'Archive',
};

const EVENT_LABELS: Record<SessionEventType, string> = {
  SESSION_CREATED: 'Session created',
  SESSION_UPDATED: 'Session edited',
  SESSION_READY: 'Marked ready',
  SESSION_RETURNED_TO_DRAFT: 'Returned to draft',
  SESSION_WAITING_EXECUTOR: 'Started — waiting for an executor',
  SESSION_STARTED: 'Execution started',
  SESSION_PAUSED: 'Paused',
  SESSION_RESUMED: 'Resumed',
  SESSION_CANCELLED: 'Cancelled',
  SESSION_INTERRUPTED: 'Interrupted',
  SESSION_COMPLETED: 'Completed',
  SESSION_FAILED: 'Failed',
  SESSION_ARCHIVED: 'Archived',
  SESSION_PROJECT_DETACHED: 'Project removed — kept its directory',
  TASK_CREATED: 'Task added',
  TASK_UPDATED: 'Task edited',
  TASK_REMOVED: 'Task removed',
  TASK_CANCELLED: 'Task cancelled',
  APPROVAL_REQUESTED: 'Approval requested',
};

const REASON_LABELS: Record<NonNullable<SessionEvent['metadata']['reason']>, string> = {
  'engine-restart': 'the Engine restarted while work was in progress',
  'engine-shutdown': 'ATLAS stopped while work was in progress',
  'project-removed': 'the project was removed from the registry',
};

/** Human-readable description of an event, built only from structured metadata. */
export function describeEvent(event: SessionEvent, taskTitle: (id: string) => string | null) {
  const { metadata } = event;
  const details: string[] = [];
  if (metadata.from !== undefined && metadata.to !== undefined) {
    details.push(`${SESSION_STATUS[metadata.from].label} → ${SESSION_STATUS[metadata.to].label}`);
  }
  if (metadata.taskId !== undefined) {
    details.push(taskTitle(metadata.taskId) ?? 'removed task');
  }
  if (metadata.fields !== undefined && metadata.fields.length > 0) {
    details.push(`changed: ${metadata.fields.join(', ')}`);
  }
  if (metadata.reason !== undefined) details.push(REASON_LABELS[metadata.reason]);
  if (metadata.taskCount !== undefined && metadata.taskCount > 0) {
    details.push(`${metadata.taskCount} task${metadata.taskCount === 1 ? '' : 's'} affected`);
  }
  return { title: EVENT_LABELS[event.type], details: details.join(' · ') };
}

/** Splits a multi-line field into trimmed, non-empty entries. */
export function parseLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
