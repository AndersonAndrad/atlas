import type {
  AiProvider,
  AuditFinding,
  AuditMetrics,
  ProjectAudit,
  UsageProfile,
} from '@atlas/contracts';
import type { AuditFileInspector } from './validation.js';

/** Storage of audits and their findings (SQLite in the Engine). */
export interface AuditStore {
  insert(audit: ProjectAudit): Promise<void>;
  /** Replaces the audit's lifecycle and result fields (not its job). */
  update(audit: ProjectAudit): Promise<void>;
  /** Links the audit to its job; the only change to `jobId`. */
  setJob(auditId: string, jobId: string): Promise<void>;
  /** Saves the finished audit and its findings in one transaction. */
  complete(audit: ProjectAudit, findings: readonly AuditFinding[]): Promise<void>;
  get(id: string): Promise<ProjectAudit | null>;
  /** Newest first. */
  listForProject(projectId: string, limit: number): Promise<ProjectAudit[]>;
  /** QUEUED and RUNNING audits, oldest first. */
  listActive(): Promise<ProjectAudit[]>;
  /** Report order. */
  findings(auditId: string): Promise<AuditFinding[]>;
}

export interface AuditProject {
  id: string;
  name: string;
  workspacePath: string;
  /** The folder can be reached now. */
  available: boolean;
}

/** The kind of a path the user chose for the scope. */
export type AuditScopePathKind = 'file' | 'directory' | 'missing' | 'outside-project' | 'ignored';

/** Git status of the project folder: HEAD and the status line of every changed path. */
export interface AuditWorkspaceSnapshot {
  head: string | null;
  entries: ReadonlyMap<string, string>;
}

/** Read-only access to a project's folder. */
export interface AuditWorkspace {
  /** The path after resolving symbolic links, refused when it leaves the folder. */
  scopePath(root: string, relativePath: string): Promise<AuditScopePathKind>;
  /** Files with uncommitted changes; null when the folder is not in a Git repository. */
  changedFiles(root: string): Promise<string[] | null>;
  /** Null when the folder is not in a Git repository or Git cannot be read. */
  snapshot(root: string): Promise<AuditWorkspaceSnapshot | null>;
  inspector(root: string): AuditFileInspector;
}

export interface AuditProviderAvailability {
  available: boolean;
  /** Why it cannot run a read-only audit; null when available. */
  reason: string | null;
}

export interface AuditRunRequest {
  auditId: string;
  provider: AiProvider;
  /** The account profile's configuration directory; the CLI default when null. */
  profileDirectory: string | null;
  /** The project folder: the provider's working directory. */
  cwd: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Diagnostic output of the CLI (its standard error) for the job's log, which redacts it. */
  output(chunk: string): void;
  /** What the CLI did, e.g. a command Codex ran, as a line of the job's log. */
  log(line: string): void;
}

export type AuditRunOutcome =
  | { kind: 'completed'; answer: unknown; metrics: AuditMetrics }
  | { kind: 'failed'; summary: string; metrics: AuditMetrics | null }
  | { kind: 'cancelled' }
  | { kind: 'timed-out' };

/** Runs a provider CLI without a terminal, restricted to reading the project. */
export interface AuditProviderRunner {
  availability(provider: AiProvider): Promise<AuditProviderAvailability>;
  run(request: AuditRunRequest): Promise<AuditRunOutcome>;
}

/** The background job that runs an audit (SDD-012). */
export interface AuditJobs {
  submit(auditId: string): Promise<{ id: string }>;
  cancel(jobId: string): Promise<void>;
}

export interface AuditServiceDependencies {
  store: AuditStore;
  /** Null when the project is not registered. */
  project(projectId: string): Promise<AuditProject | null>;
  workspace: AuditWorkspace;
  runner: AuditProviderRunner;
  jobs: AuditJobs;
  profiles(): Promise<UsageProfile[]>;
  /** Called after every change of an audit, e.g. to publish it to the clients. */
  onChanged?: (audit: ProjectAudit) => void;
  clock: { now(): Date };
  generateId: () => string;
}
