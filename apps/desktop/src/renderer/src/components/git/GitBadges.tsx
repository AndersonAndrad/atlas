import type { GitRepositorySnapshot } from '@atlas/contracts';
import { ArrowDown, ArrowUp, FileDiff, GitBranch } from 'lucide-react';
import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { plural } from '@/git/format';
import { branchLabel, trackingDescription } from './git-format';

function Chip({
  tone = 'neutral',
  tip,
  testId,
  children,
}: {
  tone?: 'neutral' | 'warning';
  tip: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={tip}
          data-testid={testId}
          className={cn(
            'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium tabular-nums',
            tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground',
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Commits to push (ahead) and to pull (behind); a placeholder without tracking information. */
export function GitSyncBadges({ snapshot }: { snapshot: GitRepositorySnapshot }) {
  const tracking = trackingDescription(snapshot);
  if (snapshot.ahead === null || snapshot.behind === null) {
    return (
      <Chip tip={tracking} testId="git-no-upstream">
        <ArrowUp className="size-3" aria-hidden="true" />
        <ArrowDown className="size-3" aria-hidden="true" />—
      </Chip>
    );
  }
  return (
    <>
      <Chip tip={`${snapshot.ahead} local commit(s) ahead. ${tracking}`} testId="git-ahead">
        <ArrowUp className="size-3" aria-hidden="true" />
        {snapshot.ahead}
      </Chip>
      <Chip tip={`${snapshot.behind} upstream commit(s) behind. ${tracking}`} testId="git-behind">
        <ArrowDown className="size-3" aria-hidden="true" />
        {snapshot.behind}
      </Chip>
    </>
  );
}

/** Number of changed files (any kind), highlighted when there is something to commit. */
export function GitChangesBadge({ snapshot }: { snapshot: GitRepositorySnapshot }) {
  const { total } = snapshot.changes;
  return (
    <Chip
      tone={total > 0 ? 'warning' : 'neutral'}
      tip={`${plural(total, 'changed file')} (modified, staged or untracked)`}
      testId="git-changes-count"
    >
      <FileDiff className="size-3" aria-hidden="true" />
      {total}
    </Chip>
  );
}

/** Compact Git indicators: branch, modified/staged counts and ahead/behind. */
export function GitBadges({ snapshot }: { snapshot: GitRepositorySnapshot }) {
  const { changes } = snapshot;
  return (
    <span className="flex min-w-0 items-center gap-1" data-testid="git-badges">
      <Chip tip={`Branch: ${branchLabel(snapshot)}`} testId="git-branch">
        <GitBranch className="size-3" aria-hidden="true" />
        <span className="max-w-28 truncate">{branchLabel(snapshot)}</span>
      </Chip>
      {changes.modified > 0 && (
        <Chip
          tone="warning"
          tip={`${plural(changes.modified, 'modified file')} in the working tree`}
          testId="git-modified"
        >
          M:{changes.modified}
        </Chip>
      )}
      {changes.staged > 0 && (
        <Chip tip={`${plural(changes.staged, 'file')} with staged changes`} testId="git-staged">
          S:{changes.staged}
        </Chip>
      )}
      <GitSyncBadges snapshot={snapshot} />
    </span>
  );
}
