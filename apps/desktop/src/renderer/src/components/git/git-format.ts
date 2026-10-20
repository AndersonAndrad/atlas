import type { GitRepositorySnapshot, GitUnavailableReason } from '@atlas/contracts';

export const GIT_UNAVAILABLE_LABELS: Record<GitUnavailableReason, string> = {
  'not-installed': 'Git is not installed or not on the PATH.',
  timeout: 'Git took too long to answer. Try refreshing.',
  'unsafe-ownership': 'Git does not trust this repository (it belongs to another user).',
  'directory-unavailable': 'The directory is not available.',
  error: 'Git information could not be read.',
};

export function branchLabel(snapshot: GitRepositorySnapshot): string {
  if (snapshot.detachedHead) return 'detached HEAD';
  return snapshot.branch ?? 'unknown';
}

export function trackingDescription(snapshot: GitRepositorySnapshot): string {
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
