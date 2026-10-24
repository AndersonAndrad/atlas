import type {
  PreflightActSettings,
  PreflightEnvironmentStatus,
  PreflightOutputLine,
  PreflightRun,
  PreflightRunSummary,
  PreflightWorkspace,
} from '@atlas/contracts';
import type { WorkspaceFiles } from './discovery.js';

/** Storage of workspaces, authorizations and runs (SQLite in the Engine, memory in tests). */
export interface PreflightRepository {
  listWorkspaces(): Promise<PreflightWorkspace[]>;
  /** The workspace and its stored configuration document (unparsed). */
  findWorkspace(id: string): Promise<{ workspace: PreflightWorkspace; config: string } | null>;
  findWorkspaceByPath(path: string): Promise<PreflightWorkspace | null>;
  insertWorkspace(workspace: PreflightWorkspace, config: string): Promise<void>;
  updateWorkspace(workspace: PreflightWorkspace, config: string): Promise<void>;
  /** Removes the workspace with its authorizations and runs. */
  removeWorkspace(id: string): Promise<void>;
  /** `current`: this exact definition was authorized; `other`: an earlier one was. */
  authorizationState(
    workspaceId: string,
    checkId: string,
    digest: string,
  ): Promise<'current' | 'other' | 'none'>;
  authorize(workspaceId: string, checkId: string, digest: string, at: string): Promise<void>;
  insertRun(run: PreflightRun): Promise<void>;
  /** Replaces the run's state and results. */
  updateRun(run: PreflightRun): Promise<void>;
  findRun(id: string): Promise<PreflightRun | null>;
  /** Newest first; `before` pages past a run. */
  listRuns(workspaceId: string, limit: number, before?: string): Promise<PreflightRunSummary[]>;
  /** Marks runs left RUNNING by a stopped Engine as cancelled; returns their ids. */
  interruptRunning(at: string): Promise<string[]>;
  /** Deletes all but the newest `keep` finished runs; returns the deleted ids. */
  pruneRuns(workspaceId: string, keep: number): Promise<string[]>;
}

/** What one check runs. Commands are never assembled from untrusted text. */
export type CheckInvocation =
  /** A user-written command, run by the user's shell as typed in a terminal. */
  | { kind: 'shell'; command: string }
  /** `<manager> run <script>`; the adapter quotes the script name. */
  | { kind: 'package-script'; manager: string; script: string }
  /** `act` with an argument list built by the adapter; never through a shell. */
  | {
      kind: 'act';
      workflowPath: string;
      job: string | null;
      settings: PreflightActSettings;
    };

export interface CheckExecution {
  invocation: CheckInvocation;
  /** Absolute folder the process starts in (inside the workspace). */
  cwd: string;
  /** Variables the check defines; added to the base environment. */
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput(stream: 'out' | 'err', chunk: string): void;
}

export interface CheckOutcome {
  /** `exited`: the process ended by itself (any exit code). */
  kind: 'exited' | 'timed-out' | 'cancelled' | 'start-failed';
  exitCode: number | null;
  /** Short and safe to show, e.g. "exited with code 1". */
  detail: string;
}

/** Runs checks as processes; implemented by the Engine host. */
export interface PreflightExecutor {
  run(execution: CheckExecution): Promise<CheckOutcome>;
  /** Whether an executable is found on the PATH checks run with. */
  hasTool(name: string): Promise<boolean>;
  /** E.g. "Local shell (/bin/zsh)". */
  readonly shellLabel: string;
}

/** `act` and Docker availability (FR-707). */
export interface PreflightTools {
  status(refresh: boolean): Promise<PreflightEnvironmentStatus>;
  /** `act` configuration files that may add options or secrets, e.g. `~/.actrc`. */
  actConfigFiles(workspacePath: string): Promise<string[]>;
}

/** Where the code of a workspace stands (FR-713). */
export interface SourceState {
  revision: string | null;
  branch: string | null;
  fingerprint: string;
}

export interface SourceStateReader {
  /** Null outside a Git repository. */
  read(workspacePath: string): Promise<SourceState | null>;
}

export interface WorkspaceFileAccess {
  /** Read-only files of a folder; paths outside it are refused. */
  files(workspacePath: string): WorkspaceFiles;
  isDirectory(path: string): Promise<boolean>;
  /**
   * The real path of a folder inside the workspace, links resolved; null when it does
   * not exist, is not a folder, or resolves outside the workspace.
   */
  folderInside(workspacePath: string, relative: string): Promise<string | null>;
}

/** Finished checks' output. Lines are already redacted. */
export interface PreflightLogStore {
  write(
    runId: string,
    position: number,
    log: { firstSeq: number; lines: PreflightOutputLine[] },
  ): Promise<void>;
  read(
    runId: string,
    position: number,
  ): Promise<{ firstSeq: number; lines: PreflightOutputLine[] } | null>;
  remove(runId: string): Promise<void>;
}
