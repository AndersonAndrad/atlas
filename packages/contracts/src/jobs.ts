import { z } from 'zod';
import { GitRemoteNameSchema, GitRepositoryRootSchema, GitSetUpstreamSchema } from './git.js';
import { PreflightStartSchema, type PreflightOutputPage } from './preflight.js';
import { ProjectIdSchema } from './project.js';

// ---------------------------------------------------------------------------
// Background jobs (SDD-012 Milestone A, PLAN-040)
// ---------------------------------------------------------------------------

export const JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'WAITING_APPROVAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses a job never leaves by itself; only a manual retry queues it again. */
export const FINAL_JOB_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'] as const;

export function isFinalJobStatus(status: JobStatus): boolean {
  return (FINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

/** Statuses a manual retry starts from. */
export const RETRYABLE_JOB_STATUSES = ['FAILED', 'CANCELLED', 'INTERRUPTED'] as const;

export const JOB_TYPES = [
  'COMMAND',
  'GIT',
  'PREFLIGHT',
  'AGENT',
  'ATLAS_SESSION',
  'INTEGRATION',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Higher priorities start first; jobs of the same priority start in queue order. */
export const JOB_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export type JobPriority = (typeof JOB_PRIORITIES)[number];

export const JOB_TITLE_MAX = 120;
export const JOB_DESCRIPTION_MAX = 500;
export const JOB_COMMAND_MAX = 4000;
export const JOB_STAGE_MAX = 120;
export const JOB_MESSAGE_MAX = 300;
export const JOB_ERROR_MAX = 500;
export const JOB_TIMEOUT_MINUTES_MAX = 24 * 60;
/** Finished jobs kept; older ones are removed with their logs. */
export const JOB_MAX_STORED = 500;
export const JOB_CONCURRENCY_MAX = 8;

export const JobIdSchema = z.uuid({ message: 'Invalid job identifier.' });

/** What a job reports while it runs; a job without a percentage is indeterminate. */
export interface JobProgress {
  /** 0–100, or null when the job cannot tell. */
  percent: number | null;
  /** E.g. "Running 2 of 5 checks". */
  stage: string | null;
  message: string | null;
  lastActivityAt: string | null;
}

/** The execution a job started in another ATLAS service. */
export type JobExecutionReference =
  | { type: 'preflight-run'; workspaceId: string; runId: string }
  /** The Git operation a GIT job runs (SDD-025); its log is the job's output. */
  | { type: 'git-operation'; operationId: string; repositoryRoot: string };

/** Git actions that run as background jobs (SDD-025 Task 01). */
export const GIT_JOB_ACTIONS = ['push', 'pull', 'fetch'] as const;
export type GitJobAction = (typeof GIT_JOB_ACTIONS)[number];

/** Who asked for the job. */
export type JobOrigin = 'desktop' | 'cli';

/** What a job runs; validated again by its executor before it is queued. */
export type JobPayload =
  | {
      type: 'COMMAND';
      /** Typed by the user; run by the user's shell in the project folder. */
      command: string;
      timeoutMinutes: number;
      /** The user confirmed the warnings ATLAS showed for this command. */
      confirmedDangerous: boolean;
    }
  | {
      type: 'PREFLIGHT';
      workspaceId: string;
      profileId: string | null;
      checkIds: string[] | null;
      concurrency?: number;
      /** Digests the user authorized when queueing; a retry never reuses them. */
      authorizations: { checkId: string; digest: string }[];
    }
  | {
      type: 'GIT';
      action: GitJobAction;
      repositoryRoot: string;
      /** Push only: publish to this remote branch, which becomes the upstream. */
      setUpstream?: { remote: string; branch: string };
      /** Pull only. */
      mode?: 'ff-only' | 'configured';
      /** Fetch only; the default remote when absent. */
      remote?: string;
    };

export interface BackgroundJob {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: JobPriority;
  projectId: string | null;
  workspacePath: string | null;
  sessionId: string | null;
  /** Plain text; never rendered as HTML. */
  title: string;
  description: string | null;
  origin: JobOrigin;
  payload: JobPayload;
  createdAt: string;
  /** When the job last entered the queue (creation or retry). */
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: JobProgress;
  /** Manual retries so far. */
  retryCount: number;
  /** Automatic retries allowed; always 0 until retry policies exist (Milestone B). */
  maxRetries: number;
  executionReference: JobExecutionReference | null;
  /** Short and safe to show; never command output. */
  errorSummary: string | null;
  exitCode: number | null;
  /** Cancellation was asked for and the executor is stopping the job. */
  cancelRequested: boolean;
  /** What the job's executor supports in its current state. */
  capabilities: { cancel: boolean; retry: boolean; logs: boolean };
}

export interface JobAttempt {
  jobId: string;
  /** 1 for the first run, then one more per retry. */
  attempt: number;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  errorSummary: string | null;
  executionReference: JobExecutionReference | null;
}

export interface JobStatusChange {
  jobId: string;
  status: JobStatus;
  at: string;
  /** Why the status changed, e.g. "Cancelled by the user". */
  detail: string | null;
}

export interface JobDetails {
  job: BackgroundJob;
  /** Oldest first. */
  attempts: JobAttempt[];
  /** Oldest first. */
  history: JobStatusChange[];
}

const TitleSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(JOB_TITLE_MAX, `Use at most ${JOB_TITLE_MAX} characters.`);

export const CreateCommandJobSchema = z.strictObject({
  type: z.literal('COMMAND'),
  projectId: ProjectIdSchema,
  title: TitleSchema.optional(),
  command: z
    .string()
    .trim()
    .min(1, 'Enter a command.')
    .max(JOB_COMMAND_MAX, `Use at most ${JOB_COMMAND_MAX} characters.`)
    .refine((value) => !value.includes('\0'), 'The command cannot contain a NUL character.'),
  timeoutMinutes: z.number().int().min(1).max(JOB_TIMEOUT_MINUTES_MAX).default(30),
  priority: z.enum(JOB_PRIORITIES).default('NORMAL'),
  /** Required when ATLAS warns about the command (JOB_CONFIRMATION_REQUIRED). */
  confirmDangerous: z.boolean().default(false),
});

export const CreatePreflightJobSchema = z.strictObject({
  type: z.literal('PREFLIGHT'),
  title: TitleSchema.optional(),
  priority: z.enum(JOB_PRIORITIES).default('NORMAL'),
  /** As for `preflight.start`; a retry of a run is started from Preflight itself. */
  selection: PreflightStartSchema.omit({ retryOf: true }),
});

/**
 * A push, pull or fetch confirmed in its dialog (SDD-025). Validated like the direct
 * actions before it is queued; the repository must be one the Engine resolved.
 */
export const CreateGitJobSchema = z.discriminatedUnion('action', [
  z.strictObject({
    type: z.literal('GIT'),
    action: z.literal('push'),
    repositoryRoot: GitRepositoryRootSchema,
    setUpstream: GitSetUpstreamSchema.optional(),
    priority: z.enum(JOB_PRIORITIES).default('NORMAL'),
  }),
  z.strictObject({
    type: z.literal('GIT'),
    action: z.literal('pull'),
    repositoryRoot: GitRepositoryRootSchema,
    mode: z.enum(['ff-only', 'configured']),
    priority: z.enum(JOB_PRIORITIES).default('NORMAL'),
  }),
  z.strictObject({
    type: z.literal('GIT'),
    action: z.literal('fetch'),
    repositoryRoot: GitRepositoryRootSchema,
    remote: GitRemoteNameSchema.optional(),
    priority: z.enum(JOB_PRIORITIES).default('NORMAL'),
  }),
]);

export const CreateJobSchema = z.union([
  CreateCommandJobSchema,
  CreatePreflightJobSchema,
  CreateGitJobSchema,
]);
export type CreateJobInput = z.input<typeof CreateJobSchema>;
export type CreateCommandJob = z.output<typeof CreateCommandJobSchema>;
export type CreatePreflightJob = z.output<typeof CreatePreflightJobSchema>;
export type CreateGitJob = z.output<typeof CreateGitJobSchema>;

export const JobListQuerySchema = z.strictObject({
  statuses: z.array(z.enum(JOB_STATUSES)).min(1).max(JOB_STATUSES.length).optional(),
  projectId: ProjectIdSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  /** A job id from `nextBefore`: only older jobs. */
  before: JobIdSchema.optional(),
});
export type JobListQuery = z.input<typeof JobListQuerySchema>;

export interface JobPage {
  /** Newest first. */
  jobs: BackgroundJob[];
  /** Pass as `before` for older jobs; null at the end. */
  nextBefore: string | null;
}

/** Jobs of this Engine that have not finished. */
export interface JobSummary {
  running: number;
  queued: number;
  waitingApproval: number;
}

export const JobOutputQuerySchema = z.strictObject({
  jobId: JobIdSchema,
  /** Defaults to the latest attempt. */
  attempt: z.number().int().min(1).max(10_000).optional(),
  /** Lines after this sequence number; -1 from the start. */
  after: z.number().int().min(-1),
  limit: z.number().int().min(1).max(5000).optional(),
});
export type JobOutputQuery = z.input<typeof JobOutputQuerySchema>;
/** Same lines and paging as Preflight output. */
export type JobOutputPage = PreflightOutputPage;

const ConcurrencySchema = z.number().int().min(1).max(JOB_CONCURRENCY_MAX);

export const JobSettingsSchema = z.strictObject({
  /** Jobs running at the same time. */
  maxConcurrentJobs: ConcurrencySchema.default(2),
  /** Jobs of the same project running at the same time. */
  maxJobsPerProject: ConcurrencySchema.default(1),
});
export type JobSettings = z.output<typeof JobSettingsSchema>;

export const UpdateJobSettingsSchema = z
  .strictObject({
    maxConcurrentJobs: ConcurrencySchema.optional(),
    maxJobsPerProject: ConcurrencySchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'At least one setting must be provided.',
  });
export type UpdateJobSettingsInput = z.input<typeof UpdateJobSettingsSchema>;
