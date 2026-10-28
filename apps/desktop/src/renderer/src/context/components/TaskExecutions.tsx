import type {
  ContextTarget,
  TaskExecution,
  TaskExecutionEndReason,
  TaskExecutionStatus,
} from '@atlas/contracts';
import { useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { onTerminalLifecycle } from '@/terminal/state/terminal-events';
import { formatDateTime } from '../format';
import { useKeyedLoad } from '../hooks/useContextData';
import { PROVIDER_NAMES } from './ExecuteTaskDialog';

const STATUS: Record<TaskExecutionStatus, { label: string; tone: string }> = {
  LAUNCHING: { label: 'Starting', tone: 'bg-sky-500/15 text-sky-300' },
  RUNNING: { label: 'Running', tone: 'bg-sky-500/15 text-sky-300' },
  UNTRACKED: { label: 'Untracked', tone: 'bg-muted text-muted-foreground' },
  REVIEW_REQUIRED: { label: 'Review required', tone: 'bg-warning/15 text-warning' },
  FAILED: { label: 'Failed', tone: 'bg-destructive/15 text-destructive' },
  INTERRUPTED: { label: 'Interrupted', tone: 'bg-warning/15 text-warning' },
  CANCELLED: { label: 'Cancelled', tone: 'bg-muted text-muted-foreground' },
};

const END_REASONS: Record<TaskExecutionEndReason, string> = {
  'exit-code': 'exit code',
  'launch-failed': 'could not be started',
  'terminal-ended': 'its terminal ended',
  'engine-restart': 'ATLAS restarted',
  cancelled: 'cancelled by you',
};

const ACTIVE: TaskExecutionStatus[] = ['LAUNCHING', 'RUNNING'];

/** Label of an execution's state, with "Reviewed" once the user reviewed it. */
export function executionLabel(execution: TaskExecution): string {
  if (execution.reviewedAt !== null) return 'Reviewed';
  if (execution.status === 'RUNNING' && execution.cancelRequestedAt !== null) return 'Cancelling';
  return STATUS[execution.status].label;
}

/**
 * Recent executions of a task, kept current by `task-execution` events. The list is loaded
 * once per task and events replace or add the changed execution.
 */
export function useTaskExecutions(target: ContextTarget, targetKey: string, taskId: string) {
  const loaded = useKeyedLoad(`${targetKey}:executions:${taskId}`, () =>
    api().ai.taskExecutions(target, taskId),
  );
  const [updates, setUpdates] = useState<Map<string, TaskExecution>>(new Map());
  useEffect(
    () =>
      onTerminalLifecycle((event) => {
        if (event.type !== 'task-execution' || event.execution.taskId !== taskId) return;
        setUpdates((current) => new Map(current).set(event.execution.id, event.execution));
      }),
    [taskId],
  );
  const merged = new Map((loaded.value ?? []).map((item) => [item.id, item]));
  for (const [id, execution] of updates) merged.set(id, execution);
  const executions = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { executions, error: loaded.error };
}

interface TaskExecutionsProps {
  target: ContextTarget;
  executions: TaskExecution[];
  onOpenTerminal: (terminalId: string) => void;
}

/** History of a task's runs with their terminal, outcome, cancel and review actions. */
export function TaskExecutions({ target, executions, onOpenTerminal }: TaskExecutionsProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  if (executions.length === 0) return null;

  async function act(execution: TaskExecution, action: 'cancel' | 'review') {
    setError(null);
    setPending(execution.id);
    try {
      await unwrap(
        action === 'cancel'
          ? api().ai.cancelTaskExecution(target, execution.id)
          : api().ai.reviewTaskExecution(target, execution.id),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(null);
    }
  }

  return (
    <details className="rounded-md border px-2 py-1.5" data-testid="task-executions">
      <summary className="cursor-pointer text-xs font-medium">
        Executions ({executions.length})
      </summary>
      {error && (
        <p role="alert" className="text-destructive pt-1 text-xs">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-1.5 pt-2">
        {executions.map((execution) => {
          const active = ACTIVE.includes(execution.status);
          const reviewable = !active && execution.reviewedAt === null;
          const status = STATUS[execution.status];
          return (
            <li
              key={execution.id}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs"
              data-testid="task-execution"
              data-status={execution.status}
            >
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium',
                  execution.reviewedAt !== null ? 'bg-success/15 text-success' : status.tone,
                )}
              >
                {executionLabel(execution)}
              </span>
              <span>
                {PROVIDER_NAMES[execution.provider]}
                {execution.profileName ? ` · ${execution.profileName}` : ''}
              </span>
              <span className="text-muted-foreground">
                {execution.mode === 'new-terminal' ? 'new terminal' : 'existing terminal'} ·{' '}
                {execution.terminalTitle}
              </span>
              <span className="text-muted-foreground">
                {formatDateTime(execution.createdAt)}
                {execution.endedAt ? ` → ${formatDateTime(execution.endedAt)}` : ''}
              </span>
              {execution.endReason !== null && execution.status !== 'CANCELLED' && (
                <span className="text-muted-foreground">
                  {execution.endReason === 'exit-code'
                    ? `exit code ${execution.exitCode ?? 'unknown'}`
                    : END_REASONS[execution.endReason]}
                </span>
              )}
              <span className="ml-auto flex flex-wrap gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onOpenTerminal(execution.terminalId)}
                >
                  Open terminal
                </Button>
                {active && execution.cancelRequestedAt === null && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending === execution.id}
                    onClick={() => void act(execution, 'cancel')}
                  >
                    Cancel
                  </Button>
                )}
                {reviewable && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending === execution.id}
                    onClick={() => void act(execution, 'review')}
                  >
                    Mark reviewed
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
