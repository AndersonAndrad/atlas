import type { GitExecResult, GitExecutor } from './runner.js';

const MAX_COMMITS = 50;
const MAX_FILES = 500;

/**
 * Read-only repository facts for shared context (SDD-005): current state, file
 * fingerprints, ancestry, and what changed since a base commit. Never mutates, and
 * reports `null` / empty results instead of failing when Git cannot answer.
 */
export class RepositoryEvidence {
  constructor(
    private readonly exec: GitExecutor,
    private readonly timeoutMs = 15_000,
  ) {}

  private run(cwd: string, args: string[], okExitCodes: number[] = [0]): Promise<GitExecResult> {
    return this.exec(['--literal-pathspecs', ...args], {
      cwd,
      timeoutMs: this.timeoutMs,
      okExitCodes,
    });
  }

  async state(directory: string): Promise<{
    root: string | null;
    branch: string | null;
    head: string | null;
    uncommittedFiles: number;
  }> {
    let root: string;
    try {
      root = (await this.run(directory, ['rev-parse', '--show-toplevel'])).stdout.trim();
    } catch {
      return { root: null, branch: null, head: null, uncommittedFiles: 0 };
    }
    const [branch, head, status] = await Promise.all([
      this.run(root, ['branch', '--show-current']),
      this.run(root, ['rev-parse', '--verify', '-q', 'HEAD'], [0, 1]),
      this.run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    ]);
    return {
      root,
      branch: branch.stdout.trim() || null,
      head: head.exitCode === 0 ? head.stdout.trim() : null,
      uncommittedFiles: status.stdout.split('\0').filter((entry) => entry.length > 3).length,
    };
  }

  async fileHash(root: string, file: string): Promise<string | null> {
    try {
      const result = await this.run(root, ['hash-object', '--', file], [0, 128]);
      return result.exitCode === 0 ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  async isAncestor(root: string, commit: string, head: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) return false;
    const result = await this.run(root, ['merge-base', '--is-ancestor', commit, head], [0, 1, 128]);
    return result.exitCode === 0;
  }

  async commitsSince(
    root: string,
    base: string | null,
  ): Promise<{ hash: string; subject: string }[]> {
    if (base !== null && !/^[0-9a-f]{7,64}$/i.test(base)) return [];
    const range =
      base === null
        ? ['-n', String(MAX_COMMITS), 'HEAD']
        : ['-n', String(MAX_COMMITS), `${base}..HEAD`];
    const result = await this.run(root, ['log', '--format=%H%x00%s', ...range], [0, 128]);
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split('\n')
      .filter((line) => line.includes('\0'))
      .map((line) => {
        const [hash = '', subject = ''] = line.split('\0');
        return { hash, subject };
      });
  }

  async changedFilesSince(root: string, base: string | null): Promise<string[]> {
    const validBase = base !== null && /^[0-9a-f]{7,64}$/i.test(base) ? base : null;
    const [diff, untracked] = await Promise.all([
      // Committed and uncommitted changes since the base (or just uncommitted ones).
      this.run(
        root,
        ['diff', '--name-only', '-z', ...(validBase ? [validBase] : ['HEAD'])],
        [0, 128],
      ),
      this.run(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    const files = new Set<string>();
    for (const output of [diff.exitCode === 0 ? diff.stdout : '', untracked.stdout]) {
      for (const file of output.split('\0')) if (file !== '') files.add(file);
    }
    return [...files].sort().slice(0, MAX_FILES);
  }
}
