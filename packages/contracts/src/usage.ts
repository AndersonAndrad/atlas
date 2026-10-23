import { z } from 'zod';
import { AI_PROVIDERS, type AiProvider } from './context.js';

// ---------------------------------------------------------------------------
// Usage and limits (SDD-008 Milestone B, PLAN-027)
// ---------------------------------------------------------------------------

/**
 * Where an observation came from (FR-809, FR-814):
 * - `PROVIDER_CLI`: reported by the provider through a supported CLI interface
 *   (Codex `app-server`, Claude Code's status line data).
 * - `ATLAS_EXECUTION`: measured locally in sessions ATLAS started.
 * - `LOCAL_ESTIMATE`: computed on this computer (e.g. Claude Code's list-price cost).
 * `PROVIDER_API` is reserved for official usage APIs; none is used yet.
 */
export const USAGE_SOURCES = [
  'PROVIDER_API',
  'PROVIDER_CLI',
  'ATLAS_EXECUTION',
  'LOCAL_ESTIMATE',
] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/** Account state, from verified evidence only (FR-802). */
export const USAGE_PROFILE_STATUSES = [
  'CONNECTED',
  'DISCONNECTED',
  'AUTH_REQUIRED',
  'LIMITED',
  'UNKNOWN',
] as const;
export type UsageProfileStatus = (typeof USAGE_PROFILE_STATUSES)[number];

/**
 * An account profile: one provider configuration directory (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`). Milestone A extends this registry with authentication and permissions.
 */
export interface UsageProfile {
  id: string;
  providerId: AiProvider;
  /** User-defined; defaults to the directory suffix (`~/.claude-work` → "work"). */
  displayName: string;
  profileDirectory: string;
  /** `detected`: found by ATLAS (`~/.<cli>` or `~/.<cli>-<name>`); `added`: chosen by the user. */
  origin: 'detected' | 'added';
  status: UsageProfileStatus;
  /** Plan reported by the provider (e.g. `pro`, `plus`); null when unknown. */
  plan: string | null;
  /** Claude Code only: ATLAS sessions may use the ATLAS status line to read limits. */
  statusLineEnabled: boolean;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  /** Last time an ATLAS session used this profile. */
  lastUsedAt: string | null;
  /** Last successful collection. */
  lastSyncAt: string | null;
  lastError: UsageCollectionError | null;
}

export interface UsageCollectionError {
  /** Stable identifier, e.g. `cli-not-found`, `auth-required`, `unexpected-response`. */
  code: string;
  /** Safe to show: never contains tokens, e-mail addresses or raw provider output. */
  message: string;
  at: string;
}

/** `session`: a short rolling window (Claude's and Codex's 5 hours); `weekly`: 7 days. */
export const LIMIT_WINDOW_KINDS = ['session', 'weekly', 'other'] as const;
export type LimitWindowKind = (typeof LIMIT_WINDOW_KINDS)[number];

/**
 * - `current`: recently observed.
 * - `stale`: older than the freshness threshold; the value may have changed.
 * - `reset`: the reported reset time passed; the usage since then is unknown.
 */
export type LimitWindowState = 'current' | 'stale' | 'reset';

/** One provider-reported limit window (FR-812). Windows are never combined. */
export interface LimitWindow {
  /** Provider key, e.g. `five_hour`, `seven_day`, `codex:primary`. */
  key: string;
  kind: LimitWindowKind;
  label: string;
  /** 0–100, as reported. */
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
  observedAt: string;
  source: UsageSource;
  state: LimitWindowState;
}

export const USAGE_METRICS = ['TOTAL_TOKENS', 'API_DURATION', 'COST'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

/** A daily total of one metric from one source (FR-810). */
export interface UsageDayValue {
  /** Local calendar date (`YYYY-MM-DD`); provider dates are kept as reported. */
  date: string;
  metric: UsageMetric;
  /** `tokens`, `ms` or `USD`. */
  unit: string;
  value: number;
  source: UsageSource;
  isEstimated: boolean;
}

/** Calendar-week totals (Monday to Sunday) of one metric (FR-811). */
export interface UsageWeekValue {
  /** Monday of the week (`YYYY-MM-DD`). */
  weekStart: string;
  metric: UsageMetric;
  unit: string;
  value: number;
  source: UsageSource;
  isEstimated: boolean;
  /** Days with data in this week. */
  days: number;
}

export interface UsageProfileReport {
  profile: UsageProfile;
  windows: LimitWindow[];
  daily: UsageDayValue[];
  weekly: UsageWeekValue[];
  /**
   * `account`: the provider reports usage for the whole account.
   * `atlas-sessions`: only sessions started in ATLAS terminals are covered (FR-814).
   */
  coverage: 'account' | 'atlas-sessions';
}

export interface UsageSettings {
  /** Automatic collection interval for providers that support it; 0 turns it off. */
  refreshMinutes: number;
  /** Observations older than this are deleted. */
  retentionDays: number;
}

export const DEFAULT_USAGE_SETTINGS: UsageSettings = { refreshMinutes: 10, retentionDays: 90 };

export interface UsageOverview {
  generatedAt: string;
  settings: UsageSettings;
  profiles: UsageProfileReport[];
}

export const UsageProfileIdSchema = z.uuid();

export const UsageOverviewQuerySchema = z.strictObject({
  /** Days of daily history, ending today. */
  days: z.number().int().min(1).max(366).default(30),
});
export type UsageOverviewQuery = z.input<typeof UsageOverviewQuerySchema>;

export const AddUsageProfileSchema = z.strictObject({
  providerId: z.enum(AI_PROVIDERS),
  directory: z.string().min(1).max(4096),
  displayName: z.string().trim().min(1).max(80).optional(),
});
export type AddUsageProfileInput = z.input<typeof AddUsageProfileSchema>;

export const UpdateUsageProfileSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(80).optional(),
    hidden: z.boolean().optional(),
    statusLineEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update.');
export type UpdateUsageProfileInput = z.input<typeof UpdateUsageProfileSchema>;

export const UpdateUsageSettingsSchema = z
  .strictObject({
    refreshMinutes: z
      .number()
      .int()
      .refine((value) => value === 0 || (value >= 5 && value <= 1440), {
        message: 'Use 0 (off) or 5 to 1440 minutes.',
      })
      .optional(),
    retentionDays: z.number().int().min(7).max(730).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update.');
export type UpdateUsageSettingsInput = z.input<typeof UpdateUsageSettingsSchema>;
