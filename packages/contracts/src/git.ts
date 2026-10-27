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
  /** Commit HEAD points to; null when HEAD has no commit yet. */
  headOid: string | null;
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

/**
 * Persisted subset of a project's Git status (SDD-024 FR-002). Identity, file names and
 * branch lists are deliberately not kept.
 */
/** A local commit not reachable from the branch's upstream (SDD-024 Task 02). */
export interface PendingCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** Author date (ISO 8601). */
  committedAt: string | null;
}

/** Commits stored per project; more are read on request ("Load more"). */
export const PENDING_COMMITS_LIMIT = 50;

/**
 * `ok`: the list is reliable (empty means nothing to push, as of the last fetch). The other
 * states mean pending commits cannot be determined; an empty list never implies "pushed".
 */
export type PendingCommitsState =
  'ok' | 'no-upstream' | 'upstream-gone' | 'detached' | 'unborn' | 'error';

export interface PendingCommits {
  state: PendingCommitsState;
  /** Newest first, at most PENDING_COMMITS_LIMIT. */
  commits: PendingCommit[];
  /** Commits ahead of the upstream (all of them, not only those listed); null when unknown. */
  total: number | null;
}

/** Commits to skip when loading more pending commits. */
export const PendingCommitsSkipSchema = z.number().int().min(0).max(100_000);

/** A further page of pending commits, read live for the given branch and upstream. */
export interface PendingCommitsPage {
  branch: string | null;
  upstream: string | null;
  headOid: string | null;
  state: PendingCommitsState;
  commits: PendingCommit[];
}

export type ProjectGitSnapshot =
  | {
      state: 'repository';
      branch: string | null;
      /** Identity of the pending list: it was read for this commit, branch and upstream. */
      headOid: string | null;
      detachedHead: boolean;
      unbornHead: boolean;
      upstream: string | null;
      ahead: number | null;
      behind: number | null;
      upstreamGone: boolean;
      changes: GitChangeCounts;
      /** Null for snapshots stored before pending commits were collected. */
      pending: PendingCommits | null;
    }
  | { state: 'not-repository' };

/**
 * `live`: refreshed by monitoring since ATLAS started and the last check succeeded.
 * `cached`: last known snapshot (monitoring off, failed check, or not refreshed yet).
 * `none`: no snapshot was ever collected.
 */
export type ProjectGitFreshness = 'live' | 'cached' | 'none';

export interface ProjectGitState {
  projectId: string;
  monitoringEnabled: boolean;
  freshness: ProjectGitFreshness;
  snapshot: ProjectGitSnapshot | null;
  /** Time of the last successful refresh (ISO 8601). */
  refreshedAt: string | null;
  /** Reason of the last failed refresh when it is more recent than `refreshedAt`. */
  error: { reason: GitUnavailableReason; at: string } | null;
}

/** Outcome of an explicit refresh: the stored state and the full status just read. */
export interface ProjectGitRefreshResult {
  state: ProjectGitState;
  status: GitStatus;
}

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
  /**
   * While a merge is in progress: Git's prepared merge message (`MERGE_MSG` without
   * comment lines), used as the default commit message.
   */
  mergeMessage: string | null;
  /** The cherry-pick in progress: the commit that stopped and how many follow it. */
  cherryPick: { hash: string; subject: string; remaining: number } | null;
  files: GitFileChange[];
  /** True when more changed paths exist than were listed. */
  truncated: boolean;
  /** True when a staged path was not listed; commits are refused while it is set. */
  stagedTruncated: boolean;
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
  'merge',
  'abort-merge',
  'cherry-pick',
  'continue-cherry-pick',
  'skip-cherry-pick',
  'abort-cherry-pick',
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
  /** A pre-commit step configured for the project failed; nothing was committed. */
  'check-failed',
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
  /** Pre-commit steps of a commit, in order; null for other operations. */
  steps: GitPreCommitStepResult[] | null;
}

export type GitPreCommitStepStatus =
  'pending' | 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped';

