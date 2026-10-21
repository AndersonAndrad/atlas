export type GitFailureKind =
  | 'not-installed'
  | 'timeout'
  | 'cancelled'
  | 'unsafe-ownership'
  | 'not-repository'
  /** Git wrote more output than the executor accepts; the process was stopped. */
  | 'output-too-large'
  | 'failed';

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
  /**
   * Opts into partial output: Git is stopped once standard output reaches this size
   * and the result has `truncated` set. Only for reading commands. Without it,
   * output beyond the executor's hard limit fails with `output-too-large`.
   */
  maxOutputBytes?: number;
  /** Receives each progress line Git writes to standard error. */
  onProgress?: (line: string) => void;
  /**
   * Environment of this command instead of the executor's, e.g. the user's fresh shell
   * environment for commits so hooks see what a new terminal sees.
   */
  env?: Record<string, string>;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  /** Git's exit code; -1 when Git was stopped after `maxOutputBytes`. */
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
