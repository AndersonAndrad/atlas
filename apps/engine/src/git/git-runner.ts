import { execFile } from 'node:child_process';

export type GitFailureKind =
  'not-installed' | 'timeout' | 'unsafe-ownership' | 'not-repository' | 'failed';

export class GitCommandError extends Error {
  constructor(
    readonly kind: GitFailureKind,
    message: string,
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

export interface GitRunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Runs read-only git commands. Injectable so tests can simulate failures. */
export type GitRunner = (args: string[], options: GitRunOptions) => Promise<string>;

/**
 * Options applied to every invocation:
 * - `core.fsmonitor=false`: a repository's config could otherwise make `git status`
 *   execute an arbitrary fsmonitor command.
 * - `--no-optional-locks`: inspection never writes the index or takes locks.
 */
const SAFE_PREFIX = ['-c', 'core.fsmonitor=false', '--no-optional-locks'];
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Environment for git: no inherited GIT_* overrides, no prompts, stable output. */
export function gitEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !name.startsWith('GIT_')) env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  return env;
}

/**
 * Creates a runner that executes `git` without a shell: arguments are passed as
 * an array, so nothing is ever interpolated into a command line.
 */
export function createGitRunner(
  options: { executable?: string; env?: Record<string, string | undefined> } = {},
): GitRunner {
  const executable = options.executable ?? 'git';
  const env = gitEnvironment(options.env ?? process.env);
  return (args, { cwd, timeoutMs, signal }) =>
    new Promise((resolve, reject) => {
      execFile(
        executable,
        [...SAFE_PREFIX, ...args],
        {
          cwd,
          env,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          encoding: 'utf8',
          ...(signal ? { signal } : {}),
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
            return;
          }
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
          if (failure.code === 'ENOENT') {
            reject(new GitCommandError('not-installed', 'git executable not found'));
          } else if (failure.killed || failure.name === 'AbortError') {
            reject(new GitCommandError('timeout', 'git command timed out'));
          } else if (/dubious ownership/i.test(stderr)) {
            reject(new GitCommandError('unsafe-ownership', 'repository ownership not trusted'));
          } else if (/not a git repository/i.test(stderr)) {
            reject(new GitCommandError('not-repository', 'not a git repository', 128));
          } else {
            const exitCode = typeof failure.code === 'number' ? failure.code : null;
            reject(new GitCommandError('failed', `git exited with ${String(exitCode)}`, exitCode));
          }
        },
      );
    });
}
