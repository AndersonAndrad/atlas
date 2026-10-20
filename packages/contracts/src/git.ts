import { z } from 'zod';

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

// ---------------------------------------------------------------------------
// Git workspace (SDD-004 Milestone A)
// ---------------------------------------------------------------------------

export const GIT_FILE_CHANGE_KINDS = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type-changed',
  'untracked',
  'conflicted',
] as const;
export type GitFileChangeKind = (typeof GIT_FILE_CHANGE_KINDS)[number];

/** Line counts; `null` when the file is binary or the count is unknown. */
export interface GitLineStats {
  added: number | null;
  removed: number | null;
}

/**
 * One changed path. `staged` compares the index with HEAD and `unstaged` the
 * working tree with the index, so a partially staged file has both.
 */
export interface GitFileChange {
  path: string;
  /** Source path of a rename or copy. */
  originalPath: string | null;
  staged: GitFileChangeKind | null;
  unstaged: GitFileChangeKind | null;
  stagedStats: GitLineStats | null;
  unstagedStats: GitLineStats | null;
}

export type GitInProgressOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** Detailed working tree state used by the Git panel and the commit dialog. */
export interface GitWorkingTree {
  repositoryRoot: string;
  repositoryName: string;
  branch: string | null;
  detachedHead: boolean;
  unbornHead: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  upstreamGone: boolean;
  identity: { name: string | null; email: string | null };
  /** Modification time of FETCH_HEAD; null when the repository was never fetched. */
  lastFetchAt: string | null;
  inProgress: GitInProgressOperation | null;
  files: GitFileChange[];
  /** True when more changed paths exist than were listed. */
  truncated: boolean;
  /**
   * Identifies HEAD and the staged content. A commit is refused when it changed
   * since the user reviewed the selection.
   */
  indexFingerprint: string;
  inspectedAt: string;
}

/** A repository the Engine resolved from a registered project or an open terminal. */
export interface GitRepositoryEntry {
  repositoryRoot: string;
  name: string;
  projectIds: string[];
  terminalIds: string[];
}

export type GitDiffArea = 'staged' | 'unstaged';

export interface GitFileDiff {
  path: string;
  originalPath: string | null;
  area: GitDiffArea;
  change: GitFileChangeKind;
  binary: boolean;
  /** The diff was cut at the size limit. */
  truncated: boolean;
  /** Unified diff text (without the `diff --git` preamble when synthesized). */
  text: string;
  added: number | null;
  removed: number | null;
}

export interface GitRemote {
  name: string;
  /** Credentials embedded in URLs are removed. */
  fetchUrl: string | null;
  pushUrl: string | null;
}

export interface GitLocalBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  upstreamGone: boolean;
  latestCommitAt: string | null;
}

export interface GitRemoteBranch {
  /** Short name, e.g. `origin/main`. */
  name: string;
  remote: string;
  latestCommitAt: string | null;
}

export interface GitBranchList {
  current: string | null;
  local: GitLocalBranch[];
  remote: GitRemoteBranch[];
}

/** How `git pull` would integrate, from the repository configuration. */
export interface GitPullInfo {
  branch: string | null;
  upstream: string | null;
  /** `unset` means Git asks the user to choose and refuses divergent pulls. */
  configuredStrategy: 'merge' | 'rebase' | 'ff-only' | 'unset';
  hasLocalChanges: boolean;
}

export const GIT_OPERATION_KINDS = [
  'stage',
  'unstage',
  'commit',
  'push',
  'pull',
  'fetch',
  'create-branch',
  'switch-branch',
  'rename-branch',
] as const;
export type GitOperationKind = (typeof GIT_OPERATION_KINDS)[number];

export type GitOperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export const GIT_FAILURE_CODES = [
  'authentication',
  'network',
  'rejected',
  'conflict',
  'no-upstream',
  'identity-missing',
  'nothing-to-commit',
  'hook-or-command-failed',
  'locked',
  'timeout',
  'unavailable',
] as const;
export type GitFailureCode = (typeof GIT_FAILURE_CODES)[number];

export interface GitOperation {
  id: string;
  kind: GitOperationKind;
  repositoryRoot: string;
  status: GitOperationStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Latest progress reported by Git, e.g. "Receiving objects" at 42%. */
  progress: { phase: string; percent: number | null } | null;
  /** Short human-readable outcome. */
  summary: string | null;
  error: {
    code: GitFailureCode;
    message: string;
    /** Git's own output (credentials removed, size-limited). */
    output: string | null;
  } | null;
  cancellable: boolean;
}

export interface GitCommitResult {
  commit: GitOperation;
  /** Full hash of the new commit when it succeeded. */
  hash: string | null;
  /** Present for Commit & Push; null when the commit failed and push was skipped. */
  push: GitOperation | null;
}

