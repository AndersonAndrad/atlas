import type { AiProvider, ContextTarget, ContextTask, ContextTaskStatus } from '@atlas/contracts';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatDateTime } from '../format';
import { useKeyedLoad } from '../hooks/useContextData';

const STATUS_TONES: Record<ContextTaskStatus, string> = {
  open: 'bg-sky-500/15 text-sky-300',
  done: 'bg-success/15 text-success',
  abandoned: 'bg-muted text-muted-foreground',
};

interface TasksTabProps {
  target: ContextTarget;
  targetKey: string;
  onChanged: () => void;
  onContinue: (provider: AiProvider, taskId: string) => void;
  onHandoff: (taskId: string) => void;
}

/** Development objectives whose knowledge outlives the sessions working on them. */
export function TasksTab({ target, targetKey, onChanged, onContinue, onHandoff }: TasksTabProps) {
  const tasks = useKeyedLoad(`${targetKey}:tasks`, () => api().context.tasks(target));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(task: ContextTask, status: ContextTaskStatus) {
    setError(null);
    try {
      await unwrap(api().context.updateTask(target, task.id, { status }));
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
          <li
            key={task.id}
            className="flex min-w-0 flex-col gap-2 rounded-md border p-3"
            data-testid="context-task"
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <span className="min-w-0 font-medium break-words">{task.title}</span>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium',
                  STATUS_TONES[task.status],
                )}
              >
                {task.status}
              </span>
            </div>
            <p className="text-muted-foreground text-sm whitespace-pre-wrap break-words">
              {task.objective}
            </p>
            <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
              <span>Created {formatDateTime(task.createdAt)}</span>
              {task.baseCommit && <span>from {task.baseCommit.slice(0, 8)}</span>}
              <span className="ml-auto flex flex-wrap gap-1.5">
                {task.status === 'open' ? (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onContinue('claude', task.id)}
                    >
                      Continue with Claude
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onContinue('codex', task.id)}
                    >
                      Continue with Codex
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => onHandoff(task.id)}>
                      Prepare handoff
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => void setStatus(task, 'done')}>
                      Mark done
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void setStatus(task, 'abandoned')}
                    >
                      Abandon
                    </Button>
                  </>
                ) : (
                  <Button size="xs" variant="ghost" onClick={() => void setStatus(task, 'open')}>
                    Reopen
                  </Button>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
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
