import type { GitOperation } from '@atlas/contracts';
import { Ban, CircleCheck, CircleX, Clock, LoaderCircle } from 'lucide-react';
import { api, unwrap } from '@/api';
import { Button } from '@/components/ui/button';
import { relativeTime } from '@/components/git/git-format';
import { cn } from '@/lib/utils';
import { OPERATION_LABELS, isActive } from '../format';

function StatusIcon({ operation }: { operation: GitOperation }) {
  const common = 'size-4 shrink-0';
  switch (operation.status) {
    case 'queued':
      return <Clock className={cn(common, 'text-muted-foreground')} aria-label="Queued" />;
    case 'running':
      return (
        <LoaderCircle className={cn(common, 'text-sky-400 animate-spin')} aria-label="Running" />
      );
    case 'succeeded':
      return <CircleCheck className={cn(common, 'text-success')} aria-label="Succeeded" />;
    case 'failed':
      return <CircleX className={cn(common, 'text-destructive')} aria-label="Failed" />;
    case 'cancelled':
      return <Ban className={cn(common, 'text-muted-foreground')} aria-label="Cancelled" />;
  }
}

/** One operation's outcome, with Git's own output available on demand. */
export function OperationResult({ operation }: { operation: GitOperation }) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-testid="git-operation"
      data-kind={operation.kind}
      data-status={operation.status}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <StatusIcon operation={operation} />
        <span className="font-medium">{OPERATION_LABELS[operation.kind]}</span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            operation.error ? 'text-destructive' : 'text-muted-foreground',
          )}
          title={operation.error?.message ?? operation.summary ?? undefined}
        >
          {operation.error?.message ??
            operation.summary ??
            (operation.status === 'queued' ? 'Waiting for another operation…' : 'Running…')}
        </span>
      </div>
      {operation.status === 'running' && operation.progress && (
        <div className="flex items-center gap-2 pl-6 text-xs" role="status">
          <span className="text-muted-foreground truncate">{operation.progress.phase}</span>
          {operation.progress.percent !== null && (
            <>
              <span
                className="bg-muted h-1 w-24 overflow-hidden rounded-full"
                role="progressbar"
                aria-valuenow={operation.progress.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={operation.progress.phase}
              >
                <span
                  className="bg-sky-400 block h-full"
                  style={{ width: `${operation.progress.percent}%` }}
                />
              </span>
              <span className="tabular-nums">{operation.progress.percent}%</span>
            </>
          )}
        </div>
      )}
      {operation.error?.output && (
        <details className="pl-6 text-xs">
          <summary className="text-muted-foreground cursor-pointer select-none">Git output</summary>
          <pre
            className="bg-muted/50 mt-1 max-h-48 overflow-auto rounded p-2 font-mono whitespace-pre-wrap"
            data-testid="git-operation-output"
          >
            {operation.error.output}
          </pre>
        </details>
      )}
    </div>
  );
}

interface OperationsPanelProps {
  operations: GitOperation[];
}

/** Recent Git operations of the repository, newest first. */
export function OperationsPanel({ operations }: OperationsPanelProps) {
  if (operations.length === 0) {
    return <p className="text-muted-foreground px-1 text-xs">No Git operations yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-2" aria-label="Git operations" aria-live="polite">
      {operations.slice(0, 10).map((operation) => (
        <li key={operation.id} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <OperationResult operation={operation} />
          </div>
          <span className="text-muted-foreground shrink-0 pt-0.5 text-[11px]">
            {relativeTime(operation.startedAt)}
          </span>
          {isActive(operation) && operation.cancellable && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() =>
                void unwrap(api().git.cancelOperation(operation.id)).catch(() => undefined)
              }
            >
              Cancel
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
