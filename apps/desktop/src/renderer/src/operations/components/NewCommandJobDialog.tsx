import {
  JOB_COMMAND_MAX,
  JOB_PRIORITIES,
  JOB_TIMEOUT_MINUTES_MAX,
  JOB_TITLE_MAX,
  CreateCommandJobSchema,
  type BackgroundJob,
  type JobPriority,
  type ProjectDetails,
} from '@atlas/contracts';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { JOB_PRIORITY_LABELS } from '../format';

type Field = 'projectId' | 'title' | 'command' | 'timeoutMinutes';
type FieldErrors = Partial<Record<Field, string>>;

const FIELDS: readonly Field[] = ['projectId', 'title', 'command', 'timeoutMinutes'];

function fieldErrors(issues: readonly { field: string; message: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const field = issue.field.split('.')[0] as Field;
    if (FIELDS.includes(field) && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

/**
 * Queues a command to run in a project folder in the background (SDD-012). Commands
 * ATLAS recognizes as destructive or external are queued only after an explicit
 * confirmation of the reasons the Engine reported.
 */
export function NewCommandJobDialog({
  projects,
  defaultProjectId,
  onClose,
  onQueued,
}: {
  projects: ProjectDetails[];
  defaultProjectId: string | null;
  onClose: () => void;
  onQueued: (job: BackgroundJob) => void;
}) {
  const [projectId, setProjectId] = useState(defaultProjectId ?? projects[0]?.project.id ?? '');
  const [title, setTitle] = useState('');
  const [command, setCommand] = useState('');
  const [timeout, setTimeoutMinutes] = useState('30');
  const [priority, setPriority] = useState<JobPriority>('NORMAL');
  const [dangers, setDangers] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const parsed = CreateCommandJobSchema.safeParse({
      type: 'COMMAND',
      projectId,
      ...(title.trim() === '' ? {} : { title }),
      command,
      timeoutMinutes: /^\d+$/.test(timeout.trim()) ? Number(timeout) : Number.NaN,
      priority,
      confirmDangerous: confirmed,
    });
    if (!parsed.success) {
      setErrors(
        fieldErrors(
          parsed.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message:
              issue.path[0] === 'projectId'
                ? 'Choose a project.'
                : issue.path[0] === 'timeoutMinutes'
                  ? `Enter whole minutes from 1 to ${JOB_TIMEOUT_MINUTES_MAX}.`
                  : issue.message,
          })),
        ),
      );
      return;
    }
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      onQueued(await unwrap(api().jobs.create(parsed.data)));
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'JOB_CONFIRMATION_REQUIRED') {
        setDangers(caught.issues.map((issue) => issue.message));
        setConfirmed(false);
      } else if (caught instanceof ApiError && caught.issues.length > 0) {
        const found = fieldErrors(caught.issues);
        setErrors(found);
        if (Object.keys(found).length === 0) setError(errorMessage(caught));
      } else {
        setError(errorMessage(caught));
      }
      setBusy(false);
    }
  }

  const describedBy = (field: Field) => (errors[field] ? `job-${field}-error` : undefined);
  const fieldError = (field: Field) =>
    errors[field] && (
      <p id={`job-${field}-error`} className="text-destructive text-xs">
        {errors[field]}
      </p>
    );

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent data-testid="new-command-job" className="sm:max-w-xl">
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
        >
          <DialogHeader>
            <DialogTitle>New command job</DialogTitle>
            <DialogDescription>
              Runs in the project folder with your shell, without a terminal. It keeps running when
              you close this window and stops when ATLAS quits.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="job-project">Project</Label>
            <Select value={projectId || undefined} onValueChange={setProjectId}>
              <SelectTrigger
                id="job-project"
                className="w-full"
                aria-invalid={errors.projectId ? true : undefined}
                aria-describedby={describedBy('projectId')}
              >
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map(({ project }) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldError('projectId')}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="job-command">Command</Label>
            <Textarea
              id="job-command"
              className="min-h-20 font-mono"
              value={command}
              onChange={(event) => {
                setCommand(event.target.value);
                setDangers([]);
                setConfirmed(false);
              }}
              maxLength={JOB_COMMAND_MAX}
              placeholder="pnpm test"
              spellCheck={false}
              aria-invalid={errors.command ? true : undefined}
              aria-describedby={describedBy('command')}
              autoFocus
            />
            {fieldError('command')}
          </div>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem_8rem]">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="job-title">Name (optional)</Label>
              <Input
                id="job-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={JOB_TITLE_MAX}
                placeholder="The first line of the command"
                aria-invalid={errors.title ? true : undefined}
                aria-describedby={describedBy('title')}
              />
              {fieldError('title')}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="job-timeout">Timeout (min)</Label>
              <Input
                id="job-timeout"
                inputMode="numeric"
                value={timeout}
                onChange={(event) => setTimeoutMinutes(event.target.value.replace(/\D/g, ''))}
                maxLength={4}
                aria-invalid={errors.timeoutMinutes ? true : undefined}
                aria-describedby={describedBy('timeoutMinutes')}
              />
              {fieldError('timeoutMinutes')}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="job-priority">Priority</Label>
              <Select value={priority} onValueChange={(value) => setPriority(value as JobPriority)}>
                <SelectTrigger id="job-priority" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {JOB_PRIORITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {JOB_PRIORITY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {dangers.length > 0 && (
            <Alert variant="destructive" data-testid="job-dangers">
              <TriangleAlert />
              <AlertTitle>Review this command before queueing it</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {dangers.map((danger) => (
                    <li key={danger}>It {danger}.</li>
                  ))}
                </ul>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={confirmed}
                    onCheckedChange={(value) => setConfirmed(value === true)}
                  />
                  I understand; queue it anyway
                </label>
              </AlertDescription>
            </Alert>
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (dangers.length > 0 && !confirmed)}>
              Queue job
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
