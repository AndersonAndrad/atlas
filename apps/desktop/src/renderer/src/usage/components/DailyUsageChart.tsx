import type { UsageDayValue, UsageMetric } from '@atlas/contracts';
import { useState } from 'react';
import { METRIC_LABELS, formatMetric } from '../format';

const HEIGHT = 96;
const BAR_GAP = 2;
const BAR_COLOR = '#3987e5';

/**
 * Daily totals of one metric as thin bars (one series, one axis). Days without data are
 * empty, not zero-height guesses. Hover or focus a bar to read its value.
 */
export function DailyUsageChart({
  metric,
  dates,
  values,
}: {
  metric: UsageMetric;
  dates: string[];
  values: UsageDayValue[];
}) {
  const [active, setActive] = useState<string | null>(null);
  const byDate = new Map(
    values.filter((value) => value.metric === metric).map((value) => [value.date, value.value]),
  );
  const max = Math.max(0, ...byDate.values());
  const width = 100 / Math.max(1, dates.length);
  const shown = active ?? dates.at(-1) ?? null;
  const shownValue = shown === null ? undefined : byDate.get(shown);
  return (
    <figure className="flex min-w-0 flex-col gap-1" data-testid="daily-usage-chart">
      <figcaption className="text-muted-foreground flex flex-wrap justify-between gap-2 text-xs">
        <span>{METRIC_LABELS[metric]} per day</span>
        <span className="text-foreground tabular-nums" aria-live="polite">
          {shown === null
            ? ''
            : `${shown}: ${shownValue === undefined ? 'no data' : formatMetric(metric, shownValue)}`}
        </span>
      </figcaption>
      {max === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-xs">
          No usage recorded in this period.
        </p>
      ) : (
        <svg
          viewBox={`0 0 100 ${HEIGHT}`}
          preserveAspectRatio="none"
          className="h-24 w-full"
          role="group"
          aria-label={`${METRIC_LABELS[metric]} per day`}
        >
          <line
            x1={0}
            x2={100}
            y1={HEIGHT - 0.5}
            y2={HEIGHT - 0.5}
            stroke="#383835"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {dates.map((date, index) => {
            const value = byDate.get(date);
            const barHeight = value === undefined ? 0 : Math.max(2, (value / max) * (HEIGHT - 4));
            return (
              <g key={date}>
                {/* Taller than the bar so small values are easy to point at. */}
                <rect
                  x={index * width}
                  y={0}
                  width={width}
                  height={HEIGHT}
                  fill="transparent"
                  tabIndex={value === undefined ? -1 : 0}
                  aria-label={`${date}: ${value === undefined ? 'no data' : formatMetric(metric, value)}`}
                  onMouseEnter={() => setActive(date)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(date)}
                  onBlur={() => setActive(null)}
                />
                {value !== undefined && (
                  <rect
                    x={index * width + BAR_GAP / 4}
                    y={HEIGHT - barHeight}
                    width={Math.max(0.2, width - BAR_GAP / 2)}
                    height={barHeight}
                    rx={0.6}
                    fill={BAR_COLOR}
                    opacity={active === null || active === date ? 1 : 0.55}
                    pointerEvents="none"
                    data-testid="daily-usage-bar"
                  />
                )}
              </g>
            );
          })}
        </svg>
      )}
    </figure>
  );
}
