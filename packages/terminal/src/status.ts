import type { TerminalStatus } from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';

const TRANSITIONS: Record<TerminalStatus, readonly TerminalStatus[]> = {
  CREATED: ['STARTING', 'FAILED'],
  STARTING: ['RUNNING', 'FAILED'],
  RUNNING: ['EXITED', 'TERMINATING'],
  TERMINATING: ['TERMINATED'],
  EXITED: [],
  FAILED: [],
  TERMINATED: [],
};

export function canTransition(from: TerminalStatus, to: TerminalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Guards the lifecycle so a session can never be reported running after it ended. */
export function assertTransition(from: TerminalStatus, to: TerminalStatus): void {
  if (!canTransition(from, to)) {
    throw new AtlasError('INTERNAL_ERROR', `Invalid terminal transition ${from} -> ${to}.`, {
      details: { from, to },
    });
  }
}
