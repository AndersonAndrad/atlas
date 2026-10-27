import type { DebugAdapter } from '@atlas/contracts';

export interface AdapterProcessEvents {
  onStdout(chunk: Buffer): void;
  onStderr(chunk: Buffer): void;
  /** The adapter exited or could not start; called once. */
  onExit(code: number | null, signal: string | null, error: Error | null): void;
}

/** A running debug adapter process tree (Engine adapter over `process-tree`). */
export interface AdapterProcess {
  write(data: Buffer): void;
  /** Stops the whole tree: SIGTERM, then SIGKILL after a grace period. Idempotent. */
  stop(): void;
  /** Resolves when the process tree is gone. */
  readonly finished: Promise<void>;
  readonly pid: number | undefined;
}

export interface AdapterLaunch {
  command: string;
  args: readonly string[];
  cwd: string;
}

/** Starts adapter processes without a shell. */
export interface AdapterLauncher {
  launch(spec: AdapterLaunch, events: AdapterProcessEvents): AdapterProcess;
}

/** File system checks the session manager needs (Engine adapter). */
export interface DebugFileSystem {
  /**
   * The real path of an executable regular file, or null when it is missing, not a file or
   * not executable.
   */
  executable(absolutePath: string): Promise<string | null>;
  /** The real path of a folder, or null when it is not one. */
  directory(absolutePath: string): Promise<string | null>;
}

export type { DebugAdapter };
