import { z } from 'zod';
import { ProjectIdSchema, WorkspacePathSchema } from './project.js';

/**
 * Lifecycle of an ATLAS Session (SDD-003 FR-315). Transitions are defined by the
 * session state machine in @atlas/sessions; no other status change is accepted.
 *
 * - WAITING_EXECUTOR: started, but no execution adapter exists to run it.
 * - RUNNING / WAITING_APPROVAL / COMPLETED / FAILED: reached only through an
 *   execution adapter (none exists before SDD-004).
 * - INTERRUPTED: work was in flight when the Engine stopped; never resumed automatically.
 */
export const SESSION_STATUSES = [
  'DRAFT',
  'READY',
  'WAITING_EXECUTOR',
  'RUNNING',
  'PAUSED',
  'WAITING_APPROVAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
] as const;

export type AtlasSessionStatus = (typeof SESSION_STATUSES)[number];

/** Statuses after which a session never changes again (other than being archived). */
export const FINAL_SESSION_STATUSES: readonly AtlasSessionStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

export function isFinalSessionStatus(status: AtlasSessionStatus): boolean {
  return FINAL_SESSION_STATUSES.includes(status);
}

/** Statuses in which an executor is actually working on the session. */
export const EXECUTING_SESSION_STATUSES: readonly AtlasSessionStatus[] = [
  'RUNNING',
  'WAITING_APPROVAL',
];

export function isExecutingSessionStatus(status: AtlasSessionStatus): boolean {
  return EXECUTING_SESSION_STATUSES.includes(status);
}

export const EXECUTION_PROFILES = ['ECONOMY', 'BALANCED', 'MAXIMUM'] as const;
export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

/** Lifecycle operations a user (desktop or CLI) may request. */
export const SESSION_ACTIONS = [
  'markReady',
  'returnToDraft',
  'start',
  'pause',
  'resume',
  'cancel',
  'archive',
] as const;

export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const SESSION_NAME_MAX_LENGTH = 120;
export const SESSION_OBJECTIVE_MAX_LENGTH = 4000;
export const SESSION_CONSTRAINT_MAX_LENGTH = 500;
export const SESSION_CONSTRAINTS_MAX_COUNT = 20;
export const SESSION_TASK_TITLE_MAX_LENGTH = 200;
export const SESSION_TASK_DESCRIPTION_MAX_LENGTH = 4000;
export const SESSION_TASK_CRITERIA_MAX_COUNT = 20;
export const SESSION_TASKS_MAX_COUNT = 200;
export const SESSION_TASK_DEPENDENCIES_MAX_COUNT = 20;
/** Events returned by one history request (the most recent ones). */
export const SESSION_EVENTS_PAGE_SIZE = 500;

