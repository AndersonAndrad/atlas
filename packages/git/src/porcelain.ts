import type { GitChangeCounts, GitFileChangeKind, GitLineStats } from '@atlas/contracts';

export interface ParsedStatus {
  /** Current branch, or null for detached HEAD. */
  branch: string | null;
  detachedHead: boolean;
  /** HEAD has no commit yet. */
  unbornHead: boolean;
  /** Commit HEAD points to; null when HEAD has no commit yet. */
  headOid: string | null;
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
    headOid: null,
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
      if (key === 'branch.oid') {
        result.unbornHead = value === '(initial)';
        result.headOid = result.unbornHead ? null : value;
      } else if (key === 'branch.head') {
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

export interface ParsedFileEntry {
  path: string;
  originalPath: string | null;
  staged: GitFileChangeKind | null;
  unstaged: GitFileChangeKind | null;
}

const STATUS_CODES: Record<string, GitFileChangeKind> = {
  M: 'modified',
  T: 'type-changed',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
};

/** The text after the `count`-th space; paths may themselves contain spaces. */
function afterFields(field: string, count: number): string {
  let index = -1;
  for (let i = 0; i < count; i += 1) {
    index = field.indexOf(' ', index + 1);
    if (index === -1) return '';
  }
  return field.slice(index + 1);
}

/**
 * Lists changed paths from `git status --porcelain=v2 -z`. `staged` is the index
 * against HEAD (X) and `unstaged` the working tree against the index (Y).
 */
export function parseStatusEntries(output: string): ParsedFileEntry[] {
  const entries: ParsedFileEntry[] = [];
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field === '' || field.startsWith('# ')) continue;
    const type = field[0];
    if (type === '1' || type === '2') {
      const x = field[2]!;
      const y = field[3]!;
      const entry: ParsedFileEntry = {
        path: afterFields(field, type === '1' ? 8 : 9),
        originalPath: null,
        staged: STATUS_CODES[x] ?? null,
        unstaged: STATUS_CODES[y] ?? null,
      };
      if (type === '2') {
        index += 1;
        entry.originalPath = fields[index] ?? null;
      }
      entries.push(entry);
    } else if (type === 'u') {
      entries.push({
        path: afterFields(field, 10),
        originalPath: null,
        staged: 'conflicted',
        unstaged: 'conflicted',
      });
    } else if (type === '?') {
      entries.push({
        path: field.slice(2),
        originalPath: null,
        staged: null,
        unstaged: 'untracked',
      });
    }
  }
  return entries;
}

/**
 * Parses `git diff --numstat -z`, keyed by the (new) path. Binary files report
 * `-` counts, mapped to null.
 */
export function parseNumstat(output: string): Map<string, GitLineStats> {
  const stats = new Map<string, GitLineStats>();
  const fields = output.split('\0');
  const count = (value: string) => (value === '-' ? null : Number(value));
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field === '') continue;
    const [added = '', removed = '', path = ''] = field.split('\t');
    let target = path;
    if (path === '') {
      // Renames: "<added>\t<removed>\t\0<old path>\0<new path>\0".
      target = fields[index + 2] ?? '';
      index += 2;
    }
    if (target !== '') stats.set(target, { added: count(added), removed: count(removed) });
  }
  return stats;
}

/**
 * Parses `git diff-tree --name-status -z`: "<status>\0<path>\0", or for renames and
 * copies "<R|C><score>\0<old path>\0<new path>\0".
 */
export function parseNameStatus(
  output: string,
): { path: string; originalPath: string | null; change: GitFileChangeKind }[] {
  const files: { path: string; originalPath: string | null; change: GitFileChangeKind }[] = [];
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index]!;
    if (code === '') continue;
    const change = STATUS_CODES[code[0]!] ?? 'modified';
    if (code[0] === 'R' || code[0] === 'C') {
      files.push({
        originalPath: fields[index + 1] ?? null,
        path: fields[index + 2] ?? '',
        change,
      });
      index += 2;
    } else {
      files.push({ path: fields[index + 1] ?? '', originalPath: null, change });
      index += 1;
    }
  }
  return files.filter((file) => file.path !== '');
}

export interface ParsedRef {
  /** Full ref name, e.g. `refs/heads/main`. */
  ref: string;
  current: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  upstreamGone: boolean;
  latestCommitAt: string | null;
}

/** Field separator of the `for-each-ref` format used by `REF_FORMAT`. */
export const REF_FORMAT =
  '%(refname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:iso-strict)';

/** Parses `for-each-ref --format=<REF_FORMAT>` lines. */
export function parseRefs(output: string): ParsedRef[] {
  return output
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [ref = '', head = '', upstream = '', track = '', date = ''] = line.split('\0');
      const gone = track === 'gone';
      const ahead = /ahead (\d+)/.exec(track);
      const behind = /behind (\d+)/.exec(track);
      const hasUpstream = upstream !== '' && !gone;
      return {
        ref,
        current: head === '*',
        upstream: upstream === '' ? null : upstream,
        ahead: hasUpstream ? Number(ahead?.[1] ?? 0) : null,
        behind: hasUpstream ? Number(behind?.[1] ?? 0) : null,
        upstreamGone: gone,
        latestCommitAt: date === '' ? null : new Date(date).toISOString(),
      };
    })
    .filter((entry) => entry.ref !== '');
}

/** Parses `git remote -v` into fetch and push URLs per remote. */
export function parseRemotes(
  output: string,
): { name: string; fetchUrl: string | null; pushUrl: string | null }[] {
  const remotes = new Map<
    string,
    { name: string; fetchUrl: string | null; pushUrl: string | null }
  >();
  for (const line of output.split('\n')) {
    const match = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line);
    if (!match) continue;
    const [, name = '', url = '', kind] = match;
    const remote = remotes.get(name) ?? { name, fetchUrl: null, pushUrl: null };
    if (kind === 'fetch') remote.fetchUrl = url;
    else remote.pushUrl = url;
    remotes.set(name, remote);
  }
  return [...remotes.values()];
}

/** Parses a Git progress line such as "Receiving objects:  42% (21/50)". */
export function parseProgress(line: string): { phase: string; percent: number | null } | null {
  const match = /^(?:remote: )?([A-Za-z][A-Za-z ]*?):\s+(?:(\d{1,3})%)?/.exec(line.trim());
  if (!match || /^(error|fatal|hint|warning)$/i.test(match[1]!)) return null;
  return { phase: match[1]!, percent: match[2] === undefined ? null : Number(match[2]) };
}
