import type { LimitWindow } from '@atlas/contracts';
import { AlertTriangle, Clock, OctagonAlert } from 'lucide-react';
import { METER_COLORS, SOURCE_LABELS, formatReset, meterTone, relativeTime } from '../format';

/**
 * One provider limit window: percentage used, reset time, source and freshness. A window
 * whose reset passed shows no percentage: the usage since the reset is unknown.
 */
export function LimitMeter({ window, now }: { window: LimitWindow; now: Date }) {
  const reset = window.state === 'reset';
  const used = Math.round(window.usedPercent);
  const tone = meterTone(window.usedPercent);
  const color = METER_COLORS[tone];
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="limit-meter" data-window={window.key}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="truncate">{window.label}</span>
        <span className="font-medium tabular-nums" data-testid="limit-value">
          {reset ? 'N/A' : `${used}%`}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${window.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={reset ? undefined : used}
        aria-valuetext={reset ? 'Unknown since the last reset' : `${used}% used`}
        className="bg-muted h-2 overflow-hidden rounded-full"
        style={reset ? undefined : { backgroundColor: `${color}33` }}
      >
        {!reset && (
          <div
            className="h-full rounded-full"
            style={{ width: `${window.usedPercent}%`, backgroundColor: color }}
          />
        )}
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        {!reset && tone !== 'normal' && (
          <span className="text-foreground inline-flex items-center gap-1">
            {tone === 'critical' ? (
              <OctagonAlert className="size-3" style={{ color }} aria-hidden="true" />
            ) : (
              <AlertTriangle className="size-3" style={{ color }} aria-hidden="true" />
            )}
            {used >= 100 ? 'Limit reached' : tone === 'critical' ? 'Almost at the limit' : 'High'}
          </span>
        )}
        {reset ? (
          <span>Reset {relativeTime(window.resetsAt!, now)} — waiting for a new reading</span>
        ) : (
          window.resetsAt && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" aria-hidden="true" />
              Resets {formatReset(window.resetsAt)}
            </span>
          )
        )}
        <span title={`Observed ${new Date(window.observedAt).toLocaleString()}`}>
          {SOURCE_LABELS[window.source]} · {relativeTime(window.observedAt, now)}
          {window.state === 'stale' && (
            <span className="text-foreground" data-testid="limit-stale">
              {' '}
              · may be outdated
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
