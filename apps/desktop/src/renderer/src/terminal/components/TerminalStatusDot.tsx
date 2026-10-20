import type { TerminalStatus } from '@atlas/contracts';
import { cn } from '@/lib/utils';
import { STATUS_LABELS } from '../format';

const TONES: Record<TerminalStatus, string> = {
  CREATED: 'bg-muted-foreground',
  STARTING: 'bg-muted-foreground',
  RUNNING: 'bg-success',
  TERMINATING: 'bg-warning animate-pulse',
  EXITED: 'bg-muted-foreground/60',
  TERMINATED: 'bg-muted-foreground/60',
  FAILED: 'bg-destructive',
};

export function TerminalStatusDot({ status }: { status: TerminalStatus }) {
  return (
    <span
      className="inline-flex shrink-0 items-center"
      data-status={status}
      data-testid="terminal-status"
    >
      <span className={cn('size-2 rounded-full', TONES[status])} aria-hidden="true" />
      <span className="sr-only">{STATUS_LABELS[status]}</span>
    </span>
  );
}