// eslint-disable-next-line no-control-regex
const SINGLE_LINE_CONTROL = /[\u0000-\u001f\u007f]/;
// Multi-line text keeps tabs and line breaks only.
// eslint-disable-next-line no-control-regex
const MULTI_LINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const singleLine = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be at most ${max} characters.`)
    .refine((value) => !SINGLE_LINE_CONTROL.test(value), `${label} contains invalid characters.`);

const multiLine = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .refine((value) => !MULTI_LINE_CONTROL.test(value), `${label} contains invalid characters.`);

export const AtlasSessionIdSchema = z.uuid({ message: 'Invalid session identifier.' });
export const SessionTaskIdSchema = z.uuid({ message: 'Invalid task identifier.' });

export const SessionNameSchema = singleLine('Name', SESSION_NAME_MAX_LENGTH);
export const SessionObjectiveSchema = multiLine('Objective', SESSION_OBJECTIVE_MAX_LENGTH).refine(
  (value) => value.length > 0,
  'Objective is required.',
);
const ConstraintsSchema = z
  .array(singleLine('Constraint', SESSION_CONSTRAINT_MAX_LENGTH))
  .max(SESSION_CONSTRAINTS_MAX_COUNT, `At most ${SESSION_CONSTRAINTS_MAX_COUNT} constraints.`);
export const ExecutionProfileSchema = z.enum(EXECUTION_PROFILES);
export const SessionActionSchema = z.enum(SESSION_ACTIONS);

/**
 * A session works in a registered project, in a standalone directory, or has no
 * workspace yet. Desktop clients may only pass directories chosen in the native picker.
 */
export const CreateSessionInputSchema = z
  .strictObject({
    name: SessionNameSchema,
    objective: SessionObjectiveSchema,
    projectId: ProjectIdSchema.optional(),
    workspacePath: WorkspacePathSchema.optional(),
    executionProfile: ExecutionProfileSchema.default('BALANCED'),
    constraints: ConstraintsSchema.default([]),
  })
  .refine((input) => input.projectId === undefined || input.workspacePath === undefined, {
    message: 'A session works in a project or in a directory, not both.',
    path: ['workspacePath'],
  });

export type CreateSessionInput = z.input<typeof CreateSessionInputSchema>;

/** Draft edits. `projectId` / `workspacePath` set to `null` clear the workspace. */
export const UpdateSessionInputSchema = z
  .strictObject({
    name: SessionNameSchema.optional(),
    objective: SessionObjectiveSchema.optional(),
    projectId: ProjectIdSchema.nullable().optional(),
    workspacePath: WorkspacePathSchema.nullable().optional(),
    executionProfile: ExecutionProfileSchema.optional(),
    constraints: ConstraintsSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'At least one field must be provided.',
  })
  .refine((input) => !(input.projectId != null && input.workspacePath != null), {
    message: 'A session works in a project or in a directory, not both.',
    path: ['workspacePath'],
  });

export type UpdateSessionInput = z.input<typeof UpdateSessionInputSchema>;

export const ListSessionsInputSchema = z
  .strictObject({
    includeArchived: z.boolean().optional(),
    projectId: ProjectIdSchema.optional(),
  })
  .default({});

export type ListSessionsInput = z.input<typeof ListSessionsInputSchema>;

/** A persistent orchestration operation (SDD-003 FR-315). */
export interface AtlasSession {
  id: string;
  name: string;
  objective: string;
  /** Registered project the session works in; its directory is the workspace. */
  projectId: string | null;
  /** Standalone workspace directory; `null` for project sessions and sessions without one. */
  workspacePath: string | null;
  status: AtlasSessionStatus;
  executionProfile: ExecutionProfile;
  constraints: string[];
  createdAt: string;
  updatedAt: string;
  /** When an executor actually began working. Never set while waiting for one. */
  startedAt: string | null;
  /** Set only for COMPLETED sessions; cancellation and failure are not completion. */
  completedAt: string | null;
  /** When the session reached a final status. */
  endedAt: string | null;
  archivedAt: string | null;
}

export const SESSION_TASK_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
] as const;

export type SessionTaskStatus = (typeof SESSION_TASK_STATUSES)[number];

const TaskTitleSchema = singleLine('Title', SESSION_TASK_TITLE_MAX_LENGTH);
const TaskDescriptionSchema = multiLine('Description', SESSION_TASK_DESCRIPTION_MAX_LENGTH);
const CriteriaSchema = z
  .array(singleLine('Validation criterion', SESSION_CONSTRAINT_MAX_LENGTH))
  .max(SESSION_TASK_CRITERIA_MAX_COUNT, `At most ${SESSION_TASK_CRITERIA_MAX_COUNT} criteria.`);
const DependenciesSchema = z
  .array(SessionTaskIdSchema)
  .max(
    SESSION_TASK_DEPENDENCIES_MAX_COUNT,
    `At most ${SESSION_TASK_DEPENDENCIES_MAX_COUNT} dependencies.`,
  )
  .transform((ids) => [...new Set(ids)]);

export const CreateSessionTaskInputSchema = z.strictObject({
  title: TaskTitleSchema,
  description: TaskDescriptionSchema.default(''),
  dependencies: DependenciesSchema.default([]),
  validationCriteria: CriteriaSchema.default([]),
});

export type CreateSessionTaskInput = z.input<typeof CreateSessionTaskInputSchema>;

export const UpdateSessionTaskInputSchema = z
  .strictObject({
    title: TaskTitleSchema.optional(),
    description: TaskDescriptionSchema.optional(),
    dependencies: DependenciesSchema.optional(),
    validationCriteria: CriteriaSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'At least one field must be provided.',
  });

export type UpdateSessionTaskInput = z.input<typeof UpdateSessionTaskInputSchema>;

/** A unit of work for future agent delegation (SDD-003 FR-319). */
export interface SessionTask {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  status: SessionTaskStatus;
  /** Tasks of the same session that must complete first. */
  dependencies: string[];
  /** Dependencies that have not completed yet (derived, never stored). */
  blockedBy: string[];
  assignedAgentId: string | null;
  validationCriteria: string[];
  createdAt: string;
  updatedAt: string;
}

export const SESSION_EVENT_TYPES = [
  'SESSION_CREATED',
  'SESSION_UPDATED',
  'SESSION_READY',
  'SESSION_RETURNED_TO_DRAFT',
  'SESSION_WAITING_EXECUTOR',
  'SESSION_STARTED',
  'SESSION_PAUSED',
  'SESSION_RESUMED',
  'SESSION_CANCELLED',
  'SESSION_INTERRUPTED',
  'SESSION_COMPLETED',
  'SESSION_FAILED',
  'SESSION_ARCHIVED',
  'SESSION_PROJECT_DETACHED',
  'TASK_CREATED',
  'TASK_UPDATED',
  'TASK_REMOVED',
  'TASK_CANCELLED',
  'APPROVAL_REQUESTED',
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * Structured, allow-listed event metadata: statuses, identifiers, reasons and the
 * names of changed fields. Free text (objectives, constraints, task descriptions)
 * is never copied into events.
 */
export interface SessionEventMetadata {
  from?: AtlasSessionStatus;
  to?: AtlasSessionStatus;
  taskId?: string;
  /** Names of the fields that changed. */
  fields?: string[];
  reason?: 'engine-restart' | 'engine-shutdown' | 'project-removed';
  /** Number of tasks affected by a session-level change. */
  taskCount?: number;
  approvalId?: string;
}

export interface SessionEvent {
  /** Monotonic sequence number. */
  id: number;
  sessionId: string;
  type: SessionEventType;
  occurredAt: string;
  metadata: SessionEventMetadata;
}

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * A request for the user to authorize a sensitive operation. Prepared for future
 * execution adapters; nothing creates approval requests before SDD-004.
 */
export interface ApprovalRequest {
  id: string;
  sessionId: string;
  taskId: string | null;
  /** Short, user-safe description of what would happen. */
  summary: string;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt: string | null;
}

/** Where a session would run. Associating a directory is not a sandbox. */
export type SessionWorkspace =
  | { kind: 'none' }
  | { kind: 'project'; projectId: string; projectName: string; path: string; available: boolean }
  | { kind: 'directory'; path: string; available: boolean };

export interface AtlasSessionListItem {
  session: AtlasSession;
  projectName: string | null;
  taskCounts: { total: number; completed: number };
}

export interface AtlasSessionDetails {
  session: AtlasSession;
  workspace: SessionWorkspace;
  tasks: SessionTask[];
  pendingApprovals: ApprovalRequest[];
  /** Lifecycle actions valid in the current status. */
  availableActions: SessionAction[];
  /** Whether task edits are accepted in the current status. */
  tasksEditable: boolean;
  /** False until execution adapters exist (SDD-004). */
  executorAvailable: boolean;
  /** True only while an executor is working on the session. */
  executing: boolean;
}

export const SESSION_MAX_PARALLEL_TASKS_MIN = 1;
export const SESSION_MAX_PARALLEL_TASKS_MAX = 8;
export const SESSION_MAX_CONCURRENT_MIN = 1;
export const SESSION_MAX_CONCURRENT_MAX = 16;

export interface ExecutionProfileDefinition {
  id: ExecutionProfile;
  label: string;
  description: string;
  defaultMaxParallelTasks: number;
}

/**
 * Planning metadata only: profiles never change security policies, and their limits
 * are applied once a scheduler exists.
 */
export const EXECUTION_PROFILE_DEFINITIONS: readonly ExecutionProfileDefinition[] = [
  {
    id: 'ECONOMY',
    label: 'Economy',
    description: 'Lower planned resource usage, conservative concurrency, efficient executors.',
    defaultMaxParallelTasks: 1,
  },
  {
    id: 'BALANCED',
    label: 'Balanced',
    description: 'Standard execution strategy with balanced resource allocation.',
    defaultMaxParallelTasks: 2,
  },
  {
    id: 'MAXIMUM',
    label: 'Maximum',
    description: 'Higher configurable resource allowance and greater potential parallelism.',
    defaultMaxParallelTasks: 4,
  },
];

const ParallelTasksSchema = z
  .number()
  .int()
  .min(SESSION_MAX_PARALLEL_TASKS_MIN)
  .max(SESSION_MAX_PARALLEL_TASKS_MAX);
const ConcurrentSessionsSchema = z
  .number()
  .int()
  .min(SESSION_MAX_CONCURRENT_MIN)
  .max(SESSION_MAX_CONCURRENT_MAX);

const profileDefault = (id: ExecutionProfile) =>
  EXECUTION_PROFILE_DEFINITIONS.find((profile) => profile.id === id)!.defaultMaxParallelTasks;

const ProfileLimitsSchema = z
  .strictObject({
    ECONOMY: z.strictObject({ maxParallelTasks: ParallelTasksSchema }),
    BALANCED: z.strictObject({ maxParallelTasks: ParallelTasksSchema }),
    MAXIMUM: z.strictObject({ maxParallelTasks: ParallelTasksSchema }),
  })
  .refine(
    (limits) =>
      limits.ECONOMY.maxParallelTasks <= limits.BALANCED.maxParallelTasks &&
      limits.BALANCED.maxParallelTasks <= limits.MAXIMUM.maxParallelTasks,
    { message: 'Economy must not exceed Balanced, and Balanced must not exceed Maximum.' },
  );

export const SessionSettingsSchema = z.strictObject({
  /** Planned limit of sessions executing at the same time. */
  maxConcurrentSessions: ConcurrentSessionsSchema.default(3),
  profiles: ProfileLimitsSchema.default({
    ECONOMY: { maxParallelTasks: profileDefault('ECONOMY') },
    BALANCED: { maxParallelTasks: profileDefault('BALANCED') },
    MAXIMUM: { maxParallelTasks: profileDefault('MAXIMUM') },
  }),
});

export type SessionSettings = z.output<typeof SessionSettingsSchema>;

export const UpdateSessionSettingsSchema = z
  .strictObject({
    maxConcurrentSessions: ConcurrentSessionsSchema.optional(),
    profiles: ProfileLimitsSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'At least one setting must be provided.',
  });

export type UpdateSessionSettingsInput = z.input<typeof UpdateSessionSettingsSchema>;

/** Pushed to clients whenever a session, its tasks or its history changed. */
export interface SessionChangedEvent {
  type: 'session-changed';
  sessionId: string;
}