const NoNul = (value: string) => !value.includes('\0');
export const GitRepositoryRootSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(NoNul, 'Invalid repository path.');
/** Repository-relative path as reported by `git status`. */
export const GitPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(NoNul, 'Invalid path.')
  .refine((value) => !value.startsWith('/') && !/^[A-Za-z]:/.test(value), 'Invalid path.')
  .refine((value) => !value.split('/').includes('..'), 'Invalid path.');
export const GitPathListSchema = z.array(GitPathSchema).max(5000);
export const GitRefNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a branch name.')
  .max(255)
  .refine((value) => !/[\0-\x20\x7f]/.test(value), 'Branch names cannot contain spaces.')
  .refine((value) => !value.startsWith('-'), 'Branch names cannot start with "-".');
export const GitRemoteNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'Invalid remote name.');
export const GitCommitMessageSchema = z.string().min(1).max(65_536);
export const GitIndexFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const GitOperationIdSchema = z.uuid();

export const GitDiffInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  path: GitPathSchema,
  area: z.enum(['staged', 'unstaged']),
});
export type GitDiffInput = z.infer<typeof GitDiffInputSchema>;

export const GitPathsInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  paths: GitPathListSchema.min(1),
});
export type GitPathsInput = z.infer<typeof GitPathsInputSchema>;

export const GitSetUpstreamSchema = z.strictObject({
  remote: GitRemoteNameSchema,
  branch: GitRefNameSchema,
});
export type GitSetUpstream = z.infer<typeof GitSetUpstreamSchema>;

export const GitCommitInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  message: GitCommitMessageSchema,
  /** Paths whose working tree changes the user explicitly chose to include. */
  stage: GitPathListSchema,
  /** Staged paths the user excluded from this commit. */
  unstage: GitPathListSchema,
  expectedFingerprint: GitIndexFingerprintSchema,
  push: z.boolean(),
  /** Required to push a branch without upstream. */
  setUpstream: GitSetUpstreamSchema.optional(),
});
export type GitCommitInput = z.infer<typeof GitCommitInputSchema>;

export const GitPushInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  setUpstream: GitSetUpstreamSchema.optional(),
});
export type GitPushInput = z.infer<typeof GitPushInputSchema>;

export const GitPullInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  mode: z.enum(['ff-only', 'configured']),
});
export type GitPullInput = z.infer<typeof GitPullInputSchema>;

export const GitFetchInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  remote: GitRemoteNameSchema.optional(),
});
export type GitFetchInput = z.infer<typeof GitFetchInputSchema>;

export const GitCreateBranchInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  name: GitRefNameSchema,
  /** Existing branch to start from; defaults to HEAD. */
  startPoint: GitRefNameSchema.optional(),
  switchTo: z.boolean(),
});
export type GitCreateBranchInput = z.infer<typeof GitCreateBranchInputSchema>;

export const GitSwitchBranchInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  name: GitRefNameSchema,
  /** A remote-tracking branch creates a local tracking branch first. */
  kind: z.enum(['local', 'remote']),
});
export type GitSwitchBranchInput = z.infer<typeof GitSwitchBranchInputSchema>;

export const GitRenameBranchInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  from: GitRefNameSchema,
  to: GitRefNameSchema,
});
export type GitRenameBranchInput = z.infer<typeof GitRenameBranchInputSchema>;

/** Optional, stricter commit conventions and suggestion preferences. */
export const GitPreferencesSchema = z.strictObject({
  commitTypes: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9-]*$/)
        .max(32),
    )
    .max(50),
  requireScope: z.boolean(),
  headerMaxLength: z.number().int().min(20).max(500).nullable(),
  suggestions: z.enum(['deterministic', 'off']),
  lastRepositoryRoot: GitRepositoryRootSchema.nullable(),
});
export type GitPreferences = z.infer<typeof GitPreferencesSchema>;
export const UpdateGitPreferencesSchema = GitPreferencesSchema.partial();
export type UpdateGitPreferences = z.infer<typeof UpdateGitPreferencesSchema>;

export const DEFAULT_GIT_PREFERENCES: GitPreferences = {
  commitTypes: [],
  requireScope: false,
  headerMaxLength: null,
  suggestions: 'deterministic',
  lastRepositoryRoot: null,
};

/** A reviewed-before-use commit message proposal; it is never applied automatically. */
export interface GitCommitSuggestion {
  /** A complete message, or a template with `<type>` when the type is not evident. */
  message: string;
  type: string | null;
  scope: string | null;
  description: string;
  rationale: string[];
}
