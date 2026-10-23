import type { LimitWindowKind, UsageSource } from '@atlas/contracts';

/** A limit window as one collection observed it (before freshness is assessed). */
export interface LimitSnapshot {
  key: string;
  kind: LimitWindowKind;
  label: string;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
  observedAt: string;
  source: UsageSource;
}

const SESSION_MAX_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * 24 * 60;

/** Window kind by its length: up to a day is a session window; exactly 7 days is weekly. */
export function windowKind(minutes: number | null): LimitWindowKind {
  if (minutes === null) return 'other';
  if (minutes <= SESSION_MAX_MINUTES) return 'session';
  return minutes === WEEK_MINUTES ? 'weekly' : 'other';
}

/** e.g. "Current session (5h)", "Weekly", "30-day window". */
export function windowLabel(minutes: number | null, kind: LimitWindowKind): string {
  if (kind === 'weekly') return 'Weekly';
  if (minutes === null) return 'Limit';
  const length =
    minutes % (24 * 60) === 0
      ? `${minutes / (24 * 60)}-day`
      : minutes % 60 === 0
        ? `${minutes / 60}h`
        : `${minutes}-minute`;
  return kind === 'session' ? `Current session (${length})` : `${length} window`;
}

/** Provider percentages are clamped to 0–100; anything else is not a percentage. */
export function percent(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/** Unix epoch seconds to ISO; null for missing or implausible values. */
export function epochSeconds(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
