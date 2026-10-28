import { z } from 'zod';
import {
  AI_PROVIDERS,
  ContextTargetSchema,
  type AgentRole,
  type AiProvider,
  type LlmWrapperStatus,
  type TaskExecutionStatus,
  type TaskProfileOption,
} from './context.js';

// ---------------------------------------------------------------------------
// Execute with ATLAS (SDD-026 Task 02)
// ---------------------------------------------------------------------------

/**
 * Roles a stage of an ATLAS team can have. Coordination and product decisions stay with
 * ATLAS and the user: no stage plays them.
 */
export const TEAM_ROLES = [
  'architect',
  'backend',
  'frontend',
  'executor',
  'security',
  'qa',
  'docs',
] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  architect: 'Architect / Staff Engineer',
  backend: 'Backend Engineer',
  frontend: 'Frontend Engineer',
  executor: 'Engineer',
  security: 'Security Reviewer',
  qa: 'QA / Test Engineer',
  docs: 'Documentation Specialist',
};

/** The context bundle role each team role receives (SDD-006). */
export const TEAM_ROLE_CONTEXT: Record<TeamRole, AgentRole> = {
  architect: 'architect',
  backend: 'developer',
  frontend: 'developer',
  executor: 'developer',
  security: 'security',
  qa: 'qa',
  docs: 'generic',
};

/** Stages run in this order when a plan has them. */
export const TEAM_ROLE_ORDER: readonly TeamRole[] = TEAM_ROLES;

export const TEAM_STAGES_MAX = 6;

export const TASK_DISCIPLINES = [
  'architecture',
  'backend',
  'frontend',
  'security',
  'testing',
  'documentation',
] as const;
export type TaskDiscipline = (typeof TASK_DISCIPLINES)[number];

export const TASK_COMPLEXITIES = ['simple', 'moderate', 'complex'] as const;
export type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];

/** What ATLAS concluded from the task, without calling a provider (PLAN-055 Q3). */
export interface TaskAssessment {
  complexity: TaskComplexity;
  /** The points behind the complexity, in plain sentences. */
  reasons: string[];
  /** Disciplines found, each with the evidence that suggested it. */
  disciplines: { discipline: TaskDiscipline; evidence: string }[];
  /** Repository-relative files named by the task or its context. */
  files: string[];
  /** Lines of the objective that read as acceptance criteria. */
  acceptanceCriteria: string[];
  /** Active decisions of the project or task the team must respect. */
  decisions: { id: string; question: string; decision: string }[];
}

export interface TeamStageProposal {
  role: TeamRole;
  /** Why the role is in the team. */
  reason: string;
  responsibility: string;
  deliverables: string[];
  provider: AiProvider | null;
  profileId: string | null;
  /**
   * Set when ATLAS proposes a provider other than the preferred one (e.g. it is not
   * installed); the user approves the change with the plan.
   */
  substitution: string | null;
}

export interface TeamProviderOption {
  provider: AiProvider;
  availability: LlmWrapperStatus;
}

/** A profile of a provider and its latest reported subscription use (never a cost). */
export interface TeamProfileOption extends TaskProfileOption {
  /** Highest current limit window use, 0–100; null when unknown. */
  usedPercent: number | null;
  limited: boolean;
}

export interface TeamPreflightCheck {
  checkId: string;
  name: string;
  digest: string;
  /** Null when already authorized for this definition. */
  authorization: string | null;
  warnings: string[];
}

export interface TeamPreflightOption {
  workspaceId: string;
  profiles: { id: string; name: string; checks: TeamPreflightCheck[] }[];
}

/** What "Execute with ATLAS" offers for a task, before anything runs. */
export interface TeamProposal {
  taskId: string;
  assessment: TaskAssessment;
  stages: TeamStageProposal[];
  risks: string[];
  providers: TeamProviderOption[];
  profiles: TeamProfileOption[];
  /** Null when the project has no Preflight profile (or no project). */
  preflight: TeamPreflightOption | null;
  /** Cost cannot be estimated reliably before running: never shown. */
  estimate: null;
}

export const TEAM_ADVANCE_MODES = ['automatic', 'manual'] as const;
export type TeamAdvanceMode = (typeof TEAM_ADVANCE_MODES)[number];

const Id = z.uuid();

export const TeamStagePlanSchema = z.strictObject({
  role: z.enum(TEAM_ROLES),
  provider: z.enum(AI_PROVIDERS),
  profileId: Id.optional(),
});

