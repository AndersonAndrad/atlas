/** What one Docker CLI call produced. */
export interface DockerCliResult {
  /** Null when the process was stopped (timeout) or could not start. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface DockerCliStream {
  /** Stops the process and everything it started. Idempotent. */
  stop(): void;
  /** Settles with the exit code once the process ended. */
  readonly done: Promise<number | null>;
}

/**
 * Runs the Docker CLI with an argument list, never through a shell (SDD-013 §3.2). The
 * Engine implements it with the user's PATH and Docker configuration.
 */
export interface DockerRunner {
  /** Whether a `docker` executable is found. */
  available(): Promise<boolean>;
  run(args: readonly string[], options?: { timeoutMs?: number }): Promise<DockerCliResult>;
  /**
   * Writes `content` to a file only the user can read, passes its path to `use`, and
   * deletes it afterwards (e.g. an `--env-file`, so values never reach a command line).
   */
  withPrivateFile<T>(content: string, use: (file: string) => Promise<T>): Promise<T>;
  /** A long-running command, e.g. `logs --follow` or `events`. */
  stream(
    args: readonly string[],
    onData: (stream: 'out' | 'err', chunk: string) => void,
  ): DockerCliStream;
}

/** Lines of a followed log, bounded and redacted (Preflight's LogBuffer in the Engine). */
export interface DockerLogLines {
  append(stream: 'out' | 'err', chunk: string): void;
  note(text: string): void;
  finish(): void;
  read(
    after: number,
    limit: number,
  ): { seq: number; stream: 'out' | 'err' | 'atlas'; text: string }[];
  readonly firstSeq: number;
  readonly count: number;
  readonly complete: boolean;
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
