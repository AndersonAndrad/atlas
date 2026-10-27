import type {
  LimitWindow,
  TerminalLlmUsage,
  UsageMetric,
  UsageProfile,
  UsageProfileReport,
  UsageSource,
  AiBillingKind,
} from '@atlas/contracts';

/** Meter severity: the fill color is paired with an icon and a label, never color alone. */
export type MeterTone = 'normal' | 'high' | 'critical';

export function meterTone(usedPercent: number): MeterTone {
  if (usedPercent >= 90) return 'critical';
  return usedPercent >= 70 ? 'high' : 'normal';
}

/** Dark-surface steps of the reference palette (accent blue, status warning/critical). */
export const METER_COLORS: Record<MeterTone, string> = {
  normal: '#3987e5',
  high: '#fab219',
  critical: '#d03b3b',
};

export const SOURCE_LABELS: Record<UsageSource, string> = {
  PROVIDER_API: 'Provider-reported',
  PROVIDER_CLI: 'Provider-reported',
  ATLAS_EXECUTION: 'Measured locally',
  LOCAL_ESTIMATE: 'Estimated',
};

export const PROVIDER_LABELS: Record<UsageProfile['providerId'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export const STATUS_LABELS: Record<UsageProfile['status'], string> = {
  CONNECTED: 'Connected',
  DISCONNECTED: 'Disconnected',
  AUTH_REQUIRED: 'Sign-in required',
  LIMITED: 'Limit reached',
  UNKNOWN: 'Status unknown',
};

/** The bars a profile card shows: the session window and the weekly one, or what exists. */
export function primaryWindows(report: UsageProfileReport): {
  session: LimitWindow | null;
  weekly: LimitWindow | null;
  others: LimitWindow[];
} {
  const session = report.windows.find((window) => window.kind === 'session') ?? null;
  const weekly = report.windows.find((window) => window.kind === 'weekly') ?? null;
  return {
    session,
    weekly,
    others: report.windows.filter((window) => window !== session && window !== weekly),
  };
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** e.g. "3 minutes ago", "in 2 hours". */
export function relativeTime(iso: string, now: Date): string {
  const seconds = Math.round((Date.parse(iso) - now.getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.trunc(seconds / size), unit);
  }
  return relative.format(seconds, 'second');
}

const resetFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatReset(iso: string): string {
  return resetFormatter.format(new Date(iso));
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const currency = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

/** A metric value with its unit, e.g. "1.2M tokens", "14 min", "$3.10". */
export function formatMetric(metric: UsageMetric, value: number): string {
  if (metric === 'COST') return currency.format(value);
  if (metric === 'API_DURATION') {
    const minutes = value / 60_000;
    return minutes >= 60 ? `${(minutes / 60).toFixed(1)} h` : `${Math.round(minutes)} min`;
  }
  return `${compact.format(value)} tokens`;
}

export const METRIC_LABELS: Record<UsageMetric, string> = {
  TOTAL_TOKENS: 'Tokens',
  API_DURATION: 'API time',
  COST: 'Cost at list price',
};

/** The daily metric charted for a provider: what it actually reports. */
export function chartMetric(providerId: UsageProfile['providerId']): UsageMetric {
  return providerId === 'codex' ? 'TOTAL_TOKENS' : 'API_DURATION';
}

/** Every date of the range, oldest first (`YYYY-MM-DD`, local calendar). */
export function dateRange(days: number, today: Date): string[] {
  const dates: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const month = String(day.getMonth() + 1).padStart(2, '0');
    const date = String(day.getDate()).padStart(2, '0');
    dates.push(`${day.getFullYear()}-${month}-${date}`);
  }
  return dates;
}

/**
 * Short name of a profile, as the user's CLI aliases name it: `claude` for the default
 * profile, `claude-<name>` otherwise (the name is the one in the Usage view).
 */
export function profileLabel(providerId: UsageProfile['providerId'], displayName: string): string {
  return displayName === 'default' ? providerId : `${providerId}-${displayName}`;
}

/** Tooltip text: profile, session usage, reset time and how fresh the value is. */
export function llmUsageDescription(usage: TerminalLlmUsage, now: Date): string {
  const profile = `${PROVIDER_LABELS[usage.providerId]} · ${usage.displayName}`;
  const { session } = usage;
  if (session === null) return `${profile}: no session usage reported yet.`;
  if (session.state === 'reset') {
    return `${profile}: the session window was reset ${relativeTime(session.resetsAt!, now)}; waiting for a new reading.`;
  }
  return [
    `${profile}: ${Math.round(session.usedPercent)}% of the ${session.label.toLowerCase()} used`,
    session.resetsAt === null ? null : `resets ${formatReset(session.resetsAt)}`,
    `observed ${relativeTime(session.observedAt, now)}${session.state === 'stale' ? ', may be outdated' : ''}`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/** Session cost labels (Task E01.1): an estimate is never presented as a bill. */
export const BILLING_LABELS: Record<AiBillingKind, string> = {
  SUBSCRIPTION: 'API-equivalent estimate · not charged on a subscription',
  API: 'Estimated API cost at list price · your bill may differ',
  UNKNOWN: 'Estimate at list price',
};

/** A session cost, or "Unavailable" when the session reported none. */
export function formatSessionCost(costUsd: number | null): string {
  if (costUsd === null) return 'Unavailable';
  return costUsd > 0 && costUsd < 0.01 ? '< $0.01' : currency.format(costUsd);
}
