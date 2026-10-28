import { z } from 'zod';
import { AI_PROVIDERS, type AiProvider, type TaskProfileOption } from './context.js';
import { ProjectIdSchema } from './project.js';

// ---------------------------------------------------------------------------
// AI project audit (SDD-026 Task 01)
// ---------------------------------------------------------------------------

export const AUDIT_CATEGORIES = [
  'architecture',
  'security',
  'design-patterns',
  'code-quality',
  'reliability',
  'testing',
  'performance',
  'developer-experience',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  architecture: 'Architecture and modularity',
  security: 'Security and potential vulnerabilities',
  'design-patterns': 'Design patterns and maintainability',
  'code-quality': 'Code quality and technical debt',
  reliability: 'Reliability and error handling',
  testing: 'Testing and coverage gaps',
  performance: 'Performance and resource usage',
  'developer-experience': 'Developer experience and tooling',
};

/** The default profile of the Analyze Project dialog. */
export const DEFAULT_AUDIT_CATEGORIES: readonly AuditCategory[] = [
  'architecture',
  'security',
  'code-quality',
  'reliability',
];

export const AUDIT_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

export const AUDIT_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type AuditConfidence = (typeof AUDIT_CONFIDENCES)[number];

/**
 * What the provider claims: something it saw in the code, or a suspicion it could not
 * confirm. ATLAS never labels a finding as a confirmed vulnerability.
 */
export const AUDIT_FINDING_KINDS = ['observation', 'hypothesis'] as const;
export type AuditFindingKind = (typeof AUDIT_FINDING_KINDS)[number];

export const AUDIT_EFFORTS = ['small', 'medium', 'large'] as const;
export type AuditEffort = (typeof AUDIT_EFFORTS)[number];

export const AUDIT_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];
export const ACTIVE_AUDIT_STATUSES: readonly AuditStatus[] = ['QUEUED', 'RUNNING'];

export const AUDIT_SCOPE_PATHS_MAX = 50;
export const AUDIT_PATH_MAX = 500;
export const AUDIT_TIMEOUT_MINUTES_DEFAULT = 30;
export const AUDIT_TIMEOUT_MINUTES_MAX = 120;

/**
 * A path relative to the project folder, with `/` separators. Absolute paths and `..`
 * segments are refused here; the Engine checks again after resolving symbolic links.
 */
export const AuditPathSchema = z
  .string()
  .trim()
  .min(1, 'Enter a path.')
  .max(AUDIT_PATH_MAX, `Use at most ${AUDIT_PATH_MAX} characters.`)
  .transform((value) => value.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, ''))
  .refine((value) => value !== '' && value !== '.', 'Choose a path inside the project.')
  // eslint-disable-next-line no-control-regex -- control characters are refused on purpose.
  .refine((value) => !/[\u0000-\u001f]/.test(value), 'The path contains control characters.')
  .refine(
    (value) => !value.startsWith('/') && !/^[A-Za-z]:/.test(value),
    'Use a path relative to the project folder.',
  )
  .refine(
    (value) => !value.split('/').some((segment) => segment === '..'),
    'The path cannot leave the project folder.',
  );

const AuditPathListSchema = z
  .array(AuditPathSchema)
  .min(1, 'Choose at least one path.')
  .max(AUDIT_SCOPE_PATHS_MAX, `Choose at most ${AUDIT_SCOPE_PATHS_MAX} paths.`)
  .transform((paths) => [...new Set(paths)]);

export const AuditScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project') }),
  z.strictObject({ kind: z.literal('directories'), paths: AuditPathListSchema }),
  z.strictObject({ kind: z.literal('files'), paths: AuditPathListSchema }),
  /** Files with uncommitted changes (Git repositories only). */
  z.strictObject({ kind: z.literal('changed') }),
]);
export type AuditScope = z.output<typeof AuditScopeSchema>;
export type AuditScopeKind = AuditScope['kind'];

export const StartAuditSchema = z.strictObject({
  projectId: ProjectIdSchema,
  provider: z.enum(AI_PROVIDERS),
  /** An account profile of the provider; its default configuration when absent. */
  profileId: z.uuid({ message: 'Invalid account profile.' }).optional(),
  categories: z
    .array(z.enum(AUDIT_CATEGORIES))
    .min(1, 'Choose at least one category.')
    .max(AUDIT_CATEGORIES.length)
    .transform((categories) => [...new Set(categories)]),
  scope: AuditScopeSchema,
  /** Required when the provider option lists warnings (AUDIT_CONFIRMATION_REQUIRED). */
  acknowledgeWarnings: z.boolean().default(false),
  timeoutMinutes: z
    .number()
    .int()
    .min(5)
    .max(AUDIT_TIMEOUT_MINUTES_MAX)
    .default(AUDIT_TIMEOUT_MINUTES_DEFAULT),
});
export type StartAuditInput = z.input<typeof StartAuditSchema>;
export type ParsedStartAuditInput = z.output<typeof StartAuditSchema>;

