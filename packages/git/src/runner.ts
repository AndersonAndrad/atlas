export type GitFailureKind =
  'not-installed' | 'timeout' | 'cancelled' | 'unsafe-ownership' | 'not-repository' | 'failed';

export class GitCommandError extends Error {
  constructor(
    readonly kind: GitFailureKind,
    message: string,
    readonly exitCode: number | null = null,
    /** Raw output of the failed command. May contain secrets: sanitize before exposing. */
    readonly output: { stdout: string; stderr: string } = { stdout: '', stderr: '' },
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

export interface GitExecOptions extends GitRunOptions {
  /** Written to the process's standard input, e.g. a commit message for `-F -`. */
  input?: string;
  /** Exit codes treated as success. Defaults to `[0]`. */
  okExitCodes?: readonly number[];
  /** Standard output beyond this size is discarded and `truncated` is set. */
  maxOutputBytes?: number;
  /** Receives each progress line Git writes to standard error. */
  onProgress?: (line: string) => void;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Standard output was cut at `maxOutputBytes`. */
  truncated: boolean;
}

/**
 * Runs any git command, including mutations, without a shell. Fails with
 * `GitCommandError` for exit codes outside `okExitCodes`.
 */
export type GitExecutor = (
  args: readonly string[],
  options: GitExecOptions,
) => Promise<GitExecResult>;
