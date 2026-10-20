import type { GitOperation, GitOperationKind } from '@atlas/contracts';
import { Activity, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { isActive } from '../format';
import { OperationsPanel } from './OperationsPanel';

/** Failures that open the panel by themselves; commit failures are shown in their dialog. */
const AUTO_OPEN: ReadonlySet<GitOperationKind> = new Set(['fetch', 'pull', 'push']);

/**
 * Open state of the operations panel, the "failure not seen yet" indicator and
 * opening on remote failures. Only operations that were queued or running while
 * this view was shown count, so failures from the history never pop up later.
 */
export function useOperationsSheet(
  operations: GitOperation[],
  /** False while something else shows the result (e.g. the commit dialog) or outside the Git view. */
  autoOpen = true,
) {
  const [open, setOpen] = useState(false);
  const [watched, setWatched] = useState<ReadonlySet<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const [autoOpened, setAutoOpened] = useState<string | null>(null);

  const newlyActive = operations.filter(
    (operation) => isActive(operation) && !watched.has(operation.id),
  );
  if (newlyActive.length > 0) {
    setWatched(new Set([...watched, ...newlyActive.map((operation) => operation.id)]));
  }
  // Newest first: the most recent failure this view saw happen.
  const failure = operations.find(
    (operation) => operation.status === 'failed' && watched.has(operation.id),
  );
  if (failure && AUTO_OPEN.has(failure.kind) && failure.id !== autoOpened) {
    // Taken once: a failure that was not opened now is never opened later.
    setAutoOpened(failure.id);
    if (autoOpen) {
      setOpen(true);
      setAcknowledged(failure.id);
    }
  }

  return {
    open,
    setOpen: (value: boolean) => {
      setOpen(value);
      if (value) setAcknowledged(failure?.id ?? null);
    },
    running: operations.filter(isActive).length,
    unseenFailure: failure !== undefined && failure.id !== acknowledged && !open,
  };
}

interface OperationsButtonProps {
  running: number;
  unseenFailure: boolean;
  onClick: () => void;
  size?: 'sm' | 'icon-xs';
}

/** Opens the operations panel; shows activity and failures that were not seen yet. */
export function OperationsButton({
  running,
  unseenFailure,
  onClick,
  size = 'sm',
}: OperationsButtonProps) {
  const label =
    running > 0
      ? `Operations (${running} running)`
      : unseenFailure
        ? 'Operations (a recent operation failed)'
        : 'Operations';
  return (
    <Button
      variant="ghost"
      size={size}
      className="relative"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid="git-operations-button"
    >
      {running > 0 ? <LoaderCircle className="animate-spin" /> : <Activity />}
      {size === 'sm' && <span className="hidden sm:inline">Operations</span>}
      {running > 0 && size === 'sm' && (
        <span className="bg-muted rounded-full px-1.5 text-[10px] tabular-nums">{running}</span>
      )}
      {unseenFailure && (
        <span
          className={cn(
            'bg-destructive ring-background pointer-events-none absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2',
          )}
          aria-hidden="true"
          data-testid="git-operations-failure-dot"
        />
      )}
    </Button>
  );
}

interface OperationsSheetProps {
  repositoryName: string;
  operations: GitOperation[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Side panel with the repository's recent Git operations. */
export function OperationsSheet({
  repositoryName,
  operations,
  open,
  onOpenChange,
}: OperationsSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-xl"
        data-testid="git-operations-sheet"
      >
        <SheetHeader>
          <SheetTitle>Operations</SheetTitle>
          <SheetDescription>Recent Git operations in {repositoryName}.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <OperationsPanel operations={operations} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
