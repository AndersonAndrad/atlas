import type { AvailabilityStatus, GitInspection } from '@atlas/contracts';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatDate(value: string | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : dateFormatter.format(date);
}

export const AVAILABILITY_LABELS: Record<AvailabilityStatus, string> = {
  available: 'Available',
  missing: 'Unavailable — directory not found or not reachable',
  'not-a-directory': 'Unavailable — not a directory',
  'permission-denied': 'Unavailable — permission denied',
};

export const AVAILABILITY_SHORT: Record<AvailabilityStatus, string> = {
  available: 'Available',
  missing: 'Unavailable',
  'not-a-directory': 'Unavailable',
  'permission-denied': 'No access',
};

export function gitSummary(git: GitInspection, storedIsRepository: boolean): string {
  if (git.isRepository) {
    if (git.branch) return git.branch;
    return git.detached ? 'Detached HEAD' : 'Git repository';
  }
  return storedIsRepository ? 'Git (not reachable)' : 'No Git';
}

/** Splits a comma-separated tag field into individual tags. */
export function parseTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}