export interface GitPreCommitStepResult {
  name: string;
  command: string;
  mode: PreCommitStepMode;
  status: GitPreCommitStepStatus;
  /** Wall-clock time of the step; null until it finished. */
  durationMs: number | null;
  exitCode: number | null;
  /** Why the step failed, e.g. "exited with code 1" or "timed out after 600 s". */
  detail: string | null;
  /** Tail of the step's output (credentials removed), kept for failed steps. */
  output: string | null;
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
  /**
   * Project whose commit settings apply when several registered projects share the
   * repository. The Engine reads the settings itself; the request never carries commands.
   */
  projectId: z.uuid().optional(),
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

export const GitMergeInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  /** Local or remote-tracking branch merged into the current branch. */
  branch: GitRefNameSchema,
});
export type GitMergeInput = z.infer<typeof GitMergeInputSchema>;

/** What merging `branch` would bring, from local refs (as of the last fetch). */
export interface GitMergePreview {
  branch: string;
  /** Commits of `branch` that the current branch does not have yet. */
  commits: number;
}

/** A commit of another branch that can be brought into the current one. */
export interface GitCherryPickCandidate {
  hash: string;
  subject: string;
  author: string;
  date: string;
  /** Its changes are already in the current branch (same patch, maybe another hash). */
  applied: boolean;
  /** The subject follows Conventional Commits; kept as it is either way. */
  conventional: boolean;
}

export interface GitCherryPickPreview {
  branch: string;
  current: string;
  /** Oldest first, as they would be applied. */
  commits: GitCherryPickCandidate[];
  /** Only the newest commits are listed. */
  truncated: boolean;
}

export const GitCherryPickInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  /** Branch the commits come from; never the current one. */
  branch: GitRefNameSchema,
  commits: z
    .array(z.string().regex(/^[0-9a-f]{40}$/))
    .min(1)
    .max(200),
  /** Adds "(cherry picked from commit …)" to each message (`-x`). */
  recordOrigin: z.boolean(),
});
export type GitCherryPickInput = z.infer<typeof GitCherryPickInputSchema>;

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
  /** Automatic Git monitoring for projects registered from now on (SDD-024 FR-001). */
  monitorNewProjects: z.boolean(),
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
  monitorNewProjects: true,
};

