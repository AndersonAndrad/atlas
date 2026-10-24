import type { TerminalLlmUsage } from '@atlas/contracts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { llmUsageDescription, meterTone, profileLabel, type MeterTone } from '@/usage/format';

const TONE_CLASSES: Record<MeterTone, string> = {
  normal: 'bg-success/15 text-success',
  high: 'bg-warning/15 text-warning',
  critical: 'bg-destructive/15 text-destructive',
};

/**
 * The LLM open in a terminal with its session (5h) usage, e.g. `claude-my: 26%` (PLAN-031):
 * green below 70%, yellow from 70% and red from 90%, as the Usage view meters.
 */
export function LlmUsageBadge({ usage }: { usage: TerminalLlmUsage }) {
  const { session } = usage;
  // The color follows the number shown: 89.6% reads as 90% and is red.
  const used =
    session === null || session.state === 'reset' ? null : Math.round(session.usedPercent);
  const tone = used === null ? null : meterTone(used);
  const tip = llmUsageDescription(usage, new Date());
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={tip}
          data-testid="llm-usage"
          data-tone={tone ?? 'unknown'}
          className={cn(
            'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium tabular-nums',
            tone === null ? 'bg-muted text-muted-foreground' : TONE_CLASSES[tone],
          )}
        >
          <span className="max-w-28 truncate">
            {profileLabel(usage.providerId, usage.displayName)}
          </span>
          :&nbsp;{used === null ? '—' : `${used}%`}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
