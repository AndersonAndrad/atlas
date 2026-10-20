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
