import type {
  GitFileChange,
  GitFileChangeKind,
  GitLineStats,
  GitOperation,
  GitOperationKind,
} from '@atlas/contracts';

export const CHANGE_LABELS: Record<GitFileChangeKind, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  'type-changed': 'Type changed',
  untracked: 'Untracked',
  conflicted: 'Conflicted',
};

/** One-letter code shown next to a file, as in `git status --short`. */
export const CHANGE_LETTERS: Record<GitFileChangeKind, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  'type-changed': 'T',
  untracked: 'U',
  conflicted: '!',
};

export const CHANGE_TONES: Record<GitFileChangeKind, string> = {
  added: 'text-success',
  untracked: 'text-success',
  modified: 'text-warning',
  'type-changed': 'text-warning',
  renamed: 'text-sky-400',
  copied: 'text-sky-400',
  deleted: 'text-destructive',
  conflicted: 'text-destructive',
};

export const OPERATION_LABELS: Record<GitOperationKind, string> = {
  stage: 'Stage',
  unstage: 'Unstage',
  commit: 'Commit',
  push: 'Push',
  pull: 'Pull',
  fetch: 'Fetch',
  'create-branch': 'Create branch',
  'switch-branch': 'Switch branch',
  'rename-branch': 'Rename branch',
  merge: 'Merge',
  'abort-merge': 'Abort merge',
};

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function directoryName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** True when the file has both staged and unstaged changes. */
export function isPartiallyStaged(file: GitFileChange): boolean {
  return file.staged !== null && file.unstaged !== null && file.staged !== 'conflicted';
}

export function sumStats(...stats: (GitLineStats | null)[]): GitLineStats {
  let added: number | null = 0;
  let removed: number | null = 0;
  for (const value of stats) {
    if (value === null) continue;
    added = added === null || value.added === null ? null : added + value.added;
    removed = removed === null || value.removed === null ? null : removed + value.removed;
  }
  return { added, removed };
}

export function isActive(operation: GitOperation): boolean {
  return operation.status === 'queued' || operation.status === 'running';
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Review state: a file is reviewed when all of its changes are approved (staged).
 * Conflicted files are excluded until they are resolved.
 */
export function reviewProgress(files: GitFileChange[]): { reviewed: number; total: number } {
  const reviewable = files.filter((file) => file.staged !== 'conflicted');
  return {
    reviewed: reviewable.filter((file) => file.staged !== null && file.unstaged === null).length,
    total: reviewable.length,
  };
}

/** The next file still to review after `path`, in list order (wrapping around). */
export function nextToReview(files: GitFileChange[], path: string): string | null {
  const pending = files.filter((file) => file.unstaged !== null && file.staged !== 'conflicted');
  if (pending.length === 0) return null;
  const index = files.findIndex((file) => file.path === path);
  const after = pending.find((file) => files.indexOf(file) > index && file.path !== path);
  return (after ?? pending.find((file) => file.path !== path))?.path ?? null;
}

/**
 * A submitted commit: the operations that already existed and when it was submitted. The commit
 * request only answers once the commit finished, so the operation shown live is the first commit
 * operation started afterwards that is not among the known ones; an older operation that arrives
 * late (e.g. while the history was still loading) is never taken for it.
 */
export interface CommitSubmission {
  known: ReadonlySet<string>;
  at: number;
}

/** Called when the commit is submitted, never while rendering. */
export function commitSubmission(operations: GitOperation[], now = Date.now()): CommitSubmission {
  return { known: new Set(operations.map((operation) => operation.id)), at: now };
}

/**
 * The commit operation started by `submission`, once it appears among `operations` (newest
 * first, as `useGitOperations` returns them).
 */
export function submittedCommit(
  operations: GitOperation[],
  submission: CommitSubmission | null,
): GitOperation | undefined {
  if (submission === null) return undefined;
  return operations.findLast(
    (operation) =>
      operation.kind === 'commit' &&
      !submission.known.has(operation.id) &&
      Date.parse(operation.startedAt) >= submission.at,
  );
}

/** Shown while the stored Git preferences cannot be read; the Engine refuses commits. */
export const INVALID_PREFERENCES_MESSAGE =
  'Stored Git preferences are invalid; save to replace them.';