/**
 * How the provider is kept from changing files. `tools-restricted`: the CLI only has
 * file reading and search tools. `sandboxed-commands`: the CLI may run commands, inside
 * an operating system sandbox that blocks writes and network access.
 */
export type AuditReadOnlyMode = 'tools-restricted' | 'sandboxed-commands';

export interface AuditProviderOption {
  provider: AiProvider;
  available: boolean;
  /** Why it cannot be chosen; null when available. */
  reason: string | null;
  readOnlyMode: AuditReadOnlyMode;
  /** Where the files the audit reads are sent; shown, no confirmation needed. */
  dataNotice: string;
  /** Shown in the dialog; starting requires `acknowledgeWarnings` when not empty. */
  warnings: string[];
}

export interface AuditCategoryOption {
  id: AuditCategory;
  label: string;
}

/** What the Analyze Project dialog offers for one project. */
export interface AuditOptions {
  projectId: string;
  projectName: string;
  /** False when the project folder cannot be reached: nothing can be audited. */
  projectAvailable: boolean;
  providers: AuditProviderOption[];
  profiles: TaskProfileOption[];
  categories: AuditCategoryOption[];
  defaultCategories: AuditCategory[];
  /** Whether the "changed files" scope can be used, and how many files it holds now. */
  git: { repository: boolean; changedFiles: number | null };
  /** Cost or effort estimates are not shown: no reliable estimation exists. */
  estimate: null;
}

/** What ATLAS found when it checked one location the provider reported. */
export const AUDIT_LOCATION_STATUSES = [
  'located',
  'line-out-of-range',
  'missing',
  'outside-project',
  'ignored',
  'not-a-file',
] as const;
export type AuditLocationStatus = (typeof AUDIT_LOCATION_STATUSES)[number];

export interface AuditFindingLocation {
  /** Relative to the project folder, `/` separators. */
  path: string;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
  status: AuditLocationStatus;
}

/**
 * ATLAS's check of a finding (FR-008). `evidence-located`: the files exist and the quoted
 * excerpt was found; the issue itself is still the provider's claim. `needs-review`:
 * something could not be checked. `invalid`: nothing the finding points at exists.
 */
export const AUDIT_FINDING_VALIDATIONS = ['evidence-located', 'needs-review', 'invalid'] as const;
export type AuditFindingValidation = (typeof AUDIT_FINDING_VALIDATIONS)[number];

export interface AuditFinding {
  id: string;
  auditId: string;
  projectId: string;
  /** Stable across audits: category, normalized description, location and evidence. */
  fingerprint: string;
  /** Position in the provider's report. */
  ordinal: number;
  title: string;
  category: AuditCategory;
  severity: AuditSeverity;
  confidence: AuditConfidence;
  kind: AuditFindingKind;
  description: string;
  evidence: string;
  /** Code the provider quoted, as plain text. */
  excerpt: string | null;
  locations: AuditFindingLocation[];
  impact: string;
  recommendation: string;
  suggestedTaskTitle: string;
  acceptanceCriteria: string[];
  effort: AuditEffort | null;
  validation: AuditFindingValidation;
  /** Why the finding needs review, in plain sentences. */
  validationNotes: string[];
  /** Text fields hold shell commands: ATLAS shows them as text and never runs them. */
  containsCommands: boolean;
}

/** Whether the project's files changed while the audit ran (Git status before and after). */
export type AuditWorkspaceCheck = 'unchanged' | 'changed' | 'unverifiable';

/** Reported by the provider itself; null values are unavailable, never estimated by ATLAS. */
export interface AuditMetrics {
  inputTokens: number | null;
  outputTokens: number | null;
  /** The provider's own API-price estimate (Claude Code); not a subscription charge. */
  costUsd: number | null;
  durationMs: number | null;
}

export type AuditSeverityCounts = Record<AuditSeverity, number>;

