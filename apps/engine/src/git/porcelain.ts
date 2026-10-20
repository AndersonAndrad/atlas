import type { GitChangeCounts } from '@atlas/contracts';

export interface ParsedStatus {
  /** Current branch, or null for detached HEAD. */
  branch: string | null;
  detachedHead: boolean;
  /** HEAD has no commit yet. */
  unbornHead: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** Upstream configured but its remote-tracking ref is missing. */
  upstreamGone: boolean;
  changes: GitChangeCounts;
}

/**
 * Parses `git status --porcelain=v2 --branch -z`. Each changed path is one entry;
 * counters may overlap (a file can be staged and modified), `total` never does.
 */
export function parseStatusV2(output: string): ParsedStatus {
  const result: ParsedStatus = {
    branch: null,
    detachedHead: false,
    unbornHead: false,
    upstream: null,
    ahead: null,
    behind: null,
    upstreamGone: false,
    changes: {
      modified: 0,
      staged: 0,
      untracked: 0,
      deleted: 0,
      renamed: 0,
      conflicted: 0,
      total: 0,
    },
  };
  let hasAheadBehind = false;
  const fields = output.split('\0');

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field === '') continue;

    if (field.startsWith('# ')) {
      const [key, ...rest] = field.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') result.unbornHead = value === '(initial)';
      else if (key === 'branch.head') {
        result.detachedHead = value === '(detached)';
        result.branch = result.detachedHead ? null : value;
      } else if (key === 'branch.upstream') result.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          result.ahead = Number(match[1]);
          result.behind = Number(match[2]);
          hasAheadBehind = true;
        }
      }
      continue;
    }

    const type = field[0];
    const changes = result.changes;
    if (type === '1' || type === '2') {
      const x = field[2]!;
      const y = field[3]!;
      changes.total += 1;
      if (x !== '.') changes.staged += 1;
      if (y === 'M' || y === 'T') changes.modified += 1;
      if (x === 'D' || y === 'D') changes.deleted += 1;
      if (type === '2') {
        changes.renamed += 1;
        index += 1; // The original path follows as its own NUL-terminated field.
      }
    } else if (type === 'u') {
      changes.total += 1;
      changes.conflicted += 1;
    } else if (type === '?') {
      changes.total += 1;
      changes.untracked += 1;
    }
  }

  result.upstreamGone = result.upstream !== null && !hasAheadBehind;
  return result;
}

export interface ParsedBranch {
  name: string;
  latestCommitAt: string | null;
}

/** Parses `for-each-ref --format=%(refname:short)%00%(committerdate:iso-strict)` lines. */
export function parseBranches(output: string): ParsedBranch[] {
  return output
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [name = '', date = ''] = line.split('\0');
      return { name, latestCommitAt: date === '' ? null : new Date(date).toISOString() };
    })
    .filter((branch) => branch.name !== '');
}
