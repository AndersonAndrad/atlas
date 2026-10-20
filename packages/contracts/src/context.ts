import { z } from 'zod';
import { ProjectIdSchema } from './project.js';

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
}

/** Compact, provider-formatted context for an AI session (FR-505). */
export interface ContextBundle {
  markdown: string;
  provider: AiProvider | 'generic';
  budgetTokens: number;
  /** Rough estimate (characters / 4). */
  tokenEstimate: number;
  /** Lower-priority records left out to respect the budget. */
  omitted: number;
  freshness: ContextFreshness;
  generatedAt: string;
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
  /** Repository files the entry is about; their current content is fingerprinted. */
  files: z.array(PathText).max(50).optional(),
});
export type CreateContextEntryInput = z.infer<typeof CreateContextEntrySchema>;

export const UpdateContextEntrySchema = z.strictObject({
  title: Text(200).optional(),
  body: z.string().max(20_000).optional(),
  category: z.enum(CONTEXT_CATEGORIES).optional(),
  status: z.enum(['active', 'obsolete']).optional(),
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

export const ContextBundleRequestSchema = z.strictObject({
  target: ContextTargetSchema,
  taskId: Id.optional(),
  provider: z.enum(['claude', 'codex', 'generic']).default('generic'),
  budgetTokens: z.number().int().min(500).max(32_000).default(6000),
});
export type ContextBundleRequest = z.input<typeof ContextBundleRequestSchema>;

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
  budgetTokens: z.number().int().min(500).max(32_000).default(6000),
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
