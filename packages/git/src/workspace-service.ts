import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  GitBranchList,
  GitCherryPickInput,
  GitCherryPickPreview,
  GitCommitInput,
  GitCreateBranchInput,
  GitDiffInput,
  GitFileChange,
  GitFileChangeKind,
  GitFileDiff,
  GitInProgressOperation,
  GitLineStats,
  GitMergePreview,
  GitOperation,
  GitPullInfo,
  GitPullInput,
  GitCommitFiles,
  GitReflogEntry,
  GitRemote,
  GitRenameBranchInput,
  GitSetUpstream,
  GitSwitchBranchInput,
  GitWorkingTree,
} from '@atlas/contracts';
import { GIT_COMMIT_FILES_LIMIT, GIT_REFLOG_SEARCH_DEPTH } from '@atlas/contracts';
import {
  validateCommitMessage,
  type CommitMessageRules,
  type CommitSuggestionInput,
  type SuggestedFileChange,
} from '@atlas/conventional-commits';
import { AtlasError, noopLogger, type Logger } from '@atlas/shared';
import {
  GitOperationFailure,
  type GitOperationContext,
  type GitOperationCoordinator,
  type GitOperationOutcome,
} from './coordinator.js';
import { REFLOG_FORMAT, matchReflog, parseReflog } from './operation-log.js';
import {
  REF_FORMAT,
  parseNameStatus,
  parseNumstat,
  parseRefs,
  parseRemotes,
  parseStatusEntries,
  parseStatusV2,
} from './porcelain.js';
import {
  DEFAULT_COMMIT_CHECKS,
  runPreCommitSteps,
  type CommitChecks,
  type PreCommitStepRunner,
} from './pre-commit.js';
import {
  GitCommandError,
  type GitExecOptions,
  type GitExecResult,
  type GitExecutor,
} from './runner.js';
import { redactCredentials, sanitizeGitOutput } from './sanitize.js';

export interface GitWorkspaceTimeouts {
  /** Status, diff and other reads. */
  read: number;
  /** Staging, branches and other local mutations. */
  local: number;
  /** Commits, which run hooks. */
  commit: number;
  /** Push, pull and fetch. */
  network: number;
}

export interface GitWorkspaceLimits {
  /** Changed paths listed per repository. */
  maxFiles: number;
  /** Diff text kept per file. */
  maxDiffBytes: number;
  maxDiffLines: number;
  /** Untracked files whose lines are counted for the file list. */
  maxUntrackedStatFiles: number;
  /** Larger untracked files are not read for line counts. */
  maxUntrackedFileBytes: number;
}

export interface GitWorkspaceServiceOptions {
  exec: GitExecutor;
  /** Runs project pre-commit steps; commits with steps are refused without it. */
  stepRunner?: PreCommitStepRunner;
  coordinator: GitOperationCoordinator;
  now?: () => Date;
  logger?: Logger;
  /** Called after a mutation may have changed the repository. */
  onRepositoryChanged?: (repositoryRoot: string) => void;
  /**
   * Environment for commit checks and hooks (commit, push), read fresh for every
   * commit like a new terminal; `warning` says when it fell back to the default.
   */
  commitEnvironment?: (
    repositoryRoot: string,
  ) => Promise<{ env: Record<string, string>; warning: string | null }>;
  timeouts?: Partial<GitWorkspaceTimeouts>;
  limits?: Partial<GitWorkspaceLimits>;
}

export interface GitCommitOutcome {
  commit: GitOperation;
  hash: string | null;
  push: GitOperation | null;
}

const DEFAULT_TIMEOUTS: GitWorkspaceTimeouts = {
  read: 15_000,
  local: 60_000,
  commit: 10 * 60_000,
  network: 10 * 60_000,
};

const DEFAULT_LIMITS: GitWorkspaceLimits = {
  maxFiles: 2000,
  maxDiffBytes: 512 * 1024,
  maxDiffLines: 5000,
  maxUntrackedStatFiles: 200,
  maxUntrackedFileBytes: 1024 * 1024,
};

/** Bytes inspected to tell binary from text, as Git does. */
const BINARY_SNIFF_BYTES = 8000;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Separates `git log` fields; never part of commit subjects or names. */
const FIELD = '\x1f';
/** Commits listed for a cherry-pick (the newest of the source branch). */
export const CHERRY_PICK_LIMIT = 200;

/** Environment of one commit's checks and hooks. */
type CommitShell = { env: Record<string, string>; warning: string | null };

/** Appended to a commit's or push's result when the fresh environment was unavailable. */
const shellNote = (shell: CommitShell | null) => (shell?.warning ? ` (${shell.warning})` : '');

/**
 * Git workflow operations on one repository root. The caller is responsible for
 * resolving `repositoryRoot` from a trusted source (a registered project or an
 * open terminal); paths and branch names are validated here against what Git
 * itself reports. Every mutation goes through the operation coordinator.
 */
export class GitWorkspaceService {
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly timeouts: GitWorkspaceTimeouts;
  private readonly limits: GitWorkspaceLimits;