export interface ProjectAudit {
  id: string;
  projectId: string;
  jobId: string | null;
  provider: AiProvider;
  profileId: string | null;
  profileName: string | null;
  categories: AuditCategory[];
  scope: AuditScope;
  /**
   * Files and folders the scope resolved to when the audit was started (empty for the
   * whole project); at most AUDIT_SCOPE_FILES_MAX.
   */
  scopeFiles: string[];
  /** More files matched the scope than `scopeFiles` holds. */
  scopeTruncated: boolean;
  readOnlyMode: AuditReadOnlyMode;
  /** The warnings the user acknowledged when starting it. */
  acknowledgedWarnings: string[];
  timeoutMinutes: number;
  status: AuditStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The provider's overall summary (plain text). */
  summary: string | null;
  /** Short and safe to show; never provider output. */
  errorSummary: string | null;
  workspaceCheck: AuditWorkspaceCheck | null;
  /** Up to AUDIT_CHANGED_PATHS_MAX files that changed while the audit ran. */
  changedPaths: string[];
  metrics: AuditMetrics | null;
  findingCount: number;
  severityCounts: AuditSeverityCounts;
  needsReviewCount: number;
  invalidCount: number;
  /** Report entries without the required fields; counted, not shown as findings. */
  malformedCount: number;
}

export const AUDIT_CHANGED_PATHS_MAX = 20;
export const AUDIT_SCOPE_FILES_MAX = 300;
/** Findings kept from one report; the prompt asks for fewer. */
export const AUDIT_FINDINGS_MAX = 100;

export interface AuditDetails {
  audit: ProjectAudit;
  /** Report order. */
  findings: AuditFinding[];
}

// ---------------------------------------------------------------------------
// The report a provider returns (validated before anything is stored)
// ---------------------------------------------------------------------------

export const AUDIT_TEXT_MAX = 4000;
export const AUDIT_TITLE_MAX = 200;
export const AUDIT_LOCATIONS_MAX = 10;
export const AUDIT_CRITERIA_MAX = 10;

/**
 * Plain text from the provider: control characters other than line breaks and tabs are
 * removed and the length is capped. It is always rendered as text, never as HTML.
 */
export function auditPlainText(value: string, max: number): string {
  const text = value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- removing control characters is the point.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const text = (max: number) =>
  z
    .string()
    .transform((value) => auditPlainText(value, max))
    .refine((value) => value !== '', 'Required.');
const optionalText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value == null ? null : auditPlainText(value, max) || null));
/** Enumerations are accepted in any letter case. */
const looseEnum = <T extends readonly [string, ...string[]]>(values: T, upper: boolean) =>
  z.preprocess(
    (value) =>
      typeof value === 'string'
        ? upper
          ? value.trim().toUpperCase()
          : value.trim().toLowerCase()
        : value,
    z.enum(values),
  );
const line = z
  .number()
  .int()
  .nullish()
  .transform((value) => (value == null || value < 1 ? null : value));

export const AuditReportLocationSchema = z.object({
  path: z.string().min(1).max(AUDIT_PATH_MAX),
  startLine: line,
  endLine: line,
  symbol: optionalText(AUDIT_TITLE_MAX),
});

export const AuditReportFindingSchema = z.object({
  title: text(AUDIT_TITLE_MAX),
  category: looseEnum(AUDIT_CATEGORIES, false),
  severity: looseEnum(AUDIT_SEVERITIES, true),
  confidence: looseEnum(AUDIT_CONFIDENCES, true),
  kind: looseEnum(AUDIT_FINDING_KINDS, false),
  description: text(AUDIT_TEXT_MAX),
  evidence: text(AUDIT_TEXT_MAX),
  excerpt: optionalText(AUDIT_TEXT_MAX),
  locations: z
    .array(AuditReportLocationSchema)
    .default([])
    .transform((locations) => locations.slice(0, AUDIT_LOCATIONS_MAX)),
  impact: text(AUDIT_TEXT_MAX),
  recommendation: text(AUDIT_TEXT_MAX),
  suggestedTaskTitle: text(AUDIT_TITLE_MAX),
  acceptanceCriteria: z
    .array(z.string())
    .default([])
    .transform((criteria) =>
      criteria
        .map((criterion) => auditPlainText(criterion, 500))
        .filter((criterion) => criterion !== '')
        .slice(0, AUDIT_CRITERIA_MAX),
    ),
  effort: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.enum(AUDIT_EFFORTS).nullish().catch(null),
  ),
});
export type AuditReportFinding = z.output<typeof AuditReportFindingSchema>;
