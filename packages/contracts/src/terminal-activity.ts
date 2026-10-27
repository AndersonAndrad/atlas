import { isFinalTerminalStatus, type TerminalStatus } from './terminal.js';

// ---------------------------------------------------------------------------
// Terminal activity status (SDD-023 Task A02)
// ---------------------------------------------------------------------------

/**
 * `RUNNING`: started and not finished. `ATTENTION_REQUIRED`: finished successfully, waiting
 * for the user's review. `FAILED`: finished with an error. `INTERRUPTED`: its terminal or
 * ATLAS stopped before it reported its end.
 */
export const TERMINAL_ACTIVITY_STATES = [
  'RUNNING',
  'ATTENTION_REQUIRED',
  'FAILED',
  'INTERRUPTED',
] as const;
export type TerminalActivityState = (typeof TERMINAL_ACTIVITY_STATES)[number];

/**
 * A tracked operation in a terminal. Only operations that report their own start and end
 * are tracked: today the Claude Code and Codex wrappers. Shell commands are not.
 */
export interface TerminalActivity {
  terminalId: string;
  kind: 'ai';
  provider: 'claude' | 'codex';
  /** The operation's own id (the wrapper's run). */
  ref: string;
  state: TerminalActivityState;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  /** Set only by an explicit "Mark as reviewed". */
  acknowledgedAt: string | null;
  /** The shared-context session recording it, when the project keeps one. */
  contextSessionId: string | null;
}

/** Running and unreviewed activities of a terminal, plus its last reviewed one. */
export interface TerminalActivitySummary {
  terminalId: string;
  /** Running or finished and not reviewed, oldest first. */
  activities: TerminalActivity[];
  /** The most recently reviewed activity, when it is newer than every other activity. */
  reviewed: TerminalActivity | null;
}

/** What a terminal tab shows, by precedence (FR-005). */
export const TERMINAL_INDICATORS = [
  'DISCONNECTED',
  'FAILED',
  'ATTENTION_REQUIRED',
  'AI_RUNNING',
  'REVIEWED',
  'IDLE',
] as const;
export type TerminalIndicator = (typeof TERMINAL_INDICATORS)[number];

/**
 * The tab status, highest precedence first (FR-005): a disconnected terminal, then any failed
 * activity, any result waiting for review, a running AI, a reviewed result, then idle. A live
 * PTY alone is IDLE; green (REVIEWED) only follows an explicit review. Results still waiting
 * for review on a disconnected terminal are reported by `hasPendingReview`.
 */
export function terminalIndicator(
  status: TerminalStatus,
  summary: TerminalActivitySummary | undefined,
): TerminalIndicator {
  if (isFinalTerminalStatus(status) || status === 'TERMINATING') return 'DISCONNECTED';
  const activities = summary?.activities ?? [];
  if (activities.some((item) => item.state === 'FAILED')) return 'FAILED';
  if (
    activities.some((item) => item.state === 'ATTENTION_REQUIRED' || item.state === 'INTERRUPTED')
  ) {
    return 'ATTENTION_REQUIRED';
  }
  if (activities.some((item) => item.state === 'RUNNING')) return 'AI_RUNNING';
  if (summary?.reviewed != null) return 'REVIEWED';
  return 'IDLE';
}

/** Whether "Mark as reviewed" has something to acknowledge. */
export function hasPendingReview(summary: TerminalActivitySummary | undefined): boolean {
  return (summary?.activities ?? []).some((item) => item.state !== 'RUNNING');
}
