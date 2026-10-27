import { DEBUG_FINAL_STATUSES, type DebugSessionStatus } from '@atlas/contracts';

/** Allowed status changes of a debug session (SDD-016 Task 01 §2). */
const TRANSITIONS: Record<DebugSessionStatus, readonly DebugSessionStatus[]> = {
  CREATED: ['STARTING', 'TERMINATED', 'FAILED'],
  STARTING: ['RUNNING', 'PAUSED', 'TERMINATING', 'FAILED'],
  RUNNING: ['PAUSED', 'TERMINATING', 'FAILED'],
  PAUSED: ['RUNNING', 'TERMINATING', 'FAILED'],
  TERMINATING: ['TERMINATED', 'FAILED'],
  TERMINATED: [],
  FAILED: [],
};

export function canTransition(from: DebugSessionStatus, to: DebugSessionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isFinal(status: DebugSessionStatus): boolean {
  return DEBUG_FINAL_STATUSES.includes(status);
}
