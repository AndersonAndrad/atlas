import type {
  BackgroundJob,
  CreateCommandJob,
  CreatePreflightJob,
  JobAttempt,
  JobExecutionReference,
  JobOutputPage,
  JobPayload,
  JobStatus,
  JobStatusChange,
  JobType,
} from '@atlas/contracts';

/** A job as stored; what it can do now (`capabilities`) is worked out by the service. */
export type JobRecord = Omit<BackgroundJob, 'capabilities'>;

/** Storage of jobs, their attempts and status history (SQLite in the Engine). */
export interface JobRepository {
  insert(job: JobRecord, change: JobStatusChange): Promise<void>;
  /**
   * Replaces the job; also appends `change` to its history and inserts or replaces
   * `attempt`, all in one transaction.
   */
  save(job: JobRecord, change: JobStatusChange | null, attempt: JobAttempt | null): Promise<void>;
  find(id: string): Promise<JobRecord | null>;
  /** Newest first; `before` pages past a job. */
  list(query: {
    statuses?: readonly JobStatus[];
    projectId?: string;
    limit: number;
    before?: string;
  }): Promise<JobRecord[]>;
  /** Oldest first. */
  attempts(jobId: string): Promise<JobAttempt[]>;
  /** Oldest first. */
  history(jobId: string): Promise<JobStatusChange[]>;
  /**
   * Marks every unfinished job (and its open attempt) INTERRUPTED: their Engine stopped,
   * so nothing can still be running them. Returns the changed jobs.
   */
  interruptUnfinished(at: string, detail: string): Promise<JobRecord[]>;
  /** Deletes finished jobs beyond the newest `keep`; returns the deleted ids. */
  prune(keep: number): Promise<string[]>;
}

export type CreateJobRequest = CreateCommandJob | CreatePreflightJob;

/** What an executor resolved from a request; the service adds ids, times and status. */
export interface PreparedJob {
  title: string;
  description: string | null;
  projectId: string | null;
  workspacePath: string | null;
  payload: JobPayload;
}

export interface JobProgressUpdate {
  /** 0–100; null makes the job indeterminate again. */
  percent?: number | null;
  stage?: string | null;
  message?: string | null;
}

export interface JobExecutionContext {
  /** The job when it started. */
  readonly job: BackgroundJob;
  /** 1 for the first run, then one more per retry. */
  readonly attempt: number;
  /** Aborted when the user cancels the job or the Engine stops. */
  readonly signal: AbortSignal;
  /** Rate-limited by the service; any output also counts as activity. */
  progress(update: JobProgressUpdate): void;
  /** The execution started in another service, saved at once. */
  reference(reference: JobExecutionReference): void;
}

export interface JobExecutionResult {
  /** CANCELLED only when the work actually stopped because of the signal. */
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  /** Short and safe to show; never command output. */
  errorSummary?: string | null;
  exitCode?: number | null;
}

/**
 * Runs one type of job through an existing ATLAS service (FR-1203). Executors never
 * start a second process manager: they call the services that already run things.
 */
export interface JobExecutor {
  readonly type: JobType;
  /** Whether a running job can be stopped safely (FR-1207). */
  readonly cancellable: boolean;
  /** The service the executor calls already notifies about the outcome. */
  readonly notifiesOutcome: boolean;
  /** Validates the request and resolves what will run. Throws AtlasError. */
  prepare(request: CreateJobRequest): Promise<PreparedJob>;
  /** Must settle once the work stopped; a thrown error fails the job. */
  execute(context: JobExecutionContext): Promise<JobExecutionResult>;
  /** Something only one job may use at a time, e.g. a Preflight workspace. */
  resourceKey?(job: JobRecord): string | null;
  /** False while something outside the queue holds what the job needs. */
  isReady?(job: JobRecord): boolean;
  /** The payload a manual retry runs, e.g. without one-time authorizations. */
  retryPayload?(payload: JobPayload): JobPayload;
  /** Output of one attempt; absent when the executor keeps no log. */
  output?(job: JobRecord, attempt: number, after: number, limit: number): Promise<JobOutputPage>;
  /** Deletes the logs of removed jobs. */
  removeLogs?(jobId: string): Promise<void>;
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
