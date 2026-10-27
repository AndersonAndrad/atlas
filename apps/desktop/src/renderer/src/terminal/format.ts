import type {
  TerminalActivity,
  TerminalActivitySummary,
  TerminalIndicator,
  TerminalSession,
  TerminalStatus,
} from '@atlas/contracts';

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

const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' } as const;

const ago = (value: string | null) => {
  if (value === null) return '';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  return minutes < 1 ? ' just now' : ` ${minutes} min ago`;
};

/** One line per tracked activity, for tooltips and screen readers (SDD-023 A02). */
export function activityLine(activity: TerminalActivity): string {
  const name = PROVIDER_NAMES[activity.provider];
  switch (activity.state) {
    case 'RUNNING':
      return `${name} is running`;
    case 'ATTENTION_REQUIRED':
      return `${name} finished${ago(activity.finishedAt)}, review pending`;
    case 'FAILED':
      return `${name} failed${activity.exitCode === null ? '' : ` (exit ${activity.exitCode})`}${ago(activity.finishedAt)}`;
    case 'INTERRUPTED':
      return `${name} was interrupted before it finished, review pending`;
  }
}

export const INDICATOR_LABELS: Record<TerminalIndicator, string> = {
  DISCONNECTED: 'Disconnected',
  FAILED: 'Failed',
  ATTENTION_REQUIRED: 'Needs attention',
  AI_RUNNING: 'AI running',
  REVIEWED: 'Reviewed',
  IDLE: 'Idle',
};

/** Full description of a tab's status: the indicator, then each tracked activity. */
export function indicatorDescription(
  indicator: TerminalIndicator,
  summary: TerminalActivitySummary | undefined,
): string {
  const lines = (summary?.activities ?? []).map(activityLine);
  if (indicator === 'REVIEWED' && summary?.reviewed) {
    lines.push(`${PROVIDER_NAMES[summary.reviewed.provider]} result reviewed`);
  }
  return [INDICATOR_LABELS[indicator], ...lines].join(' · ');
}