  constructor(private readonly options: GitWorkspaceServiceOptions) {
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? (() => new Date());
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The working tree. Staged entries are listed first, so untracked or unstaged
   * files beyond the limit never hide what a commit would contain;
   * `stagedTruncated` reports staged entries that still did not fit.
   */
  async workingTree(repositoryRoot: string): Promise<GitWorkingTree> {
    const [status, staged, unstaged, head, rawIndex, name, email, gitDir] = await Promise.all([
      this.read(repositoryRoot, [
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all',
      ]),
      this.read(repositoryRoot, [
        'diff',
        '--cached',
        '--numstat',
        '-z',
        '-M',
        '--no-ext-diff',
        '--no-textconv',
      ]),
      this.read(repositoryRoot, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv']),
      this.read(repositoryRoot, ['rev-parse', '--verify', '-q', 'HEAD'], [0, 1]),
      this.read(repositoryRoot, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev']),
      this.config(repositoryRoot, 'user.name'),
      this.config(repositoryRoot, 'user.email'),
      this.read(repositoryRoot, ['rev-parse', '--absolute-git-dir']),
    ]);
    const parsed = parseStatusV2(status);
    const stagedStats = parseNumstat(staged);
    const unstagedStats = parseNumstat(unstaged);
    const entries = parseStatusEntries(status);
    const { listed, hiddenStaged } = listEntries(entries, this.limits.maxFiles);
    const untrackedStats = await this.untrackedStats(
      repositoryRoot,
      listed.filter((entry) => entry.unstaged === 'untracked').map((entry) => entry.path),
    );
    const files: GitFileChange[] = listed.map((entry) => ({
      path: entry.path,
      originalPath: entry.originalPath,
      staged: entry.staged,
      unstaged: entry.unstaged,
      stagedStats: entry.staged === null ? null : (stagedStats.get(entry.path) ?? null),
      unstagedStats:
        entry.unstaged === null
          ? null
          : entry.unstaged === 'untracked'
            ? (untrackedStats.get(entry.path) ?? null)
            : (unstagedStats.get(entry.path) ?? null),
    }));
    const directory = gitDir.trim();
    const [lastFetchAt, inProgress] = await Promise.all([
      this.modifiedAt(path.join(directory, 'FETCH_HEAD')),
      this.inProgress(directory),
    ]);
    const mergeMessage = inProgress === 'merge' ? await this.mergeMessage(directory) : null;
    const cherryPick =
      inProgress === 'cherry-pick' ? await this.cherryPickState(repositoryRoot, directory) : null;
    const tree: GitWorkingTree = {
      repositoryRoot,
      repositoryName: path.basename(repositoryRoot),
      branch: parsed.branch,
      detachedHead: parsed.detachedHead,
      unbornHead: parsed.unbornHead,
      upstream: parsed.upstream,
      ahead: parsed.upstreamGone ? null : parsed.ahead,
      behind: parsed.upstreamGone ? null : parsed.behind,
      upstreamGone: parsed.upstreamGone,
      identity: { name, email },
      lastFetchAt,
      inProgress,
      mergeMessage,
      cherryPick,
      files,
      truncated: entries.length > listed.length,
      stagedTruncated: hiddenStaged > 0,
      indexFingerprint: createHash('sha256')
        .update(head.stdout.trim())
        .update('\0')
        .update(parsed.branch ?? '')
        .update('\0')
        .update(rawIndex)
        .digest('hex'),
      inspectedAt: this.now().toISOString(),
    };
    return tree;
  }

  async diff(
    repositoryRoot: string,
    input: Omit<GitDiffInput, 'repositoryRoot'>,
  ): Promise<GitFileDiff> {
    const tree = await this.workingTree(repositoryRoot);
    const entry = tree.files.find((file) => file.path === input.path);
    const change = input.area === 'staged' ? entry?.staged : entry?.unstaged;
    if (!entry || change === null || change === undefined) {
      throw invalid('path', `This file has no ${input.area} changes.`);
    }
    const base = {
      path: entry.path,
      originalPath: entry.originalPath,
      area: input.area,
      change,
    } as const;
    if (change === 'untracked')
      return { ...base, ...(await this.untrackedDiff(repositoryRoot, entry.path)) };

    const paths =
      input.area === 'staged' && entry.originalPath !== null
        ? [entry.originalPath, entry.path]
        : [entry.path];
    const result = await this.read(
      repositoryRoot,
      [
        'diff',
        ...(input.area === 'staged' ? ['--cached'] : []),
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '-M',
        '--',
        ...paths,
      ],
      [0],
      { maxOutputBytes: this.limits.maxDiffBytes },
    );
    return { ...base, ...this.summarizeDiff(result.stdout, result.truncated) };
  }

  async branches(repositoryRoot: string): Promise<GitBranchList> {
    const [refs, remotes] = await Promise.all([
      this.read(repositoryRoot, [
        'for-each-ref',
        `--format=${REF_FORMAT}`,
        'refs/heads',
        'refs/remotes',
      ]),
      this.remoteNames(repositoryRoot),
    ]);
    const list: GitBranchList = { current: null, local: [], remote: [] };
    for (const ref of parseRefs(refs)) {
      if (ref.ref.startsWith('refs/heads/')) {
        const name = ref.ref.slice('refs/heads/'.length);
        if (ref.current) list.current = name;
        list.local.push({
          name,
          current: ref.current,
          upstream: ref.upstream,
          ahead: ref.ahead,
          behind: ref.behind,
          upstreamGone: ref.upstreamGone,
          latestCommitAt: ref.latestCommitAt,
        });
      } else if (ref.ref.startsWith('refs/remotes/')) {
        const name = ref.ref.slice('refs/remotes/'.length);
        // Remote names may contain "/": match the longest configured remote.
        const remote = remotes
          .filter((candidate) => name.startsWith(`${candidate}/`))
          .sort((a, b) => b.length - a.length)[0];
        if (remote === undefined || name === `${remote}/HEAD`) continue;
        list.remote.push({ name, remote, latestCommitAt: ref.latestCommitAt });
      }
    }
    return list;
  }

  async remotes(repositoryRoot: string): Promise<GitRemote[]> {
    const output = await this.read(repositoryRoot, ['remote', '-v']);
    return parseRemotes(output).map((remote) => ({
      name: remote.name,
      fetchUrl: remote.fetchUrl === null ? null : redactCredentials(remote.fetchUrl),
      pushUrl: remote.pushUrl === null ? null : redactCredentials(remote.pushUrl),
    }));
  }

  async pullInfo(repositoryRoot: string): Promise<GitPullInfo> {
    const tree = await this.workingTree(repositoryRoot);
    const branchRebase =
      tree.branch === null
        ? null
        : await this.config(repositoryRoot, `branch.${tree.branch}.rebase`);
    const [pullRebase, pullFf] = await Promise.all([
      this.config(repositoryRoot, 'pull.rebase'),
      this.config(repositoryRoot, 'pull.ff'),
    ]);
    const rebase = branchRebase ?? pullRebase;
    let configuredStrategy: GitPullInfo['configuredStrategy'] = 'unset';
    if (rebase !== null && rebase !== 'false') configuredStrategy = 'rebase';
    else if (pullFf === 'only') configuredStrategy = 'ff-only';
    else if (rebase === 'false' || pullFf !== null) configuredStrategy = 'merge';
    return {
      branch: tree.branch,
      upstream: tree.upstream,
      configuredStrategy,
      hasLocalChanges: tree.files.some((file) => file.unstaged !== 'untracked'),
    };
  }

  /** Paths and change types of the given files, for commit message suggestions. */
  async suggestionInput(
    repositoryRoot: string,
    paths: readonly string[],
  ): Promise<CommitSuggestionInput> {
    const tree = await this.workingTree(repositoryRoot);
    const wanted = new Set(paths);
    return {
      files: tree.files
        .filter((file) => wanted.has(file.path))
        .map((file) => ({
          path: file.path,
          change: suggestedChange(file.staged ?? file.unstaged),
        })),
    };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * The latest HEAD reflog entries: changes of HEAD by any tool, newest first. Empty
   * when the repository has no commits yet or the reflog cannot be read.
   */
  async reflog(
    repositoryRoot: string,
    limit: number,
    query = '',
  ): Promise<Omit<GitReflogEntry, 'atlasOperationId'>[]> {
    const searching = query.trim() !== '';
    const result = await this.read(
      repositoryRoot,
      [
        'reflog',
        'show',
        '--date=iso-strict',
        `--format=${REFLOG_FORMAT}`,
        '-n',
        String(searching ? GIT_REFLOG_SEARCH_DEPTH : limit),
        'HEAD',
        '--',
      ],
      [0, 128],
    );
    if (result.exitCode !== 0) return [];
    const entries = parseReflog(result.stdout);
    return searching ? matchReflog(entries, query).slice(0, limit) : entries;
  }

  /**
   * The files a commit changed, compared with its first parent (or with nothing for a
   * root commit), with its message. Null when the commit does not exist (e.g. a reflog
   * entry whose commit was garbage-collected).
   */
  async commitFiles(repositoryRoot: string, hash: string): Promise<GitCommitFiles | null> {
    const type = await this.read(repositoryRoot, ['cat-file', '-t', hash], [0, 1, 128]);
    if (type.exitCode !== 0 || type.stdout.trim() !== 'commit') return null;
    const header = await this.read(repositoryRoot, [
      'show',
      '-s',
      '--format=%P%x00%an%x00%aI%x00%s%x00%b',
      hash,
      '--',
    ]);
    const [parents = '', author = '', date = '', subject = '', body = ''] = header.split('\0');
    const parentList = parents.trim() === '' ? [] : parents.trim().split(' ');
    const range = parentList.length === 0 ? ['--root', hash] : [parentList[0]!, hash];
    const options = { maxOutputBytes: 8 * 1024 * 1024 };
    const diffTree = (format: string) =>
      this.read(
        repositoryRoot,
        [
          'diff-tree',
          '-r',
          '-M',
          '-z',
          '--no-commit-id',
          '--no-ext-diff',
          '--no-textconv',
          format,
          ...range,
          '--',
        ],
        [0],
        options,
      );
    const [names, numbers] = await Promise.all([diffTree('--name-status'), diffTree('--numstat')]);
    const stats = parseNumstat(numbers.stdout);
    const files = parseNameStatus(names.stdout).map((file) => ({
      ...file,
      added: stats.get(file.path)?.added ?? null,
      removed: stats.get(file.path)?.removed ?? null,
    }));
    return {
      hash,
      subject,
      body: body.trim(),
      author,
      date: date !== '' && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
      parentCount: parentList.length,
      files: files.slice(0, GIT_COMMIT_FILES_LIMIT),
      truncated: files.length > GIT_COMMIT_FILES_LIMIT,
    };
  }

  async stage(repositoryRoot: string, paths: readonly string[]): Promise<GitOperation> {
    const outcome = await this.mutate(repositoryRoot, 'stage', ['index'], false, async () => {
      const tree = await this.workingTree(repositoryRoot);
      const targets = this.requireFiles(tree, paths, 'unstaged');
      await this.write(repositoryRoot, ['add', '--', ...targets.map((file) => file.path)]);
      return { summary: `Staged ${plural(targets.length, 'file')}.`, value: null };
    });
    return outcome.operation;
  }

  async unstage(repositoryRoot: string, paths: readonly string[]): Promise<GitOperation> {
    const outcome = await this.mutate(repositoryRoot, 'unstage', ['index'], false, async () => {
      const tree = await this.workingTree(repositoryRoot);
      const targets = this.requireFiles(tree, paths, 'staged');
      await this.unstageFiles(repositoryRoot, tree, targets);
      return { summary: `Unstaged ${plural(targets.length, 'file')}.`, value: null };
    });
    return outcome.operation;
  }

  /**
   * Commits exactly what is staged after applying the user's explicit selection.
   * Hooks always run. With `push`, pushes only after Git confirmed the commit.
   */
  async commit(
    input: GitCommitInput,
    rules: CommitMessageRules = {},
    checks: CommitChecks = DEFAULT_COMMIT_CHECKS(input.repositoryRoot),
  ): Promise<GitCommitOutcome> {
    const { repositoryRoot } = input;
    if (checks.enforceConventionalCommits) {
      const validation = validateCommitMessage(input.message, rules);
      if (!validation.valid && !(await this.isMergeCommitMessage(repositoryRoot, input.message))) {
        throw new AtlasError('VALIDATION_FAILED', 'Invalid commit message.', {
          issues: validation.errors.map((message) => ({ field: 'message', message })),
        });
      }
    } else if (input.message.trim() === '') {
      throw invalid('message', 'Enter a commit message.');
    }
    if (checks.steps.length > 0 && this.options.stepRunner === undefined) {
      throw invalid(
        'preCommitSteps',
        'This project has pre-commit steps, which only run in ATLAS Control. ' +
          'Commit from ATLAS Control or remove the steps in the project settings.',
      );
    }
    const overlap = input.stage.filter((file) => input.unstage.includes(file));
    if (overlap.length > 0) throw invalid('stage', 'A file cannot be both included and excluded.');
    // Everything that would make the push refuse to start is checked before the
    // commit exists, so Commit & Push never fails halfway on a validation error.
    let pushPlan: PushPlan | null = null;
    if (input.push) {
      const tree = await this.workingTree(repositoryRoot);
      if (input.setUpstream === undefined && (tree.upstream === null || tree.upstreamGone)) {
        throw new AtlasError('GIT_NO_UPSTREAM');
      }
      pushPlan = await this.planPush(repositoryRoot, tree, input.setUpstream);
    }

    const hasSteps = checks.steps.length > 0;
    let shell: CommitShell | null = null;
    const outcome = await this.mutate(
      repositoryRoot,
      'commit',
      ['index'],
      hasSteps,
      async (context) => {
        // Cheap checks first, so long steps never run for a commit that cannot happen.
        const before = await this.workingTree(repositoryRoot);
        this.checkCommittable(before, input, pushPlan);
        // Selected files are staged from disk after the steps ran: their content must
        // still be what it was when the commit started.
        const selected = this.requireFiles(before, input.stage, 'unstaged');
        const identity = await this.selectionIdentity(repositoryRoot, selected);
        shell = await this.shellEnvironment(repositoryRoot);
        if (hasSteps) {
          await runPreCommitSteps(checks, this.options.stepRunner!, context, shell?.env);
          if (context.signal.aborted) {
            throw new GitCommandError('cancelled', 'pre-commit steps cancelled');
          }
          // From here on the commit may be created: it is no longer safe to cancel.
          context.setCancellable(false);
        }
        const tree = hasSteps ? await this.workingTree(repositoryRoot) : before;
        this.checkCommittable(tree, input, pushPlan);
        const toUnstage = this.requireFiles(tree, input.unstage, 'staged');
        const toStage = this.requireFiles(tree, input.stage, 'unstaged');
        if (hasSteps) await this.requireSameIdentity(repositoryRoot, toStage, identity);
        // Refusals between applying the selection and committing put the index back,
        // so a refused commit leaves the staged files as the user reviewed them.
        // Conflicted entries (which `write-tree` cannot record) were refused above.
        const touched = [...unstagedPaths(toUnstage), ...toStage.map((file) => file.path)];
        // `write-tree` does not record intent-to-add entries; they are re-marked.
        const intentToAdd = toStage.filter(isIntentToAdd).map((file) => file.path);
        const snapshot =
          touched.length > 0
            ? (await this.write(repositoryRoot, ['write-tree'])).stdout.trim()
            : null;
        try {
          if (toUnstage.length > 0) await this.unstageFiles(repositoryRoot, tree, toUnstage);
          if (toStage.length > 0) {
            await this.write(repositoryRoot, ['add', '--', ...toStage.map((file) => file.path)]);
            await this.requireStagedIdentity(repositoryRoot, toStage, identity);
          }
          const pending = await this.read(repositoryRoot, ['diff', '--cached', '--quiet'], [0, 1]);
          if (pending.exitCode === 0 && tree.inProgress !== 'merge') {
            throw new GitOperationFailure(
              'nothing-to-commit',
              'There are no staged changes to commit.',
            );
          }
        } catch (error) {
          throw snapshot === null
            ? error
            : await this.restoreSelection(
                repositoryRoot,
                { tree: snapshot, paths: touched, intentToAdd },
                error,
              );
        }
        // Hooks ran against the selection, so a failing commit keeps it staged for a
        // retry or for inspection in a terminal.
        try {
          await this.write(repositoryRoot, ['commit', '-F', '-'], {
            input: input.message,
            timeoutMs: this.timeouts.commit,
            ...(shell ? { env: shell.env } : {}),
          });
        } catch (error) {
          const failure = toFailure(error);
          const kept = snapshot === null ? '' : ' Your file selection remains staged.';
          throw new GitOperationFailure(
            failure.code,
            `${failure.message}${kept}${shellNote(shell)}`,
            failure.output,
          );
        }
        const hash = (await this.read(repositoryRoot, ['rev-parse', 'HEAD'])).trim();
        const header = input.message.split(/\r?\n/, 1)[0]!;
        const where = tree.branch ?? 'detached HEAD';
        return {
          summary: `Committed ${hash.slice(0, 7)} on ${where}: ${header}${shellNote(shell)}`,
          value: hash,
        };
      },
    );

    let push: GitOperation | null = null;
    if (pushPlan !== null && outcome.operation.status === 'succeeded') {
      // The plan was validated before committing; a failing push is reported on its
      // own operation and the commit result keeps its hash.
      push = await this.runPush(repositoryRoot, pushPlan, shell);
    }
    return { commit: outcome.operation, hash: outcome.value, push };
  }

  /**
   * Pushes the current branch to its upstream, or to an explicitly chosen remote
   * branch that becomes its upstream. Never forces.
   */
  async push(repositoryRoot: string, setUpstream?: GitSetUpstream): Promise<GitOperation> {
    const plan = await this.planPush(
      repositoryRoot,
      await this.workingTree(repositoryRoot),
      setUpstream,
    );
    return this.runPush(repositoryRoot, plan);
  }

  /** Validates a push of the current branch and resolves its arguments; never mutates. */
  private async planPush(
    repositoryRoot: string,
    tree: GitWorkingTree,
    setUpstream: GitSetUpstream | undefined,
  ): Promise<PushPlan> {
    const branch = tree.branch;
    if (branch === null) throw invalid('branch', 'Switch to a branch before pushing.');
    if (setUpstream !== undefined) {
      if (!(await this.remoteNames(repositoryRoot)).includes(setUpstream.remote)) {
        throw invalid('remote', 'Choose one of the configured remotes.');
      }
      await this.requireBranchName(repositoryRoot, setUpstream.branch);
      return {
        branch,
        args: [
          'push',
          '--progress',
          '--set-upstream',
          setUpstream.remote,
          `refs/heads/${branch}:refs/heads/${setUpstream.branch}`,
        ],
        destination: `${setUpstream.remote}/${setUpstream.branch}`,
      };
    }
    const [remote, merge] = await Promise.all([
      this.config(repositoryRoot, `branch.${branch}.remote`),
      this.config(repositoryRoot, `branch.${branch}.merge`),
    ]);
    if (remote === null || merge === null) throw new AtlasError('GIT_NO_UPSTREAM');
    // The remote is passed as an argument: it must be a configured remote (or ".").
    if (remote !== '.' && !(await this.remoteNames(repositoryRoot)).includes(remote)) {
      throw new AtlasError('GIT_NO_UPSTREAM');
    }
    return {
      branch,
      args: ['push', '--progress', remote, `refs/heads/${branch}:${merge}`],
      destination: tree.upstream ?? `${remote}/${merge.replace(/^refs\/heads\//, '')}`,
    };
  }

  /** Runs a validated push; Git failures are reported on the operation, not thrown. */
  private async runPush(
    repositoryRoot: string,
    plan: PushPlan,
    commitShell: CommitShell | null = null,
  ): Promise<GitOperation> {
    const outcome = await this.mutate(
      repositoryRoot,
      'push',
      ['remote'],
      false,
      async ({ progress }) => {
        // pre-push hooks get the same fresh environment as a commit's hooks.
        const shell = commitShell ?? (await this.shellEnvironment(repositoryRoot));
        let result: GitExecResult;
        try {
          result = await this.write(repositoryRoot, plan.args, {
            timeoutMs: this.timeouts.network,
            onProgress: progress,
            ...(shell ? { env: shell.env } : {}),
          });
        } catch (error) {
          // Only a fallback is worth mentioning; other failures are mapped as before.
          if (
            !shell?.warning ||
            !(error instanceof GitCommandError) ||
            error.kind === 'cancelled'
          ) {
            throw error;
          }
          const failure = toFailure(error);
          throw new GitOperationFailure(
            failure.code,
            `${failure.message}${shellNote(shell)}`,
            failure.output,
          );
        }
        const upToDate = /Everything up-to-date/i.test(result.stderr);
        return {
          summary:
            (upToDate
              ? 'Everything up-to-date.'
              : `Pushed ${plan.branch} to ${plan.destination}.`) + shellNote(shell),
          value: null,
        };
      },
    );
    return outcome.operation;
  }

  async pull(repositoryRoot: string, mode: GitPullInput['mode']): Promise<GitOperation> {
    const tree = await this.workingTree(repositoryRoot);
    if (tree.branch === null) throw invalid('branch', 'Switch to a branch before pulling.');
    if (tree.upstream === null || tree.upstreamGone) throw new AtlasError('GIT_NO_UPSTREAM');
    if (tree.inProgress !== null) {
      throw invalid('branch', `A ${tree.inProgress} is in progress. Finish or abort it first.`);
    }
    const args = [
      'pull',
      '--progress',
      ...(mode === 'ff-only' ? ['--ff-only', '--no-rebase'] : []),
    ];
    const outcome = await this.mutate(
      repositoryRoot,
      'pull',
      ['index', 'remote'],
      false,
      async ({ progress }) => {
        try {
          const result = await this.write(repositoryRoot, args, {
            timeoutMs: this.timeouts.network,
            onProgress: progress,
          });
          const upToDate = /Already up to date/i.test(`${result.stdout}\n${result.stderr}`);
          return {
            summary: upToDate
              ? 'Already up to date.'
              : `Updated ${tree.branch} from ${tree.upstream}.`,
            value: null,
          };
        } catch (error) {
          const after = await this.workingTree(repositoryRoot).catch(() => null);
          const conflicted = after?.files.filter((file) => file.staged === 'conflicted') ?? [];
          if (conflicted.length > 0 || (after?.inProgress ?? null) !== null) {
            const failure = toFailure(error);
            throw new GitOperationFailure(
              'conflict',
              `The pull stopped with conflicts in ${plural(conflicted.length, 'file')}. ` +
                'Resolve them in a terminal, then commit. Nothing was discarded.',
              failure.output,
            );
          }
          throw error;
        }
      },
    );
    return outcome.operation;
  }

  async fetch(repositoryRoot: string, remote?: string): Promise<GitOperation> {
    if (remote !== undefined && !(await this.remoteNames(repositoryRoot)).includes(remote)) {
      throw invalid('remote', 'Choose one of the configured remotes.');
    }
    const outcome = await this.mutate(
      repositoryRoot,
      'fetch',
      ['remote'],
      true,
      async ({ progress, signal }) => {
        await this.write(repositoryRoot, ['fetch', '--progress', ...(remote ? [remote] : [])], {
          timeoutMs: this.timeouts.network,
          onProgress: progress,
          signal,
        });
        return { summary: `Fetched ${remote ?? 'the default remote'}.`, value: null };
      },
    );
    return outcome.operation;
  }

  async createBranch(
    repositoryRoot: string,
    input: Omit<GitCreateBranchInput, 'repositoryRoot'>,
  ): Promise<GitOperation> {
    await this.requireBranchName(repositoryRoot, input.name);
    if (input.switchTo) await this.requireNothingInProgress(repositoryRoot);
    if (input.startPoint !== undefined) {
      const list = await this.branches(repositoryRoot);
      const known = [...list.local, ...list.remote].some(
        (branch) => branch.name === input.startPoint,
      );
      if (!known) throw invalid('startPoint', 'Choose an existing branch to start from.');
    }
    const start = input.startPoint === undefined ? [] : [input.startPoint];
    const args = input.switchTo
      ? ['switch', '-c', input.name, ...start]
      : ['branch', input.name, ...start];
    const outcome = await this.mutate(
      repositoryRoot,
      'create-branch',
      ['index'],
      false,
      async () => {
        await this.write(repositoryRoot, args);
        return {
          summary: input.switchTo
            ? `Created and switched to ${input.name}.`
            : `Created ${input.name}.`,
          value: null,
        };
      },
    );
    return outcome.operation;
  }

  async switchBranch(
    repositoryRoot: string,
    input: Omit<GitSwitchBranchInput, 'repositoryRoot'>,
  ): Promise<GitOperation> {
    await this.requireNothingInProgress(repositoryRoot);
    const list = await this.branches(repositoryRoot);
    const candidates = input.kind === 'local' ? list.local : list.remote;
    if (!candidates.some((branch) => branch.name === input.name)) {
      throw invalid('name', 'Choose an existing branch.');
    }
    const args =
      input.kind === 'local' ? ['switch', input.name] : ['switch', '--track', input.name];
    const outcome = await this.mutate(
      repositoryRoot,
      'switch-branch',
      ['index'],
      false,
      async () => {
        await this.write(repositoryRoot, args);
        const current = (await this.branches(repositoryRoot)).current ?? input.name;
        return { summary: `Switched to ${current}.`, value: null };
      },
    );
    return outcome.operation;
  }

  async renameBranch(
    repositoryRoot: string,
    input: Omit<GitRenameBranchInput, 'repositoryRoot'>,
  ): Promise<GitOperation> {
    const list = await this.branches(repositoryRoot);
    if (!list.local.some((branch) => branch.name === input.from)) {
      throw invalid('from', 'Choose an existing local branch.');
    }
    await this.requireBranchName(repositoryRoot, input.to);
    const outcome = await this.mutate(
      repositoryRoot,
      'rename-branch',
      ['index'],
      false,
      async () => {
        await this.write(repositoryRoot, ['branch', '-m', input.from, input.to]);
        return { summary: `Renamed ${input.from} to ${input.to}.`, value: null };
      },
    );
    return outcome.operation;
  }

  /** Commits `branch` would bring into the current branch, from local refs. */
  async mergePreview(repositoryRoot: string, branch: string): Promise<GitMergePreview> {
    await this.requireMergeSource(repositoryRoot, branch);
    const count = await this.read(repositoryRoot, ['rev-list', '--count', `HEAD..${branch}`]);
    return { branch, commits: Number(count.trim()) || 0 };
  }

  /**
   * Merges `branch` into the current branch without committing (`--no-commit
   * --no-ff`), so the user reviews the result and commits it with Git's prepared
   * message (and the project's pre-commit steps). Requires a clean working tree,
   * which keeps aborting safe.
   */
  async merge(repositoryRoot: string, branch: string): Promise<GitOperation> {
    const tree = await this.workingTree(repositoryRoot);
    if (tree.inProgress !== null) {
      throw invalid('branch', `A ${tree.inProgress} is in progress. Finish or abort it first.`);
    }
    if (tree.branch === null) throw invalid('branch', 'Switch to a branch before merging.');
    if (
      tree.files.some(
        (file) => file.staged !== null || (file.unstaged !== null && file.unstaged !== 'untracked'),
      )
    ) {
      throw invalid('branch', 'Commit or stash your changes before merging.');
    }
    await this.requireMergeSource(repositoryRoot, branch);
    const current = tree.branch;
    const outcome = await this.mutate(repositoryRoot, 'merge', ['index'], false, async () => {
      try {
        await this.write(repositoryRoot, ['merge', '--no-commit', '--no-ff', branch]);
      } catch (error) {
        const after = await this.workingTree(repositoryRoot).catch(() => null);
        const conflicted = after?.files.filter((file) => file.staged === 'conflicted') ?? [];
        if (conflicted.length > 0) {
          const failure = toFailure(error);
          const names = conflicted.slice(0, 20).map((file) => file.path);
          const more =
            conflicted.length > names.length ? ` and ${conflicted.length - names.length} more` : '';
          throw new GitOperationFailure(
            'conflict',
            `Merging ${branch} into ${current} stopped with conflicts in ` +
              `${plural(conflicted.length, 'file')}: ${names.join(', ')}${more}. ` +
              'Resolve them, mark them resolved and commit, or abort the merge.',
            failure.output,
          );
        }
        throw error;
      }
      const after = await this.workingTree(repositoryRoot);
      if (after.inProgress !== 'merge') {
        return { summary: `${current} already contains ${branch}; nothing to merge.`, value: null };
      }
      const changed = after.files.filter((file) => file.staged !== null).length;
      return {
        summary:
          `Merged ${branch} into ${current} without conflicts ` +
          `(${plural(changed, 'file')}). Review the changes and commit to finish.`,
        value: null,
      };
    });
    return outcome.operation;
  }

  /**
   * Commits of `branch` the current branch does not have, oldest first (the newest
   * CHERRY_PICK_LIMIT), marking those whose changes it already has (`--cherry-mark`).
   */
  async cherryPickPreview(repositoryRoot: string, branch: string): Promise<GitCherryPickPreview> {
    const tree = await this.workingTree(repositoryRoot);
    if (tree.branch === null) throw invalid('branch', 'Switch to a branch before cherry-picking.');
    await this.requireOtherBranch(repositoryRoot, branch, 'cherry-pick from');
    const output = await this.read(repositoryRoot, [
      'log',
      '--cherry-mark',
      '--right-only',
      '--no-merges',
      '--topo-order',
      '-n',
      String(CHERRY_PICK_LIMIT + 1),
      `--format=%m${FIELD}%H${FIELD}%s${FIELD}%an${FIELD}%aI`,
      `HEAD...${branch}`,
      '--',
    ]);
    const lines = output.split('\n').filter((line) => line.includes(FIELD));
    const commits = lines
      .slice(0, CHERRY_PICK_LIMIT)
      .map((line) => {
        const [mark = '', hash = '', subject = '', author = '', date = ''] = line.split(FIELD);
        return {
          hash,
          subject,
          author,
          date,
          applied: mark === '=',
          conventional: validateCommitMessage(subject).valid,
        };
      })
      .reverse();
    return {
      branch,
      current: tree.branch,
      commits,
      truncated: lines.length > CHERRY_PICK_LIMIT,
    };
  }

  /**
   * Applies commits of another branch to the current one, one new commit each, keeping
   * their messages and authors (`git cherry-pick`, optionally `-x`). They are applied in
   * the source branch's order. Requires a clean working tree, which keeps aborting safe.
   */
  async cherryPick(input: GitCherryPickInput): Promise<GitOperation> {
    const { repositoryRoot, branch } = input;
    const tree = await this.workingTree(repositoryRoot);
    if (tree.inProgress !== null) {
      throw invalid('branch', `A ${tree.inProgress} is in progress. Finish or abort it first.`);
    }
    if (tree.branch === null) throw invalid('branch', 'Switch to a branch before cherry-picking.');
    if (
      tree.files.some(
        (file) => file.staged !== null || (file.unstaged !== null && file.unstaged !== 'untracked'),
      )
    ) {
      throw invalid('commits', 'Commit or stash your changes before cherry-picking.');
    }
    const preview = await this.cherryPickPreview(repositoryRoot, branch);
    const chosen = new Set(input.commits);
    const candidates = preview.commits.filter((commit) => chosen.has(commit.hash));
    if (candidates.length !== chosen.size) {
      throw invalid('commits', `Choose commits of ${branch} that ${tree.branch} does not have.`);
    }
    if (candidates.some((commit) => commit.applied)) {
      throw invalid('commits', `${tree.branch} already has the changes of a chosen commit.`);
    }
    const current = tree.branch;
    const outcome = await this.mutate(repositoryRoot, 'cherry-pick', ['index'], false, async () => {
      const shell = await this.shellEnvironment(repositoryRoot);
      await this.runCherryPick(
        repositoryRoot,
        ['cherry-pick', ...(input.recordOrigin ? ['-x'] : []), ...candidates.map((c) => c.hash)],
        shell,
      );
      return {
        summary:
          `Applied ${plural(candidates.length, 'commit')} of ${branch} to ${current}.` +
          shellNote(shell),
        value: null,
      };
    });
    return outcome.operation;
  }

  /** Commits the resolved changes and goes on with the remaining commits. */
  continueCherryPick(repositoryRoot: string): Promise<GitOperation> {
    return this.cherryPickStep(repositoryRoot, 'continue-cherry-pick', async (tree) => {
      if (tree.files.some((file) => file.staged === 'conflicted')) {
        throw invalid('files', 'Resolve every conflicted file and mark it resolved first.');
      }
      // The commit keeps its original message: no editor is opened.
      return ['-c', 'core.editor=true', 'cherry-pick', '--continue'];
    });
  }

  /** Leaves out the commit that stopped and goes on with the remaining ones. */
  skipCherryPick(repositoryRoot: string): Promise<GitOperation> {
    return this.cherryPickStep(repositoryRoot, 'skip-cherry-pick', async () => [
      'cherry-pick',
      '--skip',
    ]);
  }

  /** Restores the branch as it was before the cherry-pick started (`--abort`). */
  async abortCherryPick(repositoryRoot: string): Promise<GitOperation> {
    const tree = await this.workingTree(repositoryRoot);
    if (tree.inProgress !== 'cherry-pick')
      throw invalid('branch', 'No cherry-pick is in progress.');
    const outcome = await this.mutate(
      repositoryRoot,
      'abort-cherry-pick',
      ['index'],
      false,
      async () => {
        await this.write(repositoryRoot, ['cherry-pick', '--abort']);
        return {
          summary: 'Cherry-pick aborted; the branch is back to its state before it started.',
          value: null,
        };
      },
    );
    return outcome.operation;
  }

  /** Restores the state before the merge (`git merge --abort`). */
  async abortMerge(repositoryRoot: string): Promise<GitOperation> {
    const tree = await this.workingTree(repositoryRoot);
    if (tree.inProgress !== 'merge') throw invalid('branch', 'No merge is in progress.');
    const outcome = await this.mutate(repositoryRoot, 'abort-merge', ['index'], false, async () => {
      await this.write(repositoryRoot, ['merge', '--abort']);
      return {
        summary: 'Merge aborted; the branch is back to its state before the merge.',
        value: null,
      };
    });
    return outcome.operation;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Git's default merge message is accepted for the commit that concludes a merge. */
  private async isMergeCommitMessage(repositoryRoot: string, message: string): Promise<boolean> {
    if (!/^Merge /.test(message.trimStart())) return false;
    return (await this.workingTree(repositoryRoot)).inProgress === 'merge';
  }

  private async mergeMessage(gitDir: string): Promise<string | null> {
    try {
      const text = (await readFile(path.join(gitDir, 'MERGE_MSG'), 'utf8'))
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('#'))
        .join('\n')
        .trim();
      return text === '' ? null : text;
    } catch {
      return null;
    }
  }

  private async requireNothingInProgress(repositoryRoot: string): Promise<void> {
    const { inProgress } = await this.workingTree(repositoryRoot);
    if (inProgress !== null) {
      throw invalid('name', `A ${inProgress} is in progress. Finish or abort it first.`);
    }
  }

  /** A local or remote-tracking branch other than the current one. */
  private requireMergeSource(repositoryRoot: string, branch: string): Promise<void> {
    return this.requireOtherBranch(repositoryRoot, branch, 'merge');
  }

  /** An existing local or remote-tracking branch other than the current one. */
  private async requireOtherBranch(
    repositoryRoot: string,
    branch: string,
    action: string,
  ): Promise<void> {
    const list = await this.branches(repositoryRoot);
    const known = [...list.local, ...list.remote].some((candidate) => candidate.name === branch);
    if (!known || branch === list.current) {
      throw invalid('branch', `Choose another existing branch to ${action}.`);
    }
  }

  /** Continue or skip: runs while a cherry-pick is in progress and reports where it stops. */
  private async cherryPickStep(
    repositoryRoot: string,
    kind: 'continue-cherry-pick' | 'skip-cherry-pick',
    args: (tree: GitWorkingTree) => Promise<string[]>,
  ): Promise<GitOperation> {
    const tree = await this.workingTree(repositoryRoot);
    if (tree.inProgress !== 'cherry-pick')
      throw invalid('branch', 'No cherry-pick is in progress.');
    const command = await args(tree);
    const outcome = await this.mutate(repositoryRoot, kind, ['index'], false, async () => {
      const shell = await this.shellEnvironment(repositoryRoot);
      await this.runCherryPick(repositoryRoot, command, shell);
      return {
        summary:
          (kind === 'skip-cherry-pick' ? 'Commit skipped; ' : 'Commit created; ') +
          'the cherry-pick finished.' +
          shellNote(shell),
        value: null,
      };
    });
    return outcome.operation;
  }

  /**
   * Runs a cherry-pick command. When Git stops (conflicts, or a commit that became
   * empty), the failure names the commit and what to do next; the state stays for
   * Continue, Skip or Abort.
   */
  private async runCherryPick(
    repositoryRoot: string,
    args: string[],
    shell: CommitShell | null,
  ): Promise<void> {
    try {
      await this.write(repositoryRoot, args, {
        timeoutMs: this.timeouts.commit,
        ...(shell ? { env: shell.env } : {}),
      });
    } catch (error) {
      const after = await this.workingTree(repositoryRoot).catch(() => null);
      if (after?.inProgress !== 'cherry-pick' || after.cherryPick === null) throw error;
      const failure = toFailure(error);
      const stopped = `${after.cherryPick.hash.slice(0, 7)} ${after.cherryPick.subject}`;
      const rest =
        after.cherryPick.remaining > 0
          ? ` ${plural(after.cherryPick.remaining, 'commit')} after it will follow.`
          : '';
      const conflicted = after.files.filter((file) => file.staged === 'conflicted');
      if (conflicted.length === 0) {
        throw new GitOperationFailure(
          'conflict',
          `The cherry-pick stopped at ${stopped}: its changes are already on ` +
            `${after.branch ?? 'this branch'}, so it would be empty. Skip it or abort.${rest}`,
          failure.output,
        );
      }
      const names = conflicted.slice(0, 20).map((file) => file.path);
      const more =
        conflicted.length > names.length ? ` and ${conflicted.length - names.length} more` : '';
      throw new GitOperationFailure(
        'conflict',
        `The cherry-pick stopped at ${stopped} with conflicts in ` +
          `${plural(conflicted.length, 'file')}: ${names.join(', ')}${more}. ` +
          `Resolve them, mark them resolved and continue, skip this commit, or abort.${rest}`,
        failure.output,
      );
    }
  }

  /** The commit a cherry-pick stopped at and how many remain after it. */
  private async cherryPickState(
    repositoryRoot: string,
    gitDir: string,
  ): Promise<GitWorkingTree['cherryPick']> {
    try {
      const hash = (await readFile(path.join(gitDir, 'CHERRY_PICK_HEAD'), 'utf8')).trim();
      const subject = (await this.read(repositoryRoot, ['log', '-1', '--format=%s', hash])).trim();
      const todo = await readFile(path.join(gitDir, 'sequencer', 'todo'), 'utf8').catch(() => '');
      // The todo list starts with the commit that stopped.
      const pending = todo.split(/\r?\n/).filter((line) => /^\s*(pick|p)\s/.test(line)).length;
      return { hash, subject, remaining: Math.max(0, pending - 1) };
    } catch {
      return null;
    }
  }

  /** A fresh environment for checks and hooks, read like a new terminal (PLAN-018). */
  private async shellEnvironment(repositoryRoot: string): Promise<CommitShell | null> {
    if (this.options.commitEnvironment === undefined) return null;
    return this.options.commitEnvironment(repositoryRoot);
  }

  private async mutate<T>(
    repositoryRoot: string,
    kind: GitOperation['kind'],
    lanes: ('index' | 'remote')[],
    cancellable: boolean,
    task: (context: GitOperationContext) => Promise<{ summary: string; value: T }>,
  ): Promise<GitOperationOutcome<T>> {
    try {
      return await this.options.coordinator.run(
        { repositoryRoot, kind, lanes, cancellable },
        async (context) => {
          try {
            return await task(context);
          } catch (error) {
            if (error instanceof GitCommandError && error.kind !== 'cancelled') {
              const failure = toFailure(error);
              this.logger.warn('Git operation failed', {
                kind,
                code: failure.code,
                exitCode: error.exitCode,
              });
              throw failure;
            }
            throw error;
          }
        },
      );
    } finally {
      this.options.onRepositoryChanged?.(repositoryRoot);
    }
  }

  /** Refuses a commit that cannot succeed, before any step or mutation runs. */
  private checkCommittable(
    tree: GitWorkingTree,
    input: GitCommitInput,
    pushPlan: PushPlan | null,
  ): void {
    // Only hidden staged entries (or hidden selected files) make the reviewed list
    // incomplete; untracked files beyond the limit are never committed implicitly.
    const listed = new Set(tree.files.map((file) => file.path));
    if (tree.stagedTruncated || (tree.truncated && input.stage.some((file) => !listed.has(file)))) {
      throw invalid('paths', 'Too many changed files to review safely. Commit from a terminal.');
    }
    if (tree.indexFingerprint !== input.expectedFingerprint) {
      throw new AtlasError('GIT_INDEX_CHANGED');
    }
    // The push was planned for this branch; a switch since then must not push another.
    if (pushPlan !== null && tree.branch !== pushPlan.branch) {
      throw new AtlasError('GIT_INDEX_CHANGED');
    }
    if (tree.files.some((file) => file.staged === 'conflicted')) {
      throw new GitOperationFailure('conflict', 'Resolve the merge conflicts before committing.');
    }
    this.requireFiles(tree, input.unstage, 'staged');
    const toStage = this.requireFiles(tree, input.stage, 'unstaged');
    const excluded = new Set(input.unstage);
    const remainsStaged = tree.files.some(
      (file) => file.staged !== null && !excluded.has(file.path),
    );
    if (!remainsStaged && toStage.length === 0 && tree.inProgress !== 'merge') {
      throw new GitOperationFailure('nothing-to-commit', 'There are no staged changes to commit.');
    }
  }

  /**
   * Identity of files the commit will stage, keyed by path: the blob id Git would
   * store for regular files (filters applied, as `git add` does) plus their
   * executable bit, the target of symbolic links, the checked-out commit of
   * submodules (gitlinks, which `git add` records by that commit), or that the file
   * is missing (a deletion). One `hash-object` call for all regular files.
   */
  private async selectionIdentity(
    repositoryRoot: string,
    files: readonly GitFileChange[],
  ): Promise<Map<string, string>> {
    const identity = new Map<string, string>();
    const regular: { file: string; mode: string }[] = [];
    for (const { path: file } of files) {
      const absolute = path.resolve(repositoryRoot, file);
      try {
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) identity.set(file, `link:${await readlink(absolute)}`);
        else if (info.isFile()) regular.push({ file, mode: fileMode(info.mode) });
        else if (info.isDirectory()) identity.set(file, await this.gitlinkIdentity(absolute));
        else identity.set(file, 'other');
      } catch {
        identity.set(file, 'missing');
      }
    }
    if (regular.length > 0) {
      // Paths go through standard input (no argument limits), C-quoted as Git expects.
      const result = await this.read(repositoryRoot, ['hash-object', '--stdin-paths'], [0], {
        input: regular.map(({ file }) => `${quotePath(file)}\n`).join(''),
        timeoutMs: this.timeouts.commit,
      });
      const ids = result.stdout.split('\n').filter((line) => line !== '');
      if (ids.length !== regular.length) throw new AtlasError('GIT_INDEX_CHANGED');
      regular.forEach(({ file, mode }, index) => identity.set(file, `file:${mode}:${ids[index]!}`));
    }
    return identity;
  }

  /**
   * `gitlink:<commit>` for a directory that is the root of a checked-out repository
   * (a submodule or an embedded repository); `directory` for anything else.
   */
  private async gitlinkIdentity(directory: string): Promise<string> {
    const result = await this.read(directory, ['rev-parse', '--show-toplevel', 'HEAD'], [0, 128]);
    const [top, commit] = result.stdout.split('\n');
    if (result.exitCode !== 0 || top === undefined || commit === undefined) return 'directory';
    const [actualTop, expectedTop] = await Promise.all([
      realpath(top).catch(() => top),
      realpath(directory).catch(() => directory),
    ]);
    return actualTop === expectedTop ? `gitlink:${commit.trim()}` : 'directory';
  }

  /** Refuses the commit when a selected file changed since `expected` was taken. */
  private async requireSameIdentity(
    repositoryRoot: string,
    files: readonly GitFileChange[],
    expected: ReadonlyMap<string, string>,
  ): Promise<void> {
    const actual = await this.selectionIdentity(repositoryRoot, files);
    for (const [file, value] of actual) {
      if (expected.get(file) !== value) throw new AtlasError('GIT_INDEX_CHANGED');
    }
  }

  /**
   * Verifies that `git add` staged exactly the identified content and mode, closing
   * the gap between the last check and staging.
   */
  private async requireStagedIdentity(
    repositoryRoot: string,
    files: readonly GitFileChange[],
    expected: ReadonlyMap<string, string>,
  ): Promise<void> {
    const [result, fileModeConfig] = await Promise.all([
      this.read(
        repositoryRoot,
        ['ls-files', '--stage', '-z', '--', ...files.map((file) => file.path)],
        [0],
        {
          timeoutMs: this.timeouts.commit,
        },
      ),
      this.read(repositoryRoot, ['config', '--bool', '--get', 'core.fileMode'], [0, 1]),
    ]);
    // Without core.fileMode Git ignores the executable bit and keeps the index mode.
    const tracksExecutableBit = fileModeConfig.stdout.trim() !== 'false';
    const staged = new Map<string, { mode: string; object: string }>();
    for (const record of result.stdout.split('\0')) {
      // "<mode> <object> <stage>\t<path>"
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      const [mode = '', object = ''] = record.slice(0, tab).split(' ');
      staged.set(record.slice(tab + 1), { mode, object });
    }
    const changed = () => new AtlasError('GIT_INDEX_CHANGED');
    const links: GitFileChange[] = [];
    for (const file of files) {
      const value = expected.get(file.path) ?? '';
      // Git lists an embedded repository selected as `dir/` by its entry `dir`.
      const entry = staged.get(file.path.replace(/\/$/, ''));
      const [kind = '', ...parts] = value.split(':');
      if (value === 'missing') {
        if (entry !== undefined) throw changed();
      } else if (kind === 'file') {
        const [mode, object] = parts;
        const sameMode = tracksExecutableBit
          ? entry?.mode === mode
          : entry?.mode === '100644' || entry?.mode === '100755';
        if (entry?.object !== object || !sameMode) throw changed();
      } else if (kind === 'gitlink') {
        if (entry?.mode !== '160000' || entry.object !== parts[0]) throw changed();
      } else if (kind === 'link') {
        if (entry?.mode !== '120000') throw changed();
        links.push(file);
      } else {
        // Directories that are not repositories and special files cannot be staged.
        throw changed();
      }
    }
    // A link's blob is its target; re-reading the target is cheaper than hashing it.
    if (links.length > 0) {
      try {
        await this.requireSameIdentity(repositoryRoot, links, expected);
      } catch {
        throw changed();
      }
    }
  }

  /**
   * Puts the selected paths of the index back to the `snapshot` tree after a refusal
   * and returns the error to report. Only the touched paths are restored, so flags of
   * other entries (sparse checkout, intent-to-add) are kept; touched paths that were
   * intent-to-add are marked again. `git reset` (unlike `git restore --staged`) also
   * accepts paths that are in neither the tree nor the index, e.g. a new file that
   * was deleted before it could be staged. The reported message travels in the
   * error's issues or the operation's message, which reach the client.
   */
  private async restoreSelection(
    repositoryRoot: string,
    snapshot: { tree: string; paths: readonly string[]; intentToAdd: readonly string[] },
    error: unknown,
  ): Promise<unknown> {
    let restored = true;
    try {
      await this.write(repositoryRoot, ['reset', '-q', snapshot.tree, '--', ...snapshot.paths]);
      if (snapshot.intentToAdd.length > 0) {
        await this.write(repositoryRoot, ['add', '-N', '--', ...snapshot.intentToAdd]);
      }
    } catch (restoreError) {
      restored = false;
      this.logger.warn('Could not restore the index after a refused commit', {
        exitCode: restoreError instanceof GitCommandError ? restoreError.exitCode : null,
      });
    }
    const kept = restored ? '' : ' Your file selection remains staged.';
    if (error instanceof AtlasError && error.code === 'GIT_INDEX_CHANGED') {
      const message = restored
        ? 'Selected files changed while the commit was prepared. Nothing was committed and the staged files were restored.'
        : 'Selected files changed while the commit was prepared. Nothing was committed, but your file selection remains staged.';
      return new AtlasError('GIT_INDEX_CHANGED', message, {
        issues: [{ field: 'selection', message }],
        details: { selectionStaged: !restored },
        cause: error,
      });
    }
    if (restored) return error;
    if (error instanceof AtlasError) {
      return new AtlasError(error.code, error.message, {
        issues: [...error.issues, { field: 'selection', message: kept.trim() }],
        details: { ...error.details, selectionStaged: true },
        cause: error,
      });
    }
    const failure = toFailure(error);
    return new GitOperationFailure(failure.code, `${failure.message}${kept}`, failure.output);
  }

  /** Files of the working tree with changes in `area`; rejects anything else. */
  private requireFiles(
    tree: GitWorkingTree,
    paths: readonly string[],
    area: 'staged' | 'unstaged',
  ): GitFileChange[] {
    const byPath = new Map(tree.files.map((file) => [file.path, file]));
    return [...new Set(paths)].map((file) => {
      const entry = byPath.get(file);
      if (!entry || entry[area] === null) {
        throw invalid('paths', `"${file}" has no ${area} changes. Refresh and try again.`);
      }
      return entry;
    });
  }

  private async unstageFiles(
    repositoryRoot: string,
    tree: GitWorkingTree,
    files: GitFileChange[],
  ): Promise<void> {
    const paths = unstagedPaths(files);
    const args = tree.unbornHead
      ? ['rm', '--cached', '-q', '--', ...paths]
      : ['restore', '--staged', '--', ...paths];
    await this.write(repositoryRoot, args);
  }

  private async requireBranchName(repositoryRoot: string, name: string): Promise<void> {
    // `--branch` would expand "@{-1}"-style shorthands; names must be literal.
    if (name.includes('@{')) throw invalid('name', 'This is not a valid branch name.');
    const result = await this.read(
      repositoryRoot,
      ['check-ref-format', '--branch', name],
      [0, 1, 128],
    );
    if (result.exitCode !== 0 || result.stdout.trim() !== name) {
      throw invalid('name', 'This is not a valid branch name.');
    }
  }

  private async remoteNames(repositoryRoot: string): Promise<string[]> {
    return (await this.read(repositoryRoot, ['remote']))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  private async config(repositoryRoot: string, key: string): Promise<string | null> {
    // `git config --get` exits with 1 when the key is not set.
    const result = await this.read(repositoryRoot, ['config', '--get', key], [0, 1]);
    const value = result.stdout.trim();
    return result.exitCode === 0 && value !== '' ? value : null;
  }

  private async modifiedAt(file: string): Promise<string | null> {
    try {
      return (await stat(file)).mtime.toISOString();
    } catch {
      return null;
    }
  }

  private async inProgress(gitDir: string): Promise<GitInProgressOperation | null> {
    const exists = async (name: string) =>
      (await this.modifiedAt(path.join(gitDir, name))) !== null;
    if ((await exists('rebase-merge')) || (await exists('rebase-apply'))) return 'rebase';
    if (await exists('MERGE_HEAD')) return 'merge';
    if (await exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (await exists('REVERT_HEAD')) return 'revert';
    return null;
  }

  private async untrackedStats(
    repositoryRoot: string,
    paths: string[],
  ): Promise<Map<string, GitLineStats>> {
    const stats = new Map<string, GitLineStats>();
    await Promise.all(
      paths.slice(0, this.limits.maxUntrackedStatFiles).map(async (file) => {
        const content = await this.readUntracked(
          repositoryRoot,
          file,
          this.limits.maxUntrackedFileBytes,
        );
        if (content === null || content.truncated) return;
        stats.set(file, {
          added: content.binary ? null : countLines(content.text),
          removed: content.binary ? null : 0,
        });
      }),
    );
    return stats;
  }

  private async untrackedDiff(
    repositoryRoot: string,
    file: string,
  ): Promise<Pick<GitFileDiff, 'binary' | 'truncated' | 'text' | 'added' | 'removed'>> {
    const content = await this.readUntracked(repositoryRoot, file, this.limits.maxDiffBytes);
    if (content === null) throw invalid('path', 'The file could not be read.');
    if (content.binary)
      return { binary: true, truncated: false, text: '', added: null, removed: null };
    let lines = content.text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    // The hunk header counts towards the line limit.
    const room = this.limits.maxDiffLines - 1;
    const truncated = content.truncated || lines.length > room;
    lines = lines.slice(0, room);
    const text =
      lines.length === 0
        ? ''
        : `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
    return { binary: false, truncated, text, added: truncated ? null : lines.length, removed: 0 };
  }

  /**
   * Reads an untracked file inside the repository. Symbolic links are reported by
   * their target path, as Git does, and never followed.
   */
  private async readUntracked(
    repositoryRoot: string,
    file: string,
    maxBytes: number,
  ): Promise<{ text: string; binary: boolean; truncated: boolean } | null> {
    const absolute = path.resolve(repositoryRoot, file);
    if (!absolute.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`)) return null;
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink())
        return { text: `${await readlink(absolute)}\n`, binary: false, truncated: false };
      if (!info.isFile()) return null;
      // O_NOFOLLOW: the file cannot be swapped for a link between lstat and open.
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const data = buffer.subarray(0, bytesRead);
        const binary = data.subarray(0, BINARY_SNIFF_BYTES).includes(0);
        return {
          text: binary ? '' : data.toString('utf8'),
          binary,
          truncated: info.size > maxBytes,
        };
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  private summarizeDiff(
    output: string,
    cut: boolean,
  ): Pick<GitFileDiff, 'binary' | 'truncated' | 'text' | 'added' | 'removed'> {
    if (/^Binary files .* differ$/m.test(output) || /^GIT binary patch$/m.test(output)) {
      return { binary: true, truncated: false, text: '', added: null, removed: null };
    }
    let lines = output.split('\n');
    const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
    lines = firstHunk === -1 ? [] : lines.slice(firstHunk);
    if (cut) lines.pop(); // The last line may be incomplete.
    if (lines.at(-1) === '') lines.pop();
    const truncated = cut || lines.length > this.limits.maxDiffLines;
    lines = lines.slice(0, this.limits.maxDiffLines);
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
    return {
      binary: false,
      truncated,
      text: lines.join('\n'),
      added: truncated ? null : added,
      removed: truncated ? null : removed,
    };
  }

  /** Reading command; `--literal-pathspecs` makes paths never act as pathspec magic. */
  private read(repositoryRoot: string, args: string[]): Promise<string>;
  private read(
    repositoryRoot: string,
    args: string[],
    okExitCodes: readonly number[],
    extra?: Partial<Pick<GitExecOptions, 'maxOutputBytes' | 'input' | 'timeoutMs'>>,
  ): Promise<GitExecResult>;
  private async read(
    repositoryRoot: string,
    args: string[],
    okExitCodes?: readonly number[],
    extra: Partial<Pick<GitExecOptions, 'maxOutputBytes' | 'input' | 'timeoutMs'>> = {},
  ): Promise<string | GitExecResult> {
    const result = await this.options.exec(['--literal-pathspecs', ...args], {
      cwd: repositoryRoot,
      timeoutMs: this.timeouts.read,
      okExitCodes: okExitCodes ?? [0],
      ...extra,
    });
    return okExitCodes === undefined ? result.stdout : result;
  }

  private write(
    repositoryRoot: string,
    args: string[],
    options: Partial<Omit<GitExecOptions, 'cwd'>> = {},
  ): Promise<GitExecResult> {
    return this.options.exec(['--literal-pathspecs', ...args], {
      cwd: repositoryRoot,
      timeoutMs: this.timeouts.local,
      ...options,
    });
  }
}

interface PushPlan {
  branch: string;
  args: string[];
  destination: string;
}

/**
 * Keeps at most `max` entries in their original order, preferring staged ones, and
 * counts the staged entries that still did not fit.
 */
function listEntries<T extends { staged: unknown }>(
  entries: readonly T[],
  max: number,
): { listed: T[]; hiddenStaged: number } {
  if (entries.length <= max) return { listed: [...entries], hiddenStaged: 0 };
  const staged = entries.filter((entry) => entry.staged !== null);
  const kept = new Set(staged.slice(0, max));
  for (const entry of entries) {
    if (kept.size >= max) break;
    kept.add(entry);
  }
  return {
    listed: entries.filter((entry) => kept.has(entry)),
    hiddenStaged: Math.max(0, staged.length - max),
  };
}

/** Index paths that unstaging `files` changes. */
/**
 * Whether the path is an intent-to-add index entry (`git add -N`): only those make
 * the working tree differ from the index as an added (or, with rename detection,
 * renamed-to) path.
 */
function isIntentToAdd(file: GitFileChange): boolean {
  return file.unstaged === 'added' || file.unstaged === 'renamed';
}

function unstagedPaths(files: readonly GitFileChange[]): string[] {
  // A staged rename is two index entries: the new path and the removed original.
  return files.flatMap((file) =>
    file.originalPath !== null && file.staged === 'renamed'
      ? [file.path, file.originalPath]
      : [file.path],
  );
}

/** The index mode Git records for a regular file with these permission bits. */
function fileMode(permissions: number): string {
  return (permissions & 0o111) === 0 ? '100644' : '100755';
}

/** Quotes a path for Git's line-based input (`--stdin-paths`) in C style. */
function quotePath(file: string): string {
  let quoted = '';
  for (const char of file) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === '\\') quoted += `\\${char}`;
    else if (code < 0x20 || code === 0x7f) quoted += `\\${code.toString(8).padStart(3, '0')}`;
    else quoted += char;
  }
  return `"${quoted}"`;
}

function invalid(field: string, message: string): AtlasError {
  return new AtlasError('VALIDATION_FAILED', message, { issues: [{ field, message }] });
}

function countLines(text: string): number {
  if (text === '') return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

function suggestedChange(kind: GitFileChangeKind | null): SuggestedFileChange {
  if (kind === 'added' || kind === 'untracked') return 'added';
  if (kind === 'deleted') return 'deleted';
  if (kind === 'renamed' || kind === 'copied') return 'renamed';
  return 'modified';
}

const FAILURE_PATTERNS: { test: RegExp; code: GitOperationFailure['code']; message: string }[] = [
  {
    test: /index\.lock|Unable to create .*\.lock|another git process/i,
    code: 'locked',
    message: 'Another Git process is using this repository. Wait for it to finish and try again.',
  },
  {
    test: /Please tell me who you are|Author identity unknown|empty ident name/i,
    code: 'identity-missing',
    message: 'Configure user.name and user.email in Git before committing.',
  },
  {
    test: /terminal prompts disabled|could not read Username|could not read Password|Authentication failed|Permission denied \(publickey|Invalid username or password|HTTP Basic: Access denied|The requested URL returned error: 40[13]/i,
    code: 'authentication',
    message:
      'Authentication failed. Configure a Git credential helper or ssh-agent; ATLAS cannot answer password prompts.',
  },
  {
    test: /Could not resolve host|Failed to connect|Connection (refused|timed out|reset)|Network is unreachable|unable to access|Could not read from remote repository|does not appear to be a git repository/i,
    code: 'network',
    message: 'The remote repository could not be reached.',
  },
  {
    test: /\[rejected\]|Updates were rejected|non-fast-forward|\(fetch first\)/i,
    code: 'rejected',
    message: 'The remote rejected the push. Pull first; ATLAS never force-pushes.',
  },
  {
    test: /Not possible to fast-forward|can't be fast-forwarded|divergent branches/i,
    code: 'rejected',
    message: 'The branches have diverged, so a fast-forward is not possible.',
  },
  {
    test: /would be overwritten by|Your local changes to the following files|untracked working tree files would be/i,
    code: 'conflict',
    message: 'Your local changes would be overwritten. Commit or stash them first.',
  },
  {
    test: /^CONFLICT|Automatic merge failed|fix conflicts/im,
    code: 'conflict',
    message: 'Git stopped because of conflicts. Resolve them in a terminal.',
  },
  {
    test: /nothing to commit|no changes added to commit/i,
    code: 'nothing-to-commit',
    message: 'There are no staged changes to commit.',
  },
  {
    test: /There is no tracking information|has no upstream branch/i,
    code: 'no-upstream',
    message: 'This branch has no upstream branch.',
  },
  {
    test: /already exists/i,
    code: 'rejected',
    message: 'A branch with that name already exists.',
  },
];

/** Maps a failed Git command to a reported failure with sanitized output. */
export function toFailure(error: unknown): GitOperationFailure {
  if (error instanceof GitOperationFailure) return error;
  if (!(error instanceof GitCommandError)) {
    return new GitOperationFailure('unavailable', 'Git could not complete the operation.');
  }
  const output = sanitizeGitOutput(error.output.stderr, error.output.stdout);
  switch (error.kind) {
    case 'timeout':
      return new GitOperationFailure('timeout', 'Git took too long and was stopped.', output);
    case 'not-installed':
      return new GitOperationFailure('unavailable', 'Git is not installed or not on the PATH.');
    case 'output-too-large':
      return new GitOperationFailure(
        'unavailable',
        'Git produced more output than ATLAS can process. Use a terminal for this repository.',
      );
    case 'unsafe-ownership':
      return new GitOperationFailure(
        'unavailable',
        'Git does not trust this repository (it belongs to another user).',
        output,
      );
    case 'not-repository':
      return new GitOperationFailure(
        'unavailable',
        'This directory is no longer a Git repository.',
      );
    default: {
      const text = `${error.output.stderr}\n${error.output.stdout}`;
      const match = FAILURE_PATTERNS.find((pattern) => pattern.test.test(text));
      return match
        ? new GitOperationFailure(match.code, match.message, output)
        : new GitOperationFailure(
            'hook-or-command-failed',
            'Git reported an error. Its output is shown below.',
            output,
          );
    }
  }
}
