import type {
  AiProvider,
  ContextTarget,
  ContextTask,
  ContextTaskStatus,
  UpdateContextTaskInput,
} from '@atlas/contracts';
import { MoreHorizontal, Play, Plus, Users } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { BUDGET_OPTIONS, formatDateTime, formatTokens } from '../format';
import { useKeyedLoad } from '../hooks/useContextData';
import { ExecuteTaskDialog } from './ExecuteTaskDialog';
import { TaskExecutions, executionLabel, useTaskExecutions } from './TaskExecutions';
import { TeamExecutions, teamLabel, useTeamExecutions } from './TeamExecutions';
import { TeamProposalDialog } from './TeamProposalDialog';

const DEFAULT_BUDGET = '__default__';

const STATUS_TONES: Record<ContextTaskStatus, string> = {
  open: 'bg-sky-500/15 text-sky-300',
  done: 'bg-success/15 text-success',
  abandoned: 'bg-muted text-muted-foreground',
};

interface TasksTabProps {
  target: ContextTarget;
  targetKey: string;
  /** Project or folder name. */
  label: string;
  /** A task to show first and highlight (e.g. from a notification). */
  focusTaskId?: string;
  /**
   * `<taskId>:<nonce>`: opens Execute with ATLAS for that task once it is loaded, e.g.
   * right after it was created from an audit finding (PLAN-056 Q4).
   */
  openTeamFor?: string;
  onChanged: () => void;
  onContinue: (provider: AiProvider, taskId: string) => void;
  onHandoff: (taskId: string) => void;
  /** Shows a terminal (an execution's), when it still exists. */
  onOpenTerminal: (terminalId: string) => void;
}