/** The user's approval of a plan, as reviewed in the preview (FR-005, FR-006). */
export const ApproveTeamPlanSchema = z.strictObject({
  /** One id per confirmation: a repeated approval returns the same execution. */
  requestId: Id,
  target: ContextTargetSchema,
  taskId: Id,
  stages: z
    .array(TeamStagePlanSchema)
    .min(1, 'Keep at least one team member.')
    .max(TEAM_STAGES_MAX, `Use at most ${TEAM_STAGES_MAX} team members.`)
    .refine(
      (stages) => new Set(stages.map((stage) => stage.role)).size === stages.length,
      'Each role can appear once.',
    ),
  advance: z.enum(TEAM_ADVANCE_MODES).default('automatic'),
  /** Preflight at the end, with the checks the user authorized in the preview. */
  preflight: z
    .strictObject({
      workspaceId: z.string().min(1).max(100),
      profileId: z.string().min(1).max(100),
      authorizations: z
        .array(
          z.strictObject({
            checkId: z.string().min(1).max(100),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        )
        .max(50),
    })
    .nullable()
    .default(null),
});
export type ApproveTeamPlanInput = z.input<typeof ApproveTeamPlanSchema>;
export type ParsedApproveTeamPlan = z.output<typeof ApproveTeamPlanSchema>;

/** What the user decides when a team execution is paused (FR-011, FR-013). */
export const TEAM_CONTINUE_ACTIONS = ['next', 'retry', 'skip'] as const;
export type TeamContinueAction = (typeof TEAM_CONTINUE_ACTIONS)[number];
export const TeamContinueActionSchema = z.enum(TEAM_CONTINUE_ACTIONS);

export const TEAM_STAGE_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'UNTRACKED',
  'INTERRUPTED',
  'CANCELLED',
  'SKIPPED',
] as const;
export type TeamStageStatus = (typeof TEAM_STAGE_STATUSES)[number];

/**
 * `RUNNING`: a stage runs. `PAUSED`: ATLAS waits for the user (`pause` says why).
 * `CHECKING`: Preflight runs. `REVIEW_REQUIRED`: every stage ended; the result awaits the
 * user's review. `CANCELLED`: stopped by the user. A team never completes its task.
 */
export const TEAM_EXECUTION_STATUSES = [
  'RUNNING',
  'PAUSED',
  'CHECKING',
  'REVIEW_REQUIRED',
  'CANCELLED',
] as const;
export type TeamExecutionStatus = (typeof TEAM_EXECUTION_STATUSES)[number];
export const ACTIVE_TEAM_EXECUTION_STATUSES: readonly TeamExecutionStatus[] = [
  'RUNNING',
  'PAUSED',
  'CHECKING',
];

export const TEAM_PAUSE_REASONS = [
  'manual-advance',
  'stage-failed',
  'stage-untracked',
  'stage-interrupted',
  'launch-failed',
  'engine-restart',
] as const;
export type TeamPauseReason = (typeof TEAM_PAUSE_REASONS)[number];

export interface TeamStage {
  role: TeamRole;
  provider: AiProvider;
  profileId: string | null;
  profileName: string | null;
  status: TeamStageStatus;
  /** Every run of this stage (retries add one), oldest first. */
  executionIds: string[];
  /** The managed AI session of each run, in the same order (null when none). */
  sessionIds: (string | null)[];
  terminalId: string | null;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  /** What Git shows the stage changed, recorded when it ended. */
  changedFiles: string[];
  commits: { hash: string; subject: string }[];
}

export type TeamPreflightResult =
  'not-requested' | 'running' | 'passed' | 'failed' | 'needs-authorization' | 'not-run';

/** Subscription use of an account the team used: a percentage, never money (FR-014). */
export interface TeamUsageNote {
  profileId: string;
  profileName: string;
  provider: AiProvider;
  /** Highest current window use when the team ended; null when unknown. */
  usedPercent: number | null;
}

export interface TeamExecution {
  id: string;
  requestId: string;
  taskId: string;
  projectId: string | null;
  workspacePath: string | null;
  status: TeamExecutionStatus;
  pause: TeamPauseReason | null;
  /** Safe to show, e.g. why a member could not start. */
  pauseDetail: string | null;
  advance: TeamAdvanceMode;
  /** The terminal group the members open in; null when none could be created. */
  terminalGroupId: string | null;
  stages: TeamStage[];
  /** Index of the stage running or waiting; null when none. */
  currentStage: number | null;
  /** The assessment shown when the plan was approved. */
  complexity: TaskComplexity;
  preflight: {
    workspaceId: string;
    profileId: string;
    authorizations: { checkId: string; digest: string }[];
    jobId: string | null;
    result: TeamPreflightResult;
  } | null;
  /** All files and commits Git shows since the first stage started. */
  summary: {
    changedFiles: string[];
    commits: { hash: string; subject: string }[];
    usage: TeamUsageNote[];
  } | null;
  approvedAt: string;
  finishedAt: string | null;
  reviewedAt: string | null;
}

/** Shown in the summary when a stage list is long. */
export const TEAM_SUMMARY_FILES_MAX = 200;

/** Stage statuses that the task execution behind it maps to. */
export const STAGE_STATUS_OF_EXECUTION: Partial<Record<TaskExecutionStatus, TeamStageStatus>> = {
  REVIEW_REQUIRED: 'SUCCEEDED',
  FAILED: 'FAILED',
  UNTRACKED: 'UNTRACKED',
  INTERRUPTED: 'INTERRUPTED',
  CANCELLED: 'CANCELLED',
};
