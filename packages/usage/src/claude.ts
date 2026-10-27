import { z } from 'zod';
import type { AccountState } from './codex.js';
import { epochSeconds, percent, windowKind, type LimitSnapshot } from './windows.js';

// Claude Code reports plan limits only to a status line command (documented status line
// JSON). Only the fields below are read; paths, session names and the rest are ignored.

const Window = z.looseObject({
  used_percentage: z.number(),
  resets_at: z.number().nullable().optional(),
});

export const ClaudeStatusSchema = z.looseObject({
  session_id: z.string().min(1).max(200),
  model: z.looseObject({ id: z.string().max(200).optional() }).optional(),
  cost: z
    .looseObject({
      total_cost_usd: z.number().nonnegative().optional(),
      total_api_duration_ms: z.number().nonnegative().optional(),
    })
    .optional(),
  rate_limits: z
    .looseObject({
      five_hour: Window.optional(),
      seven_day: Window.optional(),
      spend_limit: Window.optional(),
    })
    .optional(),
});

export interface ClaudeStatus {
  sessionId: string;
  windows: LimitSnapshot[];
  /** `model.id`, e.g. `claude-opus-5-5`. */
  model: string | null;
  /** Cumulative for the session; resets when `/clear` starts a new one. */
  costUsd: number | null;
  apiDurationMs: number | null;
}

const WINDOWS = [
  { key: 'five_hour', minutes: 5 * 60, label: 'Current session (5h)' },
  { key: 'seven_day', minutes: 7 * 24 * 60, label: 'Weekly' },
  { key: 'spend_limit', minutes: null, label: 'Spend limit' },
] as const;

export function parseClaudeStatus(value: unknown, observedAt: string): ClaudeStatus {
  const parsed = ClaudeStatusSchema.parse(value);
  const windows: LimitSnapshot[] = [];
  for (const definition of WINDOWS) {
    const window = parsed.rate_limits?.[definition.key];
    if (window === undefined) continue;
    const used = percent(window.used_percentage);
    if (used === null) continue;
    windows.push({
      key: definition.key,
      kind: windowKind(definition.minutes),
      label: definition.label,
      usedPercent: used,
      windowMinutes: definition.minutes,
      resetsAt: epochSeconds(window.resets_at),
      observedAt,
      source: 'PROVIDER_CLI',
    });
  }
  return {
    sessionId: parsed.session_id,
    windows,
    model: parsed.model?.id ?? null,
    costUsd: parsed.cost?.total_cost_usd ?? null,
    apiDurationMs: parsed.cost?.total_api_duration_ms ?? null,
  };
}

const AuthStatusSchema = z.looseObject({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  subscriptionType: z.string().nullable().optional(),
});

/**
 * `claude auth status --json`. Only the sign-in state and plan are kept; the e-mail
 * address and organization are never read into ATLAS.
 */
export function parseClaudeAuthStatus(value: unknown): AccountState {
  const parsed = AuthStatusSchema.parse(value);
  if (!parsed.loggedIn) return { status: 'AUTH_REQUIRED', plan: null };
  const plan = parsed.subscriptionType ?? null;
  return { status: 'CONNECTED', plan: plan === '' ? null : plan };
}
