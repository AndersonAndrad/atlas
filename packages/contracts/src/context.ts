import { z } from 'zod';
import { ProjectIdSchema } from './project.js';
import { EXECUTION_PROFILES, type ExecutionProfile } from './session.js';

// ---------------------------------------------------------------------------
// Shared Context (SDD-005 Milestone A)
// ---------------------------------------------------------------------------

export const CONTEXT_SCOPES = [
  'global',
  'project',
  'workspace',
  'task',
  'session',
  'agent',
] as const;
/**
 * `global`: conventions explicitly shared across projects. `project` / `workspace`:
 * knowledge of a registered project or of a repository without one. `task`,
 * `session` and `agent` narrow it to an objective, an AI session or an agent.
 */
export type ContextScope = (typeof CONTEXT_SCOPES)[number];

export const CONTEXT_CATEGORIES = [
  'overview',
  'architecture',
  'convention',
  /** A rule the receiving agent must respect, e.g. "never edit generated files". */
  'constraint',
  'command',
  'objective',
  'progress',
  'files-changed',
  'commit',
  'test-result',
  'known-failure',
  'blocker',
  'pending-decision',
  'next-action',
  'provider-reference',
  'summary',
  /** Work in progress written by an LLM while it works (PLAN-021); unverified. */
  'checkpoint',
  'note',
] as const;
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

/**
 * How much an entry can be trusted: `verified` comes from repository or execution
 * evidence collected by ATLAS; `user` was written or approved by the user;
 * `observed` was reported by an AI agent and is not verified.
 */
export const CONTEXT_VERIFICATIONS = ['verified', 'user', 'observed'] as const;
export type ContextVerification = (typeof CONTEXT_VERIFICATIONS)[number];

export const CONTEXT_SOURCE_KINDS = [
  'user',
  'git',
  'ai-session',
  'agent',
  'system',
  'import',
] as const;
export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

/** Where an entry came from and who recorded it. */
export interface ContextSource {
  kind: ContextSourceKind;
  /** Commit hash, AI session id, handoff id… depending on the kind. */
  ref: string | null;
  /** Client that recorded it: `desktop`, `cli` or an AI session id. */
  recordedBy: string;
}

/** Repository evidence an entry refers to, used to detect stale context. */
export interface ContextReferences {
  files: { path: string; hash: string | null }[];
  commit: string | null;
  /** Branch checked out when the entry was recorded (absent in entries before v0.10.0). */
  branch?: string | null;
}

/** The project or repository a context record belongs to; both null for global records. */
export interface ContextOwner {
  projectId: string | null;
  workspacePath: string | null;
}

