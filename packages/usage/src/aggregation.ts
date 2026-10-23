import type {
  LimitWindow,
  LimitWindowKind,
  LimitWindowState,
  UsageDayValue,
  UsageWeekValue,
} from '@atlas/contracts';
import type { LimitSnapshot } from './windows.js';

const pad = (value: number) => String(value).padStart(2, '0');

/** Calendar date of `date` in this computer's time zone (`YYYY-MM-DD`). */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Monday of the calendar week of a `YYYY-MM-DD` date. Pure date arithmetic (no zone). */
export function weekStart(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(year, month - 1, day));
  const sinceMonday = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - sinceMonday);
  return utc.toISOString().slice(0, 10);
}

/** First date of a `days`-long range ending on `today` (inclusive). */
export function rangeStart(today: string, days: number): string {
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() - (days - 1));
  return utc.toISOString().slice(0, 10);
}

/**
 * Calendar-week totals. Metrics, units and sources are never mixed: each combination
 * gets its own total.
 */
export function weeklyTotals(daily: readonly UsageDayValue[]): UsageWeekValue[] {
  const weeks = new Map<string, UsageWeekValue>();
  for (const day of daily) {
    const start = weekStart(day.date);
    const key = [start, day.metric, day.unit, day.source, day.isEstimated].join('\0');
    const week = weeks.get(key) ?? {
      weekStart: start,
      metric: day.metric,
      unit: day.unit,
      value: 0,
      source: day.source,
      isEstimated: day.isEstimated,
      days: 0,
    };
    week.value += day.value;
    week.days += 1;
    weeks.set(key, week);
  }
  return [...weeks.values()].sort(
    (a, b) => a.weekStart.localeCompare(b.weekStart) || a.metric.localeCompare(b.metric),
  );
}

/**
 * Freshness of a window. A reset is only assumed when the provider's own reset time
 * passed, never because the calendar changed (FR-816).
 */
export function windowState(
  window: LimitSnapshot,
  now: Date,
  staleAfterMs: number,
): LimitWindowState {
  if (window.resetsAt !== null && Date.parse(window.resetsAt) <= now.getTime()) return 'reset';
  return now.getTime() - Date.parse(window.observedAt) > staleAfterMs ? 'stale' : 'current';
}

const KIND_ORDER: Record<LimitWindowKind, number> = { session: 0, weekly: 1, other: 2 };

/** Latest snapshots as displayed windows: session first, then weekly, then the rest. */
export function presentWindows(
  latest: readonly LimitSnapshot[],
  now: Date,
  staleAfterMs: number,
): LimitWindow[] {
  return latest
    .map((window) => ({ ...window, state: windowState(window, now, staleAfterMs) }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.key.localeCompare(b.key));
}
