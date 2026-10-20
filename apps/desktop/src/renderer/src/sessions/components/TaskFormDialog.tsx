import {
  SESSION_TASK_DESCRIPTION_MAX_LENGTH,
  SESSION_TASK_TITLE_MAX_LENGTH,
  type SessionTask,
} from '@atlas/contracts';
import { useId, useState, type FormEvent } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { parseLines } from '../format';

interface TaskFormDialogProps {
  sessionId: string;
  /** Edits this task; otherwise a new one is added. */
  task?: SessionTask;
  /** Every task of the session, for dependency selection. */
  tasks: SessionTask[];
  onClose: () => void;
  onSaved: () => void;
}

/** Plans a task. Dependency cycles are rejected by the Engine. */
export function TaskFormDialog({ sessionId, task, tasks, onClose, onSaved }: TaskFormDialogProps) {
  const formId = useId();
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [criteria, setCriteria] = useState(task?.validationCriteria.join('\n') ?? '');
  const [dependencies, setDependencies] = useState<string[]>(task?.dependencies ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const candidates = tasks.filter((item) => item.id !== task?.id);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (title.trim() === '') {
      setError('Title is required.');
      return;
    }
    const input = {
      title,
      description,
      dependencies,
      validationCriteria: parseLines(criteria),
    };
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        task
          ? api().sessions.updateTask(sessionId, task.id, input)
          : api().sessions.addTask(sessionId, input),
      );
      onSaved();
    } catch (caught) {
      const issue = caught instanceof ApiError ? caught.issues[0] : undefined;
      setError(issue ? issue.message : errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string, checked: boolean) =>
    setDependencies((current) =>
      checked ? [...current, id] : current.filter((dependency) => dependency !== id),
    );

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        data-testid="task-form-dialog"
      >
        <DialogHeader>
          <DialogTitle>{task ? 'Edit task' : 'Add task'}</DialogTitle>
          <DialogDescription>
            Tasks are planned work for future agents. They are not executed yet.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${formId}-title`}>Title</Label>
            <Input
              id={`${formId}-title`}
              autoFocus
              value={title}
              maxLength={SESSION_TASK_TITLE_MAX_LENGTH}
              autoComplete="off"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${formId}-description`}>
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea
              id={`${formId}-description`}
              rows={3}
              value={description}
              maxLength={SESSION_TASK_DESCRIPTION_MAX_LENGTH}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${formId}-criteria`}>
              Validation criteria{' '}
              <span className="text-muted-foreground font-normal">(one per line)</span>
            </Label>
            <Textarea
              id={`${formId}-criteria`}
              rows={3}
              value={criteria}
              placeholder="All tests pass"
              onChange={(event) => setCriteria(event.target.value)}
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Depends on</legend>
            {candidates.length === 0 ? (
              <p className="text-muted-foreground text-xs">No other tasks yet.</p>
            ) : (
              <ul
                className="flex max-h-40 flex-col gap-2 overflow-y-auto"
                data-testid="task-dependencies"
              >
                {candidates.map((candidate) => {
                  const id = `${formId}-dep-${candidate.id}`;
                  return (
                    <li key={candidate.id} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={dependencies.includes(candidate.id)}
                        onCheckedChange={(checked) => toggle(candidate.id, checked === true)}
                      />
                      <Label htmlFor={id} className="truncate font-normal">
                        {candidate.title}
                      </Label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription data-testid="task-form-error">{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : task ? 'Save task' : 'Add task'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
