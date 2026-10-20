import type { TerminalSession, TerminalStatus } from '@atlas/contracts';

export const STATUS_LABELS: Record<TerminalStatus, string> = {
  CREATED: 'Starting',
  STARTING: 'Starting',
  RUNNING: 'Running',
  EXITED: 'Exited',
  FAILED: 'Failed',
  TERMINATING: 'Terminating',
  TERMINATED: 'Terminated',
};

/** One-line explanation of why a session is no longer running. */
export function endedSummary(session: TerminalSession): string {
  switch (session.endReason) {
    case 'startup-failed':
      return session.failureMessage ?? 'The shell could not be started.';
    case 'engine-lost':
    case 'engine-shutdown':
      return 'This terminal ended when ATLAS stopped. Restart it to open a new shell.';
    case 'user':
      return 'Terminated.';
    default:
      if (session.signal !== undefined) return `Process ended by signal ${session.signal}.`;
      return `Process exited with code ${session.exitCode ?? 'unknown'}.`;
  }
}
