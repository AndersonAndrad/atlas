import type { ProjectGitState } from '@atlas/contracts';
import { CircleCheck, CircleDot, CircleHelp, History } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { projectGitIndicator } from './git-format';

const ICONS = { attention: CircleDot, clean: CircleCheck, unknown: CircleHelp } as const;

/**
 * Git status of a project from its stored snapshot (SDD-024 FR-006): attention (yellow),
 * clean (subdued) or unknown (dashed). Cached data carries a clock icon. Rendering it never
 * runs Git.
 */
export function ProjectGitBadge({
  state,
  focusable = true,
}: {
  state: ProjectGitState | undefined;
  /** False inside another control (e.g. a card button): no own focus stop or tooltip. */
  focusable?: boolean;
}) {
  const indicator = projectGitIndicator(state);
  const Icon = ICONS[indicator.kind];
  const cached = indicator.kind !== 'unknown' && !indicator.live;
  const badge = (
    <span
      {...(focusable ? { tabIndex: 0 } : { title: indicator.description })}
      role="img"
      aria-label={`Git: ${indicator.description}`}
      data-testid="project-git-badge"
      data-state={indicator.kind}
      data-freshness={state?.freshness ?? 'none'}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        indicator.kind === 'attention' && 'bg-warning/15 text-warning',
        indicator.kind === 'clean' && 'bg-muted text-muted-foreground',
        indicator.kind === 'unknown' && 'text-muted-foreground border border-dashed',
        cached && 'opacity-75',
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {indicator.changes !== null && indicator.changes > 0 && (
        <span data-testid="git-changes-count">{indicator.changes}</span>
      )}
      {cached && <History className="size-3" aria-hidden="true" data-testid="git-cached" />}
    </span>
  );
  if (!focusable) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-72">{indicator.description}</TooltipContent>
    </Tooltip>
  );
}
