import type { ShellCatalog, TerminalGroup, TerminalSession } from '@atlas/contracts';

export interface PtySpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  columns: number;
  rows: number;
}

export interface PtyExit {
  exitCode: number;
  /** Signal number that ended the process, when it was killed by a signal. */
  signal?: number;
}

/** A running pseudoterminal process. Implementations wrap a PTY library such as node-pty. */
export interface PtyProcess {
  readonly pid: number;
  /** Name of the foreground process, when the platform can report it. */
  readonly foregroundProcess: string | undefined;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  pause(): void;
  resume(): void;
  /** Requests termination. `SIGKILL` forces it. Signals are ignored where unsupported. */
  kill(signal?: 'SIGHUP' | 'SIGKILL'): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: PtyExit) => void): void;
}

export interface PtySpawner {
  /** Throws when the process cannot be started. */
  spawn(options: PtySpawnOptions): PtyProcess;
}

/**
 * Off-screen terminal emulator that mirrors a session's screen so a new view can
 * be rebuilt (including full-screen applications) after it was hidden or reloaded.
 */
export interface ScreenMirror {
  /** `callback` runs once `data` has been parsed into the mirror. */
  write(data: string, callback?: () => void): void;
  resize(columns: number, rows: number): void;
  clear(): void;
  serialize(): string;
  dispose(): void;
}

export interface ScreenMirrorFactory {
  create(columns: number, rows: number): ScreenMirror;
}

export interface TerminalSessionRepository {
  findAll(): Promise<TerminalSession[]>;
  /** Inserts or replaces the session metadata. */
  save(session: TerminalSession): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Marks sessions left non-final by a previous Engine run as TERMINATED with
   * end reason `engine-lost`. Returns the number of affected sessions.
   */
  markInterrupted(endedAt: string): Promise<number>;
}

export interface ShellProvider {
  /** Lists available shells; `preferredId` marks the user's default when available. */
  catalog(preferredId: string | null): Promise<ShellCatalog>;
}

export interface WorkspaceResolver {
  /**
   * Returns the realpath of the registered project's workspace directory.
   * Throws PROJECT_NOT_FOUND or a path availability error otherwise.
   */
  resolveProjectDirectory(projectId: string): Promise<string>;
  /**
   * Validates an absolute directory for a standalone terminal and returns its
   * realpath. Throws a path validation or availability error otherwise.
   */
  resolveDirectory(path: string): Promise<string>;
  /** Throws PROJECT_NOT_FOUND unless the project is registered. */
  assertProjectExists(projectId: string): Promise<void>;
  homeDirectory(): string;
}

/** Reads the current working directory of a running process. */
export interface ProcessCwdResolver {
  /** Returns null when the platform cannot report it reliably. */
  currentDirectory(pid: number): Promise<string | null>;
}

export interface TerminalGroupRepository {
  findAll(): Promise<TerminalGroup[]>;
  /** Inserts or updates one group. */
  save(group: TerminalGroup): Promise<void>;
  /** Stores the positions of several groups atomically. */
  saveAll(groups: TerminalGroup[]): Promise<void>;
  delete(id: string): Promise<void>;
}

/** String key-value storage, implemented by the application settings repository. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The terminal a shell environment is built for. */
export interface ShellEnvironmentTarget {
  projectId: string | null;
  cwd: string;
}

export interface EnvironmentProvider {
  /** Environment for a new shell, without Electron or Engine internals. */
  shellEnvironment(terminal?: ShellEnvironmentTarget): Record<string, string>;
}
