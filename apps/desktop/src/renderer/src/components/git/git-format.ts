import type {
  GitRepositorySnapshot,
  GitUnavailableReason,
  ProjectGitState,
} from '@atlas/contracts';
import { plural } from '../../git/format';

export const GIT_UNAVAILABLE_LABELS: Record<GitUnavailableReason, string> = {
  'not-installed': 'Git is not installed or not on the PATH.',
  timeout: 'Git took too long to answer. Try refreshing.',
  'unsafe-ownership': 'Git does not trust this repository (it belongs to another user).',
  'directory-unavailable': 'The directory is not available.',
  error: 'Git information could not be read.',
};

/** Branch and upstream fields shared by live snapshots and stored project snapshots. */
type GitTracking = Pick<
  GitRepositorySnapshot,
  'branch' | 'detachedHead' | 'upstream' | 'upstreamGone' | 'ahead' | 'behind' | 'changes'
>;

export function branchLabel(snapshot: Pick<GitTracking, 'branch' | 'detachedHead'>): string {
  if (snapshot.detachedHead) return 'detached HEAD';
  return snapshot.branch ?? 'unknown';
}

export function trackingDescription(
  snapshot: Pick<GitTracking, 'upstream' | 'upstreamGone'>,
): string {
  if (snapshot.upstream === null) return 'No upstream branch is configured.';
  if (snapshot.upstreamGone) return `The upstream ${snapshot.upstream} no longer exists.`;
  return `Compared with ${snapshot.upstream} as of the last fetch. ATLAS never fetches.`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 hours ago" style label for a timestamp. */
export function relativeTime(value: string | null): string {
  if (value === null) return 'unknown';
  const seconds = (new Date(value).getTime() - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(Math.round(seconds), 'second');
}

/** Things waiting in a repository: changed files, commits to push and to pull. */
export function pendingGitActions(
  snapshot: Pick<GitTracking, 'changes' | 'ahead' | 'behind'>,
): string[] {
  const reasons: string[] = [];
  const { total } = snapshot.changes;
  if (total > 0) reasons.push(`${plural(total, 'changed file')} to commit`);
  if (snapshot.ahead !== null && snapshot.ahead > 0) {
    reasons.push(`${plural(snapshot.ahead, 'commit')} to push`);
  }
  if (snapshot.behind !== null && snapshot.behind > 0) {
    reasons.push(`${plural(snapshot.behind, 'commit')} to pull`);
  }
  return reasons;
}

export type ProjectGitIndicatorKind = 'attention' | 'clean' | 'unknown';

export interface ProjectGitIndicator {
  kind: ProjectGitIndicatorKind;
  /** Shown as live data: monitored and refreshed successfully since ATLAS started. */
  live: boolean;
  /** Changed files, when known. */
  changes: number | null;
  /** Full description for tooltips and screen readers (never color alone). */
  description: string;
}

/**
 * Badge of a project's stored Git state (SDD-024 FR-006). Attention means something to
 * commit or to push; commits to pull are reported separately and are not a required action.
 */
export function projectGitIndicator(state: ProjectGitState | undefined): ProjectGitIndicator {
  const live = state?.freshness === 'live';
  const freshness =
    state === undefined || state.refreshedAt === null
      ? ''
      : ` ${live ? 'Live' : 'Cached'}, updated ${relativeTime(state.refreshedAt)}.`;
  const failure =
    state?.error != null
      ? ` Last refresh failed: ${GIT_UNAVAILABLE_LABELS[state.error.reason]}`
      : '';
  const paused = state !== undefined && !state.monitoringEnabled ? ' Monitoring paused.' : '';
  const snapshot = state?.snapshot ?? null;

  if (snapshot === null || snapshot.state === 'not-repository') {
    const what =
      snapshot?.state === 'not-repository'
        ? 'No Git repository.'
        : state?.error != null
          ? 'Git status unavailable.'
          : 'Git status unknown: not refreshed yet.';
    return {
      kind: 'unknown',
      live: false,
      changes: null,
      description: `${what}${freshness}${failure}${paused}`.trim(),
    };
  }
  const pending = pendingGitActions({ ...snapshot, behind: null });
  const attention = pending.length > 0;
  const summary = attention
    ? `Needs attention: ${pending.join(', ')}.`
    : 'Clean, nothing to commit or push.';
  return {
    kind: attention ? 'attention' : 'clean',
    live,
    changes: snapshot.changes.total,
    description: `${summary} Branch ${branchLabel(snapshot)}.${freshness}${failure}${paused}`,
  };
}
