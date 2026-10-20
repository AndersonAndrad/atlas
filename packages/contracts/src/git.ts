/** Counts of working tree changes. A path may appear in several counters. */
export interface GitChangeCounts {
  /** Tracked files modified in the working tree (not yet staged). */
  modified: number;
  /** Files with staged changes (index differs from HEAD). */
  staged: number;
  untracked: number;
  /** Deletions, staged or not. */
  deleted: number;
  /** Staged renames (and copies). */
  renamed: number;
  /** Files with unresolved merge conflicts. */
  conflicted: number;
  /** Distinct changed paths; each path is counted once. */
  total: number;
}

export interface GitBranchSummary {
  name: string;
  /** Committer date of the branch's latest commit (ISO 8601). */
  latestCommitAt: string | null;
}

/** Read-only view of a repository, produced without network access or mutations. */
export interface GitRepositorySnapshot {
  repositoryRoot: string;
  /** Current branch, or null for detached HEAD. */
  branch: string | null;
  detachedHead: boolean;
  /** True when HEAD has no commit yet. */
  unbornHead: boolean;
  /** Effective configuration (`git config` precedence), not the last commit's author. */
  identity: { name: string | null; email: string | null };
  localBranchCount: number;
  /** Up to three local branches ordered by their latest commit date. */
  recentBranches: GitBranchSummary[];
  changes: GitChangeCounts;
  /** Configured upstream, e.g. `origin/main`; null when none. */
  upstream: string | null;
  /** Relative to the last fetched remote-tracking state; null without upstream. */
  ahead: number | null;
  behind: number | null;
  /** True when an upstream is configured but its tracking ref does not exist. */
  upstreamGone: boolean;
  inspectedAt: string;
}

export type GitUnavailableReason =
  'not-installed' | 'timeout' | 'unsafe-ownership' | 'directory-unavailable' | 'error';

export type GitStatus =
  | { state: 'repository'; snapshot: GitRepositorySnapshot }
  | { state: 'not-repository'; inspectedAt: string }
  | { state: 'unavailable'; reason: GitUnavailableReason; inspectedAt: string };

/** Git state of a terminal, following its current working directory. */
export interface TerminalGitContext {
  directory: string;
  cwdSource: 'detected' | 'initial';
  git: GitStatus;
}

/** How a terminal relates to registered projects (for the quick details action). */
export interface TerminalProjectContext {
  /** Project the terminal is associated with. */
  associatedProjectId: string | null;
  /** Registered project whose directory contains the terminal's current directory. */
  matchedProjectId: string | null;
  directory: string;
  cwdSource: 'detected' | 'initial';
}