export interface ContextEntry extends ContextOwner {
  id: string;
  scope: ContextScope;
  taskId: string | null;
  sessionId: string | null;
  category: ContextCategory;
  title: string;
  body: string;
  status: 'active' | 'obsolete';
  verification: ContextVerification;
  source: ContextSource;
  refs: ContextReferences;
  /** Always part of a bundle: never left out for the budget nor excluded in a preview. */
  required: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContextRevision {
  entryId: string;
  revision: number;
  title: string;
  body: string;
  category: ContextCategory;
  verification: ContextVerification;
  status: 'active' | 'obsolete';
  changedAt: string;
  changedBy: string;
  reason: string | null;
}

export const CONTEXT_TASK_STATUSES = ['open', 'done', 'abandoned'] as const;
export type ContextTaskStatus = (typeof CONTEXT_TASK_STATUSES)[number];

/** A development objective whose knowledge outlives the sessions working on it. */
export interface ContextTask extends ContextOwner {
  id: string;
  title: string;
  objective: string;
  status: ContextTaskStatus;
  /** HEAD when the task was created; commits after it belong to the task's history. */
  baseCommit: string | null;
  /** Branch checked out when the task was created. */
  baseBranch: string | null;
  /** Context budget for this task's bundles, overriding role, provider and global budgets. */
  budgetTokens: number | null;
  createdAt: string;
  updatedAt: string;
}

export const DECISION_STATUSES = ['ACTIVE', 'SUPERSEDED', 'REJECTED'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface DecisionRecord extends ContextOwner {
  id: string;
  taskId: string | null;
  question: string;
  decision: string;
  alternatives: string[];
  reasoning: string;
  evidence: string[];
  affected: string[];
  status: DecisionStatus;
  supersededBy: string | null;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export const AI_PROVIDERS = ['claude', 'codex'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * An individual AI CLI session tracked by ATLAS. `managed` sessions were started by
 * ATLAS in a terminal with optional context; `attached` sessions are terminals the
 * user asked ATLAS to track. ATLAS never reads a provider's internal conversation.
 */
export interface AiSession extends ContextOwner {
  id: string;
  provider: AiProvider | 'external';
  captureMode: 'managed' | 'attached';
  taskId: string | null;
  terminalId: string | null;
  handoffId: string | null;
  /** HEAD when the session started; its commits and changes are measured from it. */
  startCommit: string | null;
  status: 'active' | 'ended';
  startedAt: string;
  endedAt: string | null;
}

export const VALIDATION_STATUSES = ['PASSED', 'FAILED', 'NOT_RUN'] as const;

/** Structured continuation packet (SDD-005 FR-512); never a copied conversation. */
export interface ContextHandoff extends ContextOwner {
  id: string;
  sourceSessionId: string | null;
  targetProvider: AiProvider | null;
  taskId: string | null;
  objective: string;
  completedWork: string[];
  pendingWork: string[];
  decisions: string[];
  blockers: string[];
  /** From Git since the task or session base: verified evidence. */
  changedFiles: string[];
  commits: string[];
  validations: {
    command: string;
    status: (typeof VALIDATION_STATUSES)[number];
    evidence?: string;
  }[];
  nextActions: string[];
  /** HEAD when the handoff was created. */
  sourceRevision: string | null;
  /** Context entries and decisions the packet was built from. */
  evidence: { entryIds: string[]; decisionIds: string[] };
  createdAt: string;
}

/** Repository state compared with stored references when building a bundle. */
export interface ContextFreshness {
  repositoryRoot: string | null;
  branch: string | null;
  head: string | null;
  uncommittedFiles: number;
  stale: { id: string; reason: string }[];
  /** The bounded number of Git checks was reached; later references were not checked. */
  checksTruncated?: boolean;
}

// ---------------------------------------------------------------------------
// Context retrieval (SDD-006 Milestone A)
// ---------------------------------------------------------------------------

/** Roles that receive different context; `generic` is an ordinary AI session. */
export const AGENT_ROLES = [
  'generic',
  'architect',
  'developer',
  'qa',
  'security',
  'reviewer',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const CONTEXT_BUDGET_MIN = 500;
export const CONTEXT_BUDGET_MAX = 32_000;
export const CONTEXT_BUDGET_DEFAULT = 6000;

/**
 * Token counts are never measured by ATLAS: it holds no provider credentials. Every
 * count is this approximation and must be presented as an estimate.
 */
export const TOKEN_ESTIMATE_METHOD = 'approximation: characters / 4';

/** Bundle sections in priority order (FR-604): earlier sections are kept first. */
export const BUNDLE_SECTIONS = [
  'constraints',
  'decisions',
  'relevant-files',
  'task-state',
  'validations',
  'blockers',
  'knowledge',
  'history',
  'global',
] as const;
export type BundleSection = (typeof BUNDLE_SECTIONS)[number];

/** One explainable part of a relevance score. */
export interface ScoreFactor {
  name:
    | 'text'
    | 'search-rank'
    | 'scope'
    | 'files'
    | 'category'
    | 'decision'
    | 'verification'
    | 'recency'
    | 'stale'
    | 'branch';
  points: number;
  detail: string;
}

/** A record considered for a bundle, with its provenance and relevance (FR-602, FR-605). */
export interface ContextReference {
  id: string;
  kind: 'entry' | 'decision';
  section: BundleSection;
  title: string;
  /** Line written to the bundle. */
  text: string;
  category: ContextCategory | null;
  verification: ContextVerification;
  required: boolean;
  stale: boolean;
  score: number;
  factors: ScoreFactor[];
  source: ContextSource;
  files: string[];
  commit: string | null;
  /** Equivalent records collapsed into this one; they stay stored (FR-607). */
  duplicates: string[];
  estimatedTokens: number;
}

export type ExclusionReason =
  /** Did not fit the token budget. */
  | 'budget'
  /** Excluded by the user in the preview. */
  | 'user'
  /** Equivalent to an included record. */
  | 'duplicate'
  /** Older session summaries; the latest ones are kept (structured compaction). */
  | 'compacted'
  /** No match with the objective, keywords or files, in a section that needs one. */
  | 'not-relevant'
  /** Left for on-demand retrieval by an essential bundle (FR-611). */
  | 'progressive';

export interface ExcludedReference {
  reference: ContextReference;
  reason: ExclusionReason;
}

export type ContextWarningKind =
  | 'stale'
  | 'branch-changed'
  | 'conflict'
  | 'pending-of-closed-task'
  | 'over-budget'
  | 'required-not-excludable';

export interface ContextWarning {
  kind: ContextWarningKind;
  message: string;
  /** Records the warning is about. */
  ids: string[];
}

export type BudgetSource = 'request' | 'task' | 'profile' | 'role' | 'provider' | 'default';

/** A skill active for the bundle's project, role and provider (SDD-006 Milestone B). */
export interface BundleSkill {
  skillId: string;
  name: string;
  description: string;
  version: string;
  /** SKILL.md of the ATLAS-managed copy; the provider reads it when relevant. */
  skillFile: string;
  /** Why it is active (e.g. "Enabled for this project."). */
  reason: string;
}

/** Compact, provider-formatted context for an AI session (SDD-005 FR-505, SDD-006 FR-605). */
export interface ContextBundle {
  markdown: string;
  provider: AiProvider | 'generic';
  /** Objective the context was selected for: the request's, else the task's. */
  objective: string | null;
  role: AgentRole;
  budgetTokens: number;
  budgetSource: BudgetSource;
  /** Estimate of the markdown size (see TOKEN_ESTIMATE_METHOD); never a measured count. */
  tokenEstimate: number;
  estimatedTokens: number;
  tokenEstimateMethod: typeof TOKEN_ESTIMATE_METHOD;
  /** Required content alone exceeds the budget; it was kept and reported. */
  overBudget: boolean;
  /** Records left out to respect the budget. */
  omitted: number;
  /** Mandatory ATLAS policies sent with every bundle; they cannot be removed. */
  instructions: string[];
  /** Included records in bundle order. */
  included: ContextReference[];
  excluded: ExcludedReference[];
  decisions: ContextReference[];
  relevantFiles: ContextReference[];
  completedWork: ContextReference[];
  pendingWork: ContextReference[];
  validations: ContextReference[];
  blockers: ContextReference[];
  warnings: ContextWarning[];
  /** Skills the user enabled for this context; listed, never inlined. */
  skills: BundleSkill[];
  /** Whether the stored records came from the bundle cache (freshness is always checked now). */
  cache: 'hit' | 'miss';
  freshness: ContextFreshness;
  generatedAt: string;
}

/** Per-scope context budgets in estimated tokens (FR-603). */
export interface ContextBudgetSettings {
  defaultTokens: number;
  providers: Partial<Record<AiProvider | 'generic', number>>;
  roles: Partial<Record<AgentRole, number>>;
  profiles: Partial<Record<ExecutionProfile, number>>;
}

/** Heuristic signals about stored context (FR-608); not a measure of correctness. */
export interface ContextHealthReport {
  generatedAt: string;
  tokenEstimateMethod: typeof TOKEN_ESTIMATE_METHOD;
  repository: { branch: string | null; head: string | null };
  totals: {
    entries: number;
    activeEntries: number;
    obsoleteEntries: number;
    requiredEntries: number;
    decisions: number;
    activeDecisions: number;
    supersededDecisions: number;
    tasks: number;
    openTasks: number;
  };
  /** Estimated size of every record a generic bundle could include, without a budget. */
  estimatedRelevantTokens: number;
  stale: { id: string; reason: string }[];
  conflicts: { ids: string[]; reason: string }[];
  missingSources: { id: string; title: string }[];
  duplicates: { keptId: string; duplicateIds: string[] }[];
  pendingOfClosedTasks: { id: string; title: string; taskId: string }[];
  /** Freshness checks stopped at their bound; some references were not checked. */
  checksTruncated: boolean;
  lastReconciliation: ContextReconciliation | null;
}

/** A recorded run of the freshness and consistency checks. */
export interface ContextReconciliation {
  id: string;
  at: string;
  head: string | null;
  branch: string | null;
  stale: number;
  conflicts: number;
  duplicates: number;
}

export interface ContextSnapshot extends ContextOwner {
  id: string;
  taskId: string | null;
  markdown: string;
  head: string | null;
  createdAt: string;
}

/** Counts per area for the overview. */
export interface ContextOverview {
  entries: number;
  tasks: number;
  openTasks: number;
  decisions: number;
  sessions: number;
  activeSessions: number;
  handoffs: number;
  pending: number;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const Id = z.uuid();
const BudgetTokens = z.number().int().min(CONTEXT_BUDGET_MIN).max(CONTEXT_BUDGET_MAX);
const Text = (max: number) => z.string().trim().min(1).max(max);
const List = (max: number) => z.array(z.string().trim().min(1).max(2000)).max(max);
const PathText = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'Invalid path.');

/** A project, or a repository root the Engine resolved itself (see ADR-031). */
export const ContextTargetSchema = z.union([
  z.strictObject({ projectId: ProjectIdSchema }),
  z.strictObject({ workspacePath: PathText }),
]);
export type ContextTarget = z.infer<typeof ContextTargetSchema>;

export const CreateContextEntrySchema = z.strictObject({
  target: ContextTargetSchema.nullable(),
  scope: z.enum(['global', 'project', 'workspace', 'task']),
  taskId: Id.optional(),
  category: z.enum(CONTEXT_CATEGORIES),
  title: Text(200),
  body: z.string().max(20_000),
  /** Always sent in bundles; reserve it for constraints that must not be dropped. */
  required: z.boolean().optional(),
  /** Repository files the entry is about; their current content is fingerprinted. */
  files: z.array(PathText).max(50).optional(),
});
export type CreateContextEntryInput = z.infer<typeof CreateContextEntrySchema>;

export const UpdateContextEntrySchema = z.strictObject({
  title: Text(200).optional(),
  body: z.string().max(20_000).optional(),
  category: z.enum(CONTEXT_CATEGORIES).optional(),
  status: z.enum(['active', 'obsolete']).optional(),
  required: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});
export type UpdateContextEntryInput = z.infer<typeof UpdateContextEntrySchema>;

export const ContextQuerySchema = z.strictObject({
  target: ContextTargetSchema,
  taskId: Id.optional(),
  sessionId: Id.optional(),
  category: z.enum(CONTEXT_CATEGORIES).optional(),
  search: z.string().trim().max(200).optional(),
  includeObsolete: z.boolean().optional(),
  includeGlobal: z.boolean().optional(),
});
export type ContextQuery = z.infer<typeof ContextQuerySchema>;

export const CreateContextTaskSchema = z.strictObject({
  target: ContextTargetSchema,
  title: Text(200),
  objective: z.string().trim().min(1).max(4000),
});
export type CreateContextTaskInput = z.infer<typeof CreateContextTaskSchema>;

export const UpdateContextTaskSchema = z.strictObject({
  title: Text(200).optional(),
  objective: z.string().trim().min(1).max(4000).optional(),
  status: z.enum(CONTEXT_TASK_STATUSES).optional(),
  /** Null removes the task's override. */
  budgetTokens: BudgetTokens.nullable().optional(),
});
export type UpdateContextTaskInput = z.infer<typeof UpdateContextTaskSchema>;

export const CreateDecisionSchema = z.strictObject({
  target: ContextTargetSchema,
  taskId: Id.optional(),
  question: Text(500),
  decision: Text(2000),
  alternatives: List(20).default([]),
  reasoning: z.string().trim().max(4000).default(''),
  evidence: List(20).default([]),
  affected: List(50).default([]),
  /** Decision this one replaces; it becomes SUPERSEDED, never deleted. */
  supersedes: Id.optional(),
});
export type CreateDecisionInput = z.input<typeof CreateDecisionSchema>;

/** What to select context for (FR-601); everything is optional. */
const RetrievalFields = {
  /** Current objective; defaults to the task's. */
  objective: z.string().trim().max(4000).optional(),
  agentRole: z.enum(AGENT_ROLES).optional(),
  executionProfile: z.enum(EXECUTION_PROFILES).optional(),
  /** Repository-relative files the work is about. */
  files: z.array(PathText).max(50).optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  /** Optional records the user excluded in the preview; required ones stay. */
  excludeIds: z.array(Id).max(500).optional(),
  /** `essential` leaves project knowledge and history for on-demand retrieval (FR-611). */
  detail: z.enum(['essential', 'full']).optional(),
  /** Skills chosen for this session in addition to the enabled ones. */
  skillIds: z.array(Id).max(100).optional(),
};

export const ContextBundleRequestSchema = z.strictObject({
  target: ContextTargetSchema,
  taskId: Id.optional(),
  provider: z.enum(['claude', 'codex', 'generic']).default('generic'),
  /** Explicit budget; otherwise task, profile, role, provider and global budgets apply. */
  budgetTokens: BudgetTokens.optional(),
  ...RetrievalFields,
});
export type ContextBundleRequest = z.input<typeof ContextBundleRequestSchema>;
export type ParsedContextBundleRequest = z.infer<typeof ContextBundleRequestSchema>;

export const CreateHandoffSchema = z.strictObject({
  target: ContextTargetSchema,
  taskId: Id.optional(),
  sourceSessionId: Id.optional(),
  targetProvider: z.enum(AI_PROVIDERS).nullable().default(null),
  objective: Text(4000),
  completedWork: List(50).default([]),
  pendingWork: List(50).default([]),
  blockers: List(50).default([]),
  nextActions: List(50).default([]),
});
export type CreateHandoffInput = z.input<typeof CreateHandoffSchema>;

export const StartAiSessionSchema = z.strictObject({
  provider: z.enum(AI_PROVIDERS),
  target: ContextTargetSchema,
  taskId: Id.optional(),
  /** Continue from this handoff; otherwise a context bundle is sent when enabled. */
  handoffId: Id.optional(),
  includeContext: z.boolean(),
  budgetTokens: BudgetTokens.optional(),
  ...RetrievalFields,
});
export type StartAiSessionInput = z.input<typeof StartAiSessionSchema>;

export const AttachTerminalSchema = z.strictObject({
  terminalId: z.uuid(),
  taskId: Id.optional(),
});
export type AttachTerminalInput = z.infer<typeof AttachTerminalSchema>;

export const SessionSummarySchema = z.strictObject({
  summary: z.string().trim().max(8000).default(''),
  completed: List(50).default([]),
  pending: List(50).default([]),
  decisions: List(20).default([]),
  nextActions: List(50).default([]),
});
export type SessionSummaryInput = z.input<typeof SessionSummarySchema>;

/** Evidence ATLAS collected from Git for a session, shown before saving its summary. */
export interface SessionEvidence {
  commits: { hash: string; subject: string }[];
  changedFiles: string[];
  head: string | null;
}

/** Result of starting a managed AI session: the terminal it runs in. */
export interface StartedAiSession {
  session: AiSession;
  terminalId: string;
  /** What was sent to the provider as its first prompt (null without context). */
  prompt: string | null;
}

/** A handoff prefilled from stored context and Git evidence, for the user to review. */
export interface ContextHandoffDraft {
  objective: string;
  completedWork: string[];
  pendingWork: string[];
  blockers: string[];
  nextActions: string[];
  decisions: string[];
  commits: string[];
  changedFiles: string[];
}

// ---------------------------------------------------------------------------
// Project configuration read by LLMs (PLAN-014)
// ---------------------------------------------------------------------------

/** Per-project AI options, stored as JSON in the ATLAS data directory (never in the project). */
export const ProjectAiConfigSchema = z.strictObject({
  /** Keep the project's shared context and offer it to LLMs started in ATLAS terminals. */
  keepContext: z.boolean(),
  /** Allow ATLAS multi-agent features for this project (recorded for future use). */
  atlasEnabled: z.boolean(),
});
export type ProjectAiConfig = z.infer<typeof ProjectAiConfigSchema>;
export const UpdateProjectAiConfigSchema = ProjectAiConfigSchema.partial();
export type UpdateProjectAiConfig = z.infer<typeof UpdateProjectAiConfigSchema>;

/** Both options are off until the user turns them on. */
export const DEFAULT_PROJECT_AI_CONFIG: ProjectAiConfig = {
  keepContext: false,
  atlasEnabled: false,
};

/** The JSON file LLMs read before working (`project-config.json`). */
export interface ProjectConfigFile extends ProjectAiConfig {
  schemaVersion: 1;
  projectId: string;
  projectName: string;
  workspacePath: string;
  context: {
    /** Markdown kept up to date while `keepContext` is true. */
    file: string;
    updatedAt: string | null;
  };
  updatedAt: string;
}

/**
 * How `claude` / `codex` resolve in the project's ATLAS terminals: `wrapped` runs the
 * ATLAS wrapper (the LLM gets the project-config instruction); `shadowed` means the
 * user's shell configuration puts another copy first; `missing` means not installed.
 */
export type LlmWrapperStatus = 'wrapped' | 'shadowed' | 'missing' | 'unknown';

export interface ProjectConfigView {
  config: ProjectConfigFile;
  configPath: string;
  wrappers: { claude: LlmWrapperStatus; codex: LlmWrapperStatus };
}

const BudgetMap = <K extends string>(keys: readonly [K, ...K[]]) =>
  z.partialRecord(z.enum(keys), BudgetTokens);

const BudgetFields = {
  defaultTokens: BudgetTokens,
  providers: BudgetMap(['claude', 'codex', 'generic']),
  roles: BudgetMap(AGENT_ROLES),
  profiles: BudgetMap(EXECUTION_PROFILES),
};

export const ContextBudgetSettingsSchema = z.strictObject({
  defaultTokens: BudgetFields.defaultTokens.default(CONTEXT_BUDGET_DEFAULT),
  providers: BudgetFields.providers.default({}),
  roles: BudgetFields.roles.default({}),
  profiles: BudgetFields.profiles.default({}),
});
/** Without defaults: a field left out keeps its stored value. */
export const UpdateContextBudgetSettingsSchema = z.strictObject(BudgetFields).partial();
export type UpdateContextBudgetSettings = z.input<typeof UpdateContextBudgetSettingsSchema>;
