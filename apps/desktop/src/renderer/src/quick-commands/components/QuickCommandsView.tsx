import {
  QUICK_COMMAND_MAX_LENGTH,
  QUICK_COMMAND_NAME_MAX_LENGTH,
  QUICK_COMMANDS_MAX_COUNT,
  QuickCommandInputSchema,
  type QuickCommand,
  type QuickCommandInput,
} from '@atlas/contracts';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { cn } from '@/lib/utils';
import type { ProjectDetails } from '@/types';
import { projectLabels, scopeSummary } from '../scope';
import { ProjectScopePicker } from './ProjectScopePicker';

type Field = 'name' | 'command' | 'projectIds';
type FieldErrors = Partial<Record<Field, string>>;

function fieldErrors(issues: { field: string; message: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const field = issue.field
      .split('.')
      .find((part): part is Field => ['name', 'command', 'projectIds'].includes(part));
    if (field !== undefined && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

/** Adds or edits a quick command; validated here and again by the Engine. */
function QuickCommandDialog({
  command,
  projects,
  onClose,
  onSaved,
}: {
  command: QuickCommand | null;
  projects: ProjectDetails[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(command?.name ?? '');
  const [text, setText] = useState(command?.command ?? '');
  const [projectIds, setProjectIds] = useState<string[]>(command?.projectIds ?? []);
  // A command whose projects were all removed must not become global without notice.
  const wasUnassigned = command?.scope === 'PROJECTS' && command.projectIds.length === 0;
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const parsed = QuickCommandInputSchema.safeParse({ name, command: text, projectIds });
    if (!parsed.success) {
      setErrors(
        fieldErrors(
          parsed.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        ),
      );
      return;
    }
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      const input: QuickCommandInput = parsed.data;
      await unwrap(
        command ? api().quickCommands.update(command.id, input) : api().quickCommands.create(input),
      );
      onSaved();
    } catch (caught) {
      if (caught instanceof ApiError && caught.issues.length > 0) {
        const found = fieldErrors(caught.issues);
        setErrors(found);
        if (Object.keys(found).length === 0) setError(errorMessage(caught));
      } else {
        setError(errorMessage(caught));
      }
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" data-testid="quick-command-dialog">
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          noValidate
        >
          <DialogHeader>
            <DialogTitle>{command ? 'Edit quick command' : 'New quick command'}</DialogTitle>
            <DialogDescription>
              Runs in a new terminal opened in the project, as if you typed it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-command-name">Name</Label>
            <Input
              id="quick-command-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={QUICK_COMMAND_NAME_MAX_LENGTH}
              placeholder="Dev server"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? 'quick-command-name-error' : undefined}
              autoFocus
            />
            {errors.name && (
              <p id="quick-command-name-error" className="text-destructive text-xs">
                {errors.name}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-command-text">Command</Label>
            <Input
              id="quick-command-text"
              className="font-mono"
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={QUICK_COMMAND_MAX_LENGTH}
              placeholder="npm run dev"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-invalid={errors.command ? true : undefined}
              aria-describedby={
                errors.command ? 'quick-command-text-error' : 'quick-command-text-help'
              }
            />
            {errors.command ? (
              <p id="quick-command-text-error" className="text-destructive text-xs">
                {errors.command}
              </p>
            ) : (
              <p id="quick-command-text-help" className="text-muted-foreground text-xs">
                One line. Use <code>&amp;&amp;</code> to chain commands.
              </p>
            )}
          </div>
          <ProjectScopePicker projects={projects} selected={projectIds} onChange={setProjectIds} />
          {errors.projectIds && (
            <p className="text-destructive text-xs" role="alert">
              {errors.projectIds}
            </p>
          )}
          {wasUnassigned && projectIds.length === 0 && (
            <Alert role="status">
              <AlertDescription>
                Its projects were removed. Saving without projects makes it available in all
                projects.
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Quick commands (PLAN-023, SDD-025 Task 03): named commands that open a terminal and run
 * there, available in every project or only in the projects selected for them.
 */
export function QuickCommandsView({ projects }: { projects: ProjectDetails[] }) {
  const [commands, setCommands] = useState<QuickCommand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<QuickCommand | 'new' | null>(null);
  const [removing, setRemoving] = useState<QuickCommand | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    unwrap(api().quickCommands.list()).then(
      (value) => {
        setCommands(value);
        setError(null);
      },
      (caught: unknown) => setError(errorMessage(caught)),
    );
  }, []);

  useEffect(() => load(), [load]);

  async function act(task: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await task();
      load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const full = (commands?.length ?? 0) >= QUICK_COMMANDS_MAX_COUNT;
  const labels = projectLabels(projects);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="quick-commands-view">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">Quick commands</h1>
        <Button size="sm" onClick={() => setEditing('new')} disabled={full}>
          <Plus />
          Add command
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            A quick command opens a new terminal in a project and runs there. Without selected
            projects it is available in all projects, and also when no project is selected;
            otherwise only in its projects.
          </p>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {commands?.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center">
              <Zap className="text-muted-foreground size-6" aria-hidden="true" />
              <p className="text-sm font-medium">No quick commands yet</p>
              <p className="text-muted-foreground text-xs">
                Add one, e.g. “Dev server” running <code>npm run dev</code>.
              </p>
            </div>
          )}
          {commands && commands.length > 0 && (
            <ol
              className="bg-card flex flex-col divide-y rounded-lg border"
              aria-label="Quick commands"
            >
              {commands.map((command, index) => {
                const scope = scopeSummary(command, labels);
                return (
                  <li
                    key={command.id}
                    className="flex min-w-0 flex-wrap items-center gap-2 p-3"
                    data-testid="quick-command"
                    data-scope={command.scope}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{command.name}</span>
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                            scope.unassigned
                              ? 'bg-destructive/15 text-destructive'
                              : command.scope === 'ALL'
                                ? 'bg-primary/15 text-primary'
                                : 'bg-muted text-muted-foreground',
                          )}
                          title={scope.detail ?? undefined}
                          data-testid="quick-command-scope"
                        >
                          {scope.label}
                        </span>
                      </span>
                      <code className="text-muted-foreground font-mono text-xs break-all">
                        {command.command}
                      </code>
                      {scope.detail && (
                        <span
                          className={cn(
                            'truncate text-xs',
                            scope.unassigned ? 'text-destructive' : 'text-muted-foreground',
                          )}
                          data-testid="quick-command-projects"
                        >
                          {scope.detail}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Move ${command.name} up`}
                        disabled={busy || index === 0}
                        onClick={() =>
                          void act(() => unwrap(api().quickCommands.move(command.id, 'up')))
                        }
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Move ${command.name} down`}
                        disabled={busy || index === commands.length - 1}
                        onClick={() =>
                          void act(() => unwrap(api().quickCommands.move(command.id, 'down')))
                        }
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${command.name}`}
                        disabled={busy}
                        onClick={() => setEditing(command)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${command.name}`}
                        disabled={busy}
                        onClick={() => setRemoving(command)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {full && (
            <p className="text-muted-foreground text-xs">
              At most {QUICK_COMMANDS_MAX_COUNT} quick commands can be kept.
            </p>
          )}
        </div>
      </div>

      {editing !== null && (
        <QuickCommandDialog
          command={editing === 'new' ? null : editing}
          projects={projects}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {removing && (
        <AlertDialog open onOpenChange={(open) => !open && !busy && setRemoving(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove quick command</AlertDialogTitle>
              <AlertDialogDescription>
                Remove <strong className="text-foreground wrap-anywhere">{removing.name}</strong>?
                It disappears from every project&apos;s menus. Running terminals are not affected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await unwrap(api().quickCommands.remove(removing.id));
                    setRemoving(null);
                  })
                }
              >
                Remove
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </main>
  );
}