/** Preferences as read for display. */
export type StoredGitPreferences = GitPreferences & {
  /**
   * Stored preferences exist but cannot be read: the defaults are returned and commits
   * are refused until the preferences are saved again. Absent when they are readable.
   */
  invalid?: boolean;
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

// ---------------------------------------------------------------------------
// Project commit settings (PLAN-009)
// ---------------------------------------------------------------------------

export const PRE_COMMIT_STEP_MODES = ['complete', 'start'] as const;
/**
 * `complete`: the command must exit with code 0 (tests, builds).
 * `start`: the command must keep running for `readyAfterSeconds` (or print
 * `readyText`); ATLAS then stops it and everything it started.
 */
export type PreCommitStepMode = (typeof PRE_COMMIT_STEP_MODES)[number];

export const PRE_COMMIT_STEPS_MAX = 5;

export const PreCommitStepSchema = z.strictObject({
  name: z.string().trim().min(1, 'Enter a name.').max(60),
  command: z
    .string()
    .trim()
    .min(1, 'Enter a command.')
    .max(1000)
    .refine((value) => !/[\0\r\n]/.test(value), 'Use a single-line command.'),
  mode: z.enum(PRE_COMMIT_STEP_MODES),
  /** Maximum duration of a `complete` step, or of waiting for `readyText`. */
  timeoutSeconds: z.number().int().min(5).max(3600),
  /** How long a `start` step must keep running to pass. */
  readyAfterSeconds: z.number().int().min(2).max(300),
  /** For `start` steps: passes as soon as the output contains this text. */
  readyText: z.string().trim().max(200).nullable(),
});
export type PreCommitStep = z.infer<typeof PreCommitStepSchema>;

export const ProjectGitSettingsSchema = z.strictObject({
  /** On by default: messages must follow Conventional Commits. */
  enforceConventionalCommits: z.boolean(),
  preCommitSteps: z.array(PreCommitStepSchema).max(PRE_COMMIT_STEPS_MAX, 'Up to 5 steps.'),
});
export type ProjectGitSettings = z.infer<typeof ProjectGitSettingsSchema>;

export const DEFAULT_PROJECT_GIT_SETTINGS: ProjectGitSettings = {
  enforceConventionalCommits: true,
  preCommitSteps: [],
};

/** Project commit settings as read for display. */
export type StoredProjectGitSettings = ProjectGitSettings & {
  /**
   * Stored settings exist but cannot be read: the defaults are returned and commits for
   * the project are refused until the settings are saved again. Absent when readable.
   */
  settingsInvalid?: boolean;
};

/** Projects sharing a repository, with the commit settings each would apply. */
export interface GitCommitContext {
  projects: {
    id: string;
    name: string;
    workspacePath: string;
    settings: ProjectGitSettings;
    /**
     * Stored settings exist but cannot be read: `settings` are the defaults and commits
     * for this project are refused until the settings are saved again.
     */
    settingsInvalid?: boolean;
  }[];
}

// ---------------------------------------------------------------------------
// Operation log (PLAN-016)
// ---------------------------------------------------------------------------

/** One Git command ATLAS ran inside an operation, with its sanitized output. */
export interface GitCommandRecord {
  operationId: string;
  /** Order within the operation, from 1. */
  sequence: number;
  /** Arguments after `git` (credentials removed). */
  args: string[];
  startedAt: string;
  durationMs: number;
  /** Git's exit code; null when Git did not exit normally (timeout, cancelled, not found). */
  exitCode: number | null;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  /** Tail of standard output and standard error (credentials removed, size-limited). */
  stdout: string | null;
  stderr: string | null;
  /** Output was longer than the stored limit; only its end is kept. */
  truncated: boolean;
}

/** A logged operation and the number of Git commands recorded for it. */
export interface GitOperationLogEntry extends GitOperation {
  commandCount: number;
}

export interface GitOperationLogPage {
  operations: GitOperationLogEntry[];
  /** Pass as `before` to load older operations; null when there are none. */
  nextBefore: string | null;
}

export interface GitOperationLogDetails {
  operation: GitOperationLogEntry;
  commands: GitCommandRecord[];
}

export const GitOperationLogQuerySchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema.optional(),
  kind: z.enum(GIT_OPERATION_KINDS).optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
  /** Only operations that started before this time (pagination). */
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type GitOperationLogQuery = z.input<typeof GitOperationLogQuerySchema>;

export const GIT_LOG_RETENTION_DAYS = [7, 30, 90, 180, 365] as const;
export const GIT_LOG_MAX_OPERATIONS = [500, 1000, 5000, 10_000, 50_000] as const;

const LogSettingsFields = {
  retentionDays: z.number().int().min(1).max(3650),
  maxOperations: z.number().int().min(100).max(100_000),
};
/** How long logged operations are kept; older or excess ones are removed. */
export const GitOperationLogSettingsSchema = z.strictObject({
  retentionDays: LogSettingsFields.retentionDays.default(90),
  maxOperations: LogSettingsFields.maxOperations.default(5000),
});
export type GitOperationLogSettings = z.infer<typeof GitOperationLogSettingsSchema>;
/** Without defaults: a field left out keeps its stored value. */
export const UpdateGitOperationLogSettingsSchema = z.strictObject(LogSettingsFields).partial();
export type UpdateGitOperationLogSettings = z.infer<typeof UpdateGitOperationLogSettingsSchema>;

/**
 * An entry of the repository's HEAD reflog: every change of HEAD made by any tool,
 * including `git` typed in a terminal. Read from Git; never stored by ATLAS.
 */
export interface GitReflogEntry {
  /** Position in the reflog (0 = latest), as in `HEAD@{0}`. */
  index: number;
  hash: string;
  /** e.g. "commit", "checkout", "pull", "reset", "merge feature" */
  action: string;
  message: string;
  date: string | null;
  /** Who made the change, as recorded by Git. */
  identity: string;
  /** Subject of the commit HEAD pointed to after the change (PLAN-022). */
  commitSubject: string;
  /**
   * A logged ATLAS operation on this repository that was running at that time; null when
   * the change probably came from outside ATLAS. Matched by time only.
   */
  atlasOperationId: string | null;
}

/** A search reads at most this many of the latest reflog entries (PLAN-022). */
export const GIT_REFLOG_SEARCH_DEPTH = 1000;

export const GitReflogInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  limit: z.number().int().min(1).max(500).default(100),
  /**
   * Keeps entries whose reflog message or commit subject contains the text (any case),
   * or whose hash starts with it; searches the latest GIT_REFLOG_SEARCH_DEPTH entries.
   */
  query: z.string().trim().max(200).optional(),
});
export type GitReflogInput = z.input<typeof GitReflogInputSchema>;

