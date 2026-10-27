import { stat } from 'node:fs/promises';
import type {
  GitRepositorySnapshot,
  GitStatus,
  GitUnavailableReason,
  PendingCommit,
} from '@atlas/contracts';
import { describeError, noopLogger, type Logger } from '@atlas/shared';
import { GitCommandError, type GitRunner } from './runner.js';
import { parseBranches, parseStatusV2 } from './porcelain.js';

export interface GitInspectionOptions {
  run: GitRunner;
  now?: () => Date;
  logger?: Logger;
  /** Per-command time limit. */
  timeoutMs?: number;
  /** Snapshots younger than this are served from cache. */
  cacheTtlMs?: number;
  /** Maximum concurrent git processes. */
  concurrency?: number;
}

interface CacheEntry {
  at: number;
  result: Promise<GitStatus>;
}

const RECENT_BRANCHES = 3;
const PENDING_SUBJECT_MAX_LENGTH = 500;
const PENDING_AUTHOR_MAX_LENGTH = 200;

/**
 * Read-only Git inspection. Never fetches, never mutates the repository, never
 * blocks the caller's event loop (git runs in child processes), and degrades to
 * an explicit "unavailable" state instead of inventing values.
 */
export class GitInspectionService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly queue: (() => void)[] = [];
  private running = 0;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly concurrency: number;

  constructor(private readonly options: GitInspectionOptions) {
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.cacheTtlMs = options.cacheTtlMs ?? 1500;
    this.concurrency = options.concurrency ?? 4;
  }

  /** Inspects the repository containing `directory` (which need not be its root). */
  inspect(directory: string, options: { fresh?: boolean } = {}): Promise<GitStatus> {
    const cached = this.cache.get(directory);
    if (!options.fresh && cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.result;
    }
    const result = this.inspectNow(directory);
    this.cache.set(directory, { at: Date.now(), result });
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  /** Drops cached results for a repository (e.g. after a change was detected). */
  invalidate(repositoryRoot?: string): void {
    if (repositoryRoot === undefined) {
      this.cache.clear();
      return;
    }
    for (const [directory, entry] of this.cache) {
      void entry.result.then((status) => {
        if (status.state === 'repository' && status.snapshot.repositoryRoot === repositoryRoot) {
          if (this.cache.get(directory) === entry) this.cache.delete(directory);
        }
      });
    }
  }

  /**
   * Commits reachable from `headOid` but not from `branch`'s upstream, newest first
   * (`git log <branch>@{upstream}..<headOid>`). The range is pinned to the inspected branch
   * and commit, so the list never mixes branches. Arguments only, no shell; read-only.
   */
  async pendingCommits(
    repositoryRoot: string,
    branch: string,
    headOid: string,
    page: { limit: number; skip?: number },
  ): Promise<PendingCommit[]> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headOid)) throw new Error('Invalid commit id.');
    if (branch === '' || branch.startsWith('-')) throw new Error('Invalid branch name.');
    const output = await this.git(repositoryRoot, [
      'log',
      `--max-count=${Math.max(1, Math.floor(page.limit))}`,
      `--skip=${Math.max(0, Math.floor(page.skip ?? 0))}`,
      '-z',
      '--no-color',
      '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s',
      `${branch}@{upstream}..${headOid}`,
      '--',
    ]);
    return output
      .split('\0')
      .filter((record) => record.trim() !== '')
      .map((record) => {
        const [hash = '', shortHash = '', author = '', date = '', subject = ''] = record
          .replace(/^\n/, '')
          .split('\x1f');
        // Bounded so a stored list always fits its row, whatever the commit messages.
        return {
          hash,
          shortHash,
          subject: subject.slice(0, PENDING_SUBJECT_MAX_LENGTH),
          author: author.slice(0, PENDING_AUTHOR_MAX_LENGTH),
          committedAt: date === '' ? null : date,
        };
      });
  }

  /** Absolute path of the repository's git directory, used for change watching. */
  async gitDirectory(directory: string): Promise<string | null> {
    try {
      return (await this.git(directory, ['rev-parse', '--absolute-git-dir'])).trim();
    } catch {
      return null;
    }
  }

  private async inspectNow(directory: string): Promise<GitStatus> {
    const inspectedAt = this.now().toISOString();
    // A missing cwd makes spawning fail with ENOENT, indistinguishable from a
    // missing git executable, so the directory is checked first.
    try {
      if (!(await stat(directory)).isDirectory()) {
        return { state: 'unavailable', reason: 'directory-unavailable', inspectedAt };
      }
    } catch {
      return { state: 'unavailable', reason: 'directory-unavailable', inspectedAt };
    }
    let repositoryRoot: string;
    try {
      repositoryRoot = (await this.git(directory, ['rev-parse', '--show-toplevel'])).trim();
    } catch (error) {
      return this.failure(error, inspectedAt, directory);
    }
    if (repositoryRoot === '') return { state: 'not-repository', inspectedAt };

    try {
      const [status, branches, name, email] = await Promise.all([
        this.git(repositoryRoot, [
          'status',
          '--porcelain=v2',
          '--branch',
          '-z',
          '--untracked-files=normal',
        ]),
        this.git(repositoryRoot, [
          'for-each-ref',
          '--sort=-committerdate',
          '--format=%(refname:short)%00%(committerdate:iso-strict)',
          'refs/heads',
        ]),
        this.configValue(repositoryRoot, 'user.name'),
        this.configValue(repositoryRoot, 'user.email'),
      ]);
      const parsed = parseStatusV2(status);
      const allBranches = parseBranches(branches);
      const snapshot: GitRepositorySnapshot = {
        repositoryRoot,
        branch: parsed.branch,
        detachedHead: parsed.detachedHead,
        unbornHead: parsed.unbornHead,
        headOid: parsed.headOid,
        identity: { name, email },
        localBranchCount: allBranches.length,
        recentBranches: allBranches.slice(0, RECENT_BRANCHES),
        changes: parsed.changes,
        upstream: parsed.upstream,
        ahead: parsed.upstreamGone ? null : parsed.ahead,
        behind: parsed.upstreamGone ? null : parsed.behind,
        upstreamGone: parsed.upstreamGone,
        inspectedAt,
      };
      return { state: 'repository', snapshot };
    } catch (error) {
      return this.failure(error, inspectedAt, directory);
    }
  }

  /** Effective value following git's configuration precedence; null when unset. */
  private async configValue(cwd: string, key: string): Promise<string | null> {
    try {
      const value = (await this.git(cwd, ['config', '--get', key])).trim();
      return value === '' ? null : value;
    } catch (error) {
      // `git config --get` exits with 1 when the key is not set.
      if (error instanceof GitCommandError && error.kind === 'failed' && error.exitCode === 1) {
        return null;
      }
      throw error;
    }
  }

  private failure(error: unknown, inspectedAt: string, directory: string): GitStatus {
    if (error instanceof GitCommandError) {
      if (error.kind === 'not-repository') return { state: 'not-repository', inspectedAt };
      const reason: GitUnavailableReason =
        error.kind === 'not-installed'
          ? 'not-installed'
          : error.kind === 'timeout'
            ? 'timeout'
            : error.kind === 'unsafe-ownership'
              ? 'unsafe-ownership'
              : 'error';
      // Expected conditions (no git, slow or untrusted repositories) recur on every
      // refresh; only unexpected failures are warnings.
      const level = reason === 'error' ? 'warn' : 'debug';
      this.logger[level]('Git inspection unavailable', { reason, error: describeError(error) });
      return { state: 'unavailable', reason, inspectedAt };
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') {
      return { state: 'unavailable', reason: 'directory-unavailable', inspectedAt };
    }
    this.logger.warn('Git inspection failed', { directory, error: describeError(error) });
    return { state: 'unavailable', reason: 'error', inspectedAt };
  }

  /** Runs one git command within the concurrency limit. */
  private async git(cwd: string, args: string[]): Promise<string> {
    await this.acquire();
    try {
      return await this.options.run(args, { cwd, timeoutMs: this.timeoutMs });
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return;
    }
    // The releasing caller hands its slot over, so `running` stays unchanged.
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.running -= 1;
  }
}
