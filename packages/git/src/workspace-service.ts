import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  GitBranchList,
  GitCommitInput,
  GitCreateBranchInput,
  GitDiffInput,
  GitFileChange,
  GitFileChangeKind,
  GitFileDiff,
  GitInProgressOperation,
  GitLineStats,
  GitOperation,
  GitPullInfo,
  GitPullInput,
  GitRemote,
  GitRenameBranchInput,
  GitSetUpstream,
  GitSwitchBranchInput,
  GitWorkingTree,
} from '@atlas/contracts';
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
import {
  REF_FORMAT,
  parseNumstat,
  parseRefs,
  parseRemotes,
  parseStatusEntries,
  parseStatusV2,
} from './porcelain.js';
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
  coordinator: GitOperationCoordinator;
  now?: () => Date;
  logger?: Logger;
  /** Called after a mutation may have changed the repository. */
  onRepositoryChanged?: (repositoryRoot: string) => void;
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
    const listed = entries.slice(0, this.limits.maxFiles);
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
    return {
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
      files,
      truncated: entries.length > listed.length,
      indexFingerprint: createHash('sha256')
        .update(head.stdout.trim())
        .update('\0')
        .update(rawIndex)
        .digest('hex'),
      inspectedAt: this.now().toISOString(),
    };
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
      this.limits.maxDiffBytes,
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
  async commit(input: GitCommitInput, rules: CommitMessageRules = {}): Promise<GitCommitOutcome> {
    const { repositoryRoot } = input;
    const validation = validateCommitMessage(input.message, rules);
    if (!validation.valid) {
      throw new AtlasError('VALIDATION_FAILED', 'Invalid commit message.', {
        issues: validation.errors.map((message) => ({ field: 'message', message })),
      });
    }
    const overlap = input.stage.filter((file) => input.unstage.includes(file));
    if (overlap.length > 0) throw invalid('stage', 'A file cannot be both included and excluded.');
    if (input.push && input.setUpstream === undefined) {
      const tree = await this.workingTree(repositoryRoot);
      if (tree.upstream === null || tree.upstreamGone) throw new AtlasError('GIT_NO_UPSTREAM');
    }

    const outcome = await this.mutate(repositoryRoot, 'commit', ['index'], false, async () => {
      const tree = await this.workingTree(repositoryRoot);
      if (tree.indexFingerprint !== input.expectedFingerprint)
        throw new AtlasError('GIT_INDEX_CHANGED');
      if (tree.files.some((file) => file.staged === 'conflicted')) {
        throw new GitOperationFailure('conflict', 'Resolve the merge conflicts before committing.');
      }
      const toUnstage = this.requireFiles(tree, input.unstage, 'staged');
      const toStage = this.requireFiles(tree, input.stage, 'unstaged');
      if (toUnstage.length > 0) await this.unstageFiles(repositoryRoot, tree, toUnstage);
      if (toStage.length > 0) {
        await this.write(repositoryRoot, ['add', '--', ...toStage.map((file) => file.path)]);
      }
      const pending = await this.read(repositoryRoot, ['diff', '--cached', '--quiet'], [0, 1]);
      if (pending.exitCode === 0 && tree.inProgress !== 'merge') {
        throw new GitOperationFailure(
          'nothing-to-commit',
          'There are no staged changes to commit.',
        );
      }
      try {
        await this.write(repositoryRoot, ['commit', '-F', '-'], {
          input: input.message,
          timeoutMs: this.timeouts.commit,
        });
      } catch (error) {
        const failure = toFailure(error);
        const kept =
          toStage.length + toUnstage.length > 0 ? ' Your file selection remains staged.' : '';
        throw new GitOperationFailure(failure.code, `${failure.message}${kept}`, failure.output);
      }
      const hash = (await this.read(repositoryRoot, ['rev-parse', 'HEAD'])).trim();
      const header = input.message.split(/\r?\n/, 1)[0]!;
      const where = tree.branch ?? 'detached HEAD';
      return { summary: `Committed ${hash.slice(0, 7)} on ${where}: ${header}`, value: hash };
    });

    let push: GitOperation | null = null;
    if (input.push && outcome.operation.status === 'succeeded') {
      push = await this.push(repositoryRoot, input.setUpstream);
    }
    return { commit: outcome.operation, hash: outcome.value, push };
  }

  /**
   * Pushes the current branch to its upstream, or to an explicitly chosen remote
   * branch that becomes its upstream. Never forces.
   */
  async push(repositoryRoot: string, setUpstream?: GitSetUpstream): Promise<GitOperation> {
    const tree = await this.workingTree(repositoryRoot);
    const branch = tree.branch;
    if (branch === null) throw invalid('branch', 'Switch to a branch before pushing.');
    let args: string[];
    let destination: string;
    if (setUpstream !== undefined) {
      if (!(await this.remoteNames(repositoryRoot)).includes(setUpstream.remote)) {
        throw invalid('remote', 'Choose one of the configured remotes.');
      }
      await this.requireBranchName(repositoryRoot, setUpstream.branch);
      args = [
        'push',
        '--progress',
        '--set-upstream',
        setUpstream.remote,
        `refs/heads/${branch}:refs/heads/${setUpstream.branch}`,
      ];
      destination = `${setUpstream.remote}/${setUpstream.branch}`;
    } else {
      const [remote, merge] = await Promise.all([
        this.config(repositoryRoot, `branch.${branch}.remote`),
        this.config(repositoryRoot, `branch.${branch}.merge`),
      ]);
      if (remote === null || merge === null) throw new AtlasError('GIT_NO_UPSTREAM');
      // The remote is passed as an argument: it must be a configured remote (or ".").
      if (remote !== '.' && !(await this.remoteNames(repositoryRoot)).includes(remote)) {
        throw new AtlasError('GIT_NO_UPSTREAM');
      }
      args = ['push', '--progress', remote, `refs/heads/${branch}:${merge}`];
      destination = tree.upstream ?? `${remote}/${merge.replace(/^refs\/heads\//, '')}`;
    }
    const outcome = await this.mutate(
      repositoryRoot,
      'push',
      ['remote'],
      false,
      async ({ progress }) => {
        const result = await this.write(repositoryRoot, args, {
          timeoutMs: this.timeouts.network,
          onProgress: progress,
        });
        const upToDate = /Everything up-to-date/i.test(result.stderr);
        return {
          summary: upToDate ? 'Everything up-to-date.' : `Pushed ${branch} to ${destination}.`,
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

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

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
    // A staged rename is two index entries: the new path and the removed original.
    const paths = files.flatMap((file) =>
      file.originalPath !== null && file.staged === 'renamed'
        ? [file.path, file.originalPath]
        : [file.path],
    );
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
    maxOutputBytes?: number,
  ): Promise<GitExecResult>;
  private async read(
    repositoryRoot: string,
    args: string[],
    okExitCodes?: readonly number[],
    maxOutputBytes?: number,
  ): Promise<string | GitExecResult> {
    const result = await this.options.exec(['--literal-pathspecs', ...args], {
      cwd: repositoryRoot,
      timeoutMs: this.timeouts.read,
      okExitCodes: okExitCodes ?? [0],
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
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