/** Development objectives whose knowledge outlives the sessions working on them. */
export function TasksTab({
  target,
  targetKey,
  label,
  focusTaskId,
  openTeamFor,
  onChanged,
  onContinue,
  onHandoff,
  onOpenTerminal,
}: TasksTabProps) {
  const tasks = useKeyedLoad(`${targetKey}:tasks`, () => api().context.tasks(target));
  const [creating, setCreating] = useState(false);
  const [executing, setExecuting] = useState<ContextTask | null>(null);
  const [teaming, setTeaming] = useState<ContextTask | null>(null);
  const [openedTeamFor, setOpenedTeamFor] = useState<string | null>(null);
  if (openTeamFor !== undefined && openTeamFor !== openedTeamFor && tasks.value !== null) {
    setOpenedTeamFor(openTeamFor);
    const task = tasks.value.find((item) => item.id === openTeamFor.split(':')[0]);
    if (task?.status === 'open') setTeaming(task);
  }
  const [error, setError] = useState<string | null>(null);

  async function change(task: ContextTask, input: UpdateContextTaskInput) {
    setError(null);
    try {
      await unwrap(api().context.updateTask(target, task.id, input));
      await tasks.reload();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <div className="flex flex-col gap-3" data-testid="context-tasks">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>
          <Plus />
          New task
        </Button>
      </div>
      {(error ?? tasks.error) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error ?? tasks.error}</AlertDescription>
        </Alert>
      )}
      {tasks.value?.length === 0 && (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          No tasks yet. A task groups the context of one objective, e.g. “Implement JWT
          authentication”, across Claude, Codex and later sessions.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {tasks.value?.map((task) => (
          <TaskItem
            key={task.id}
            task={task}
            target={target}
            targetKey={targetKey}
            highlighted={task.id === focusTaskId}
            onChange={(input) => void change(task, input)}
            onContinue={onContinue}
            onHandoff={onHandoff}
            onExecute={() => setExecuting(task)}
            onExecuteWithAtlas={() => setTeaming(task)}
            onOpenTerminal={onOpenTerminal}
          />
        ))}
      </ul>
      {executing && (
        <ExecuteTaskDialog
          target={target}
          targetKey={targetKey}
          label={label}
          task={executing}
          onClose={() => setExecuting(null)}
          onStarted={(execution) => {
            setExecuting(null);
            onOpenTerminal(execution.terminalId);
          }}
          onExecuteWithAtlas={() => {
            setTeaming(executing);
            setExecuting(null);
          }}
        />
      )}
      {teaming && (
        <TeamProposalDialog
          target={target}
          targetKey={targetKey}
          label={label}
          task={teaming}
          onClose={() => setTeaming(null)}
          onStarted={(execution) => {
            setTeaming(null);
            const terminalId = execution.stages[execution.currentStage ?? 0]?.terminalId;
            if (terminalId) onOpenTerminal(terminalId);
          }}
        />
      )}
      {creating && (
        <TaskDialog
          target={target}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void tasks.reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function TaskDialog({
  target,
  onClose,
  onCreated,
}: {
  target: ContextTarget;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await unwrap(api().context.createTask({ target, title, objective }));
      onCreated();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues[0]
          ? caught.issues[0].message
          : errorMessage(caught),
      );
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="context-task-dialog">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            ATLAS records the current commit as the task’s starting point.
          </DialogDescription>
        </DialogHeader>
        <form id="context-task-form" className="flex flex-col gap-3" onSubmit={create}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-objective">Objective</Label>
            <Textarea
              id="task-objective"
              rows={4}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="context-task-form"
            disabled={busy || !title.trim() || !objective.trim()}
          >
            Create task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TaskItemProps {
  task: ContextTask;
  target: ContextTarget;
  targetKey: string;
  highlighted: boolean;
  onChange: (input: UpdateContextTaskInput) => void;
  onContinue: (provider: AiProvider, taskId: string) => void;
  onHandoff: (taskId: string) => void;
  onExecute: () => void;
  onExecuteWithAtlas: () => void;
  onOpenTerminal: (terminalId: string) => void;
}

/**
 * One task with its actions: the same entries in the buttons, the "More actions" menu and
 * the right-click menu (a shortcut never replaces a visible action).
 */
function TaskItem({
  task,
  target,
  targetKey,
  highlighted,
  onChange,
  onContinue,
  onHandoff,
  onExecute,
  onExecuteWithAtlas,
  onOpenTerminal,
}: TaskItemProps) {
  const { executions } = useTaskExecutions(target, targetKey, task.id);
  const teams = useTeamExecutions(target, targetKey, task.id);
  const latest = executions[0];
  const latestTeam = teams[0];
  const item = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) item.current?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);
  const open = task.status === 'open';
  const actions: { label: string; run: () => void; testId?: string }[] = open
    ? [
        {
          label: 'Execute with ATLAS…',
          run: onExecuteWithAtlas,
          testId: 'task-execute-atlas-menu',
        },
        { label: 'Execute…', run: onExecute, testId: 'task-execute-menu' },
        { label: 'Continue with Claude', run: () => onContinue('claude', task.id) },
        { label: 'Continue with Codex', run: () => onContinue('codex', task.id) },
        { label: 'Prepare handoff', run: () => onHandoff(task.id) },
        { label: 'Mark done', run: () => onChange({ status: 'done' }) },
        { label: 'Abandon', run: () => onChange({ status: 'abandoned' }) },
      ]
    : [{ label: 'Reopen', run: () => onChange({ status: 'open' }) }];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          ref={item}
          className={cn(
            'flex min-w-0 flex-col gap-2 rounded-md border p-3',
            highlighted && 'border-sidebar-primary',
          )}
          data-testid="context-task"
        >
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <span className="min-w-0 font-medium break-words">{task.title}</span>
            <span className="flex flex-wrap items-center gap-1.5">
              {latestTeam &&
                latestTeam.reviewedAt === null &&
                latestTeam.status !== 'CANCELLED' && (
                  <span
                    className="bg-accent rounded px-1.5 py-0.5 text-[10px] font-medium"
                    data-testid="task-team-badge"
                  >
                    {teamLabel(latestTeam)}
                  </span>
                )}
              {latest && latest.reviewedAt === null && latest.status !== 'CANCELLED' && (
                <span
                  className="bg-accent rounded px-1.5 py-0.5 text-[10px] font-medium"
                  data-testid="task-execution-badge"
                >
                  {executionLabel(latest)}
                </span>
              )}
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium',
                  STATUS_TONES[task.status],
                )}
              >
                {task.status}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`More actions for ${task.title}`}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {actions.map((action) => (
                    <DropdownMenuItem key={action.label} onSelect={action.run}>
                      {action.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>
          <p className="text-muted-foreground text-sm whitespace-pre-wrap break-words">
            {task.objective}
          </p>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <span>Created {formatDateTime(task.createdAt)}</span>
            {task.baseCommit && <span>from {task.baseCommit.slice(0, 8)}</span>}
            <Select
              value={task.budgetTokens === null ? DEFAULT_BUDGET : String(task.budgetTokens)}
              onValueChange={(value) =>
                onChange({ budgetTokens: value === DEFAULT_BUDGET ? null : Number(value) })
              }
            >
              <SelectTrigger
                size="sm"
                className="w-auto text-xs"
                aria-label={`Context budget for ${task.title}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_BUDGET}>Default context budget</SelectItem>
                {BUDGET_OPTIONS.map((tokens) => (
                  <SelectItem key={tokens} value={String(tokens)}>
                    {formatTokens(tokens)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="ml-auto flex flex-wrap gap-1.5">
              {open ? (
                <>
                  <Button size="xs" onClick={onExecuteWithAtlas} data-testid="task-execute-atlas">
                    <Users />
                    Execute with ATLAS
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={onExecute}
                    data-testid="task-execute"
                  >
                    <Play />
                    Execute…
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => onContinue('claude', task.id)}>
                    Continue with Claude
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => onContinue('codex', task.id)}>
                    Continue with Codex
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => onHandoff(task.id)}>
                    Prepare handoff
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => onChange({ status: 'done' })}>
                    Mark done
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => onChange({ status: 'abandoned' })}
                  >
                    Abandon
                  </Button>
                </>
              ) : (
                <Button size="xs" variant="ghost" onClick={() => onChange({ status: 'open' })}>
                  Reopen
                </Button>
              )}
            </span>
          </div>
          <TeamExecutions target={target} executions={teams} onOpenTerminal={onOpenTerminal} />
          <TaskExecutions target={target} executions={executions} onOpenTerminal={onOpenTerminal} />
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map((action) => (
          <ContextMenuItem key={action.label} onSelect={action.run} data-testid={action.testId}>
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
