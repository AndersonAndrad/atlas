import { z } from 'zod';
import type { UsageProfileStatus } from '@atlas/contracts';
import { epochSeconds, percent, windowKind, windowLabel, type LimitSnapshot } from './windows.js';

// Codex `app-server` protocol v2 (codex-cli 0.156): `account/read`,
// `account/rateLimits/read` and `account/usage/read`. Unknown fields are ignored;
// a response without the fields below is rejected rather than guessed.

const Window = z.looseObject({
  usedPercent: z.number(),
  windowDurationMins: z.number().int().nullable().optional(),
  resetsAt: z.number().int().nullable().optional(),
});

const Snapshot = z.looseObject({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  primary: Window.nullable().optional(),
  secondary: Window.nullable().optional(),
  planType: z.string().nullable().optional(),
  rateLimitReachedType: z.unknown().optional(),
});

export const CodexRateLimitsResponseSchema = z.looseObject({
  rateLimits: Snapshot,
  rateLimitsByLimitId: z.record(z.string(), Snapshot).nullable().optional(),
  ordinaryUsageAllowed: z.boolean().nullable().optional(),
});

export const CodexUsageResponseSchema = z.looseObject({
  dailyUsageBuckets: z
    .array(
      z.looseObject({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        tokens: z.number().int().nonnegative(),
      }),
    )
    .nullable()
    .optional(),
});

export const CodexAccountResponseSchema = z.looseObject({
  account: z
    .looseObject({ type: z.string(), planType: z.string().nullable().optional() })
    .nullable(),
  requiresOpenaiAuth: z.boolean().optional(),
});

/** Sign-in state and plan of a profile, from the provider's own CLI. */
export interface AccountState {
  status: UsageProfileStatus;
  plan: string | null;
}

/** Signed in when the server returns an account; the e-mail address is never kept. */
export function parseCodexAccount(value: unknown): AccountState {
  const parsed = CodexAccountResponseSchema.parse(value);
  if (parsed.account === null) return { status: 'AUTH_REQUIRED', plan: null };
  return { status: 'CONNECTED', plan: parsed.account.planType ?? null };
}

function snapshotWindows(
  snapshot: z.infer<typeof Snapshot>,
  observedAt: string,
  prefix: string,
  named: boolean,
): LimitSnapshot[] {
  const windows: LimitSnapshot[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const window = snapshot[slot];
    if (window === null || window === undefined) continue;
    const used = percent(window.usedPercent);
    if (used === null) continue;
    const minutes = window.windowDurationMins ?? null;
    const base = windowLabel(minutes, windowKind(minutes));
    const kind = named ? 'other' : windowKind(minutes);
    windows.push({
      key: `${prefix}:${slot}`,
      kind,
      label: named ? `${snapshot.limitName ?? snapshot.limitId ?? prefix} · ${base}` : base,
      usedPercent: used,
      windowMinutes: minutes,
      resetsAt: epochSeconds(window.resetsAt),
      observedAt,
      source: 'PROVIDER_CLI',
    });
  }
  return windows;
}

export interface CodexLimits {
  windows: LimitSnapshot[];
  plan: string | null;
  /** The server reported that a limit was reached or ordinary usage is not allowed. */
  limited: boolean;
}

/**
 * The main bucket (`rateLimits`) gives the session and weekly windows; other buckets
 * (e.g. model-specific allowances) are kept as separate `other` windows, never merged.
 */
export function parseCodexRateLimits(value: unknown, observedAt: string): CodexLimits {
  const parsed = CodexRateLimitsResponseSchema.parse(value);
  const main = parsed.rateLimits;
  const mainId = main.limitId ?? 'codex';
  const windows = snapshotWindows(main, observedAt, 'codex', false);
  for (const [id, snapshot] of Object.entries(parsed.rateLimitsByLimitId ?? {})) {
    if (id === mainId) continue;
    windows.push(...snapshotWindows(snapshot, observedAt, `codex:${id}`, true));
  }
  const reached = main.rateLimitReachedType !== null && main.rateLimitReachedType !== undefined;
  return {
    windows,
    plan: main.planType ?? null,
    limited: reached || parsed.ordinaryUsageAllowed === false,
  };
}

/** Account-wide tokens per day, as the provider reports them. */
export function parseCodexDailyTokens(value: unknown): { date: string; tokens: number }[] {
  const parsed = CodexUsageResponseSchema.parse(value);
  return (parsed.dailyUsageBuckets ?? []).map((bucket) => ({
    date: bucket.startDate,
    tokens: bucket.tokens,
  }));
}