/** A file changed by a commit, compared with its first parent (PLAN-022). */
export interface GitCommitFile {
  path: string;
  /** Previous path of a renamed or copied file. */
  originalPath: string | null;
  change: GitFileChangeKind;
  /** Null for binary files. */
  added: number | null;
  removed: number | null;
}

export interface GitCommitFiles {
  hash: string;
  subject: string;
  body: string;
  author: string;
  date: string | null;
  /** More than one for merge commits, whose files are compared with the first parent. */
  parentCount: number;
  files: GitCommitFile[];
  /** Only the first GIT_COMMIT_FILES_LIMIT files are listed. */
  truncated: boolean;
}

export const GIT_COMMIT_FILES_LIMIT = 500;

export const GitCommitFilesInputSchema = z.strictObject({
  repositoryRoot: GitRepositoryRootSchema,
  hash: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'Invalid commit hash.'),
});
export type GitCommitFilesInput = z.infer<typeof GitCommitFilesInputSchema>;

// ---------------------------------------------------------------------------
// Git identity (SDD-024 Task 03)
// ---------------------------------------------------------------------------

/** Where Git found a value (`git config --show-scope`). */
export type GitConfigScope = 'local' | 'worktree' | 'global' | 'system' | 'command' | 'unknown';

export interface GitConfigValue {
  value: string;
  scope: GitConfigScope;
  /** The file (or "command line") Git read it from, e.g. an included file. */
  origin: string | null;
}

export interface GitIdentityValues {
  name: GitConfigValue | null;
  email: GitConfigValue | null;
}

/** An environment variable of new terminals that changes the identity of commits there. */
export interface GitIdentityEnvironmentOverride {
  variable: string;
  /** Shown for author/committer names and emails; null for configuration variables. */
  value: string | null;
  affects: 'name' | 'email' | 'configuration';
}

export interface ProjectGitIdentity {
  projectId: string;
  /** Local values apply to this whole repository (and its worktrees). */
  repositoryRoot: string;
  /** As Git resolves it in the repository: local, includes, global, system, command line. */
  effective: GitIdentityValues;
  /** The repository's own overrides; null when inherited. */
  local: { name: string | null; email: string | null };
  /** Variables of the shell environment of new terminals (not of ATLAS's own commits). */
  environment: GitIdentityEnvironmentOverride[];
  /** False when the shell environment could not be read. */
  environmentChecked: boolean;
}

/** Control characters (including line breaks) and angle brackets break Git's author line. */
const hasForbiddenIdentityCharacter = (value: string) =>
  [...value].some((character) => character < ' ' || character === '<' || character === '>');

export const GitIdentityNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(200, 'Use at most 200 characters.')
  .refine(
    (value) => !hasForbiddenIdentityCharacter(value),
    'Names cannot contain <, > or line breaks.',
  );

/** Permissive on purpose: Git accepts addresses without "@"; the UI warns about them. */
export const GitIdentityEmailSchema = z
  .string()
  .trim()
  .min(1, 'Enter an email.')
  .max(254, 'Use at most 254 characters.')
  .refine(
    (value) => !hasForbiddenIdentityCharacter(value) && !/\s/.test(value),
    'Emails cannot contain spaces, <, > or line breaks.',
  );

export const SetGlobalGitIdentitySchema = z.strictObject({
  name: GitIdentityNameSchema,
  email: GitIdentityEmailSchema,
});
export type SetGlobalGitIdentity = z.input<typeof SetGlobalGitIdentitySchema>;

/** A string sets the local override; null removes it (inherit again); absent leaves it. */
export const SetProjectGitIdentitySchema = z
  .strictObject({
    name: GitIdentityNameSchema.nullable().optional(),
    email: GitIdentityEmailSchema.nullable().optional(),
  })
  .refine((input) => input.name !== undefined || input.email !== undefined, {
    message: 'Change the name, the email or both.',
  });
export type SetProjectGitIdentity = z.input<typeof SetProjectGitIdentitySchema>;
