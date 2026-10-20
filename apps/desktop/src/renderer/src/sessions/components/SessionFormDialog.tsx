import {
  CreateSessionInputSchema,
  EXECUTION_PROFILE_DEFINITIONS,
  SESSION_NAME_MAX_LENGTH,
  SESSION_OBJECTIVE_MAX_LENGTH,
  UpdateSessionInputSchema,
  type AtlasSession,
  type CreateSessionInput,
  type ExecutionProfile,
  type IpcResult,
  type UpdateSessionInput,
} from '@atlas/contracts';
import { FolderOpen } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { ProjectDetails } from '@/types';
import { parseLines } from '../format';

const FIELDS = ['name', 'objective', 'workspacePath', 'executionProfile', 'constraints'] as const;
type Field = (typeof FIELDS)[number];
type FieldErrors = Partial<Record<Field, string>>;

const NO_WORKSPACE = 'none';
const FOLDER = 'folder';
const PROJECT_PREFIX = 'project:';

interface SessionFormDialogProps {
  /** Edits this draft; otherwise a new session is created. */
  session?: AtlasSession;
  projects: ProjectDetails[];
  /** Preselected project for a new session. */
  initialProjectId?: string | null;
  onClose: () => void;
  onSaved: (session: AtlasSession) => void;
}

function toFieldErrors(issues: { field: string; message: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const raw = issue.field.split('.')[0];
    const field = (raw === 'projectId' ? 'workspacePath' : raw) as Field;
    if (FIELDS.includes(field) && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

function initialWorkspace(session: AtlasSession | undefined, projectId?: string | null): string {
  if (session?.projectId) return PROJECT_PREFIX + session.projectId;
  if (session?.workspacePath) return FOLDER;
  if (session === undefined && projectId) return PROJECT_PREFIX + projectId;
  return NO_WORKSPACE;
}

/** Creates a session or edits a draft. Nothing is executed. */
export function SessionFormDialog({
  session,
  projects,
  initialProjectId,
  onClose,
  onSaved,
}: SessionFormDialogProps) {
  const isEdit = session !== undefined;
  const formId = useId();
  const [name, setName] = useState(session?.name ?? '');
  const [objective, setObjective] = useState(session?.objective ?? '');
  const [workspace, setWorkspace] = useState(initialWorkspace(session, initialProjectId));
  const [pickedFolder, setPickedFolder] = useState<string | null>(null);
  const [profile, setProfile] = useState<ExecutionProfile>(session?.executionProfile ?? 'BALANCED');
  const [constraints, setConstraints] = useState(session?.constraints.join('\n') ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const folderPath = pickedFolder ?? (session?.projectId ? null : session?.workspacePath) ?? null;

  async function chooseFolder() {
    setFormError(null);
    try {
      const choice = await unwrap(api().dialog.chooseDirectory('session'));
      if (choice.canceled || !choice.inspection) return;
      setPickedFolder(choice.inspection.inputPath);
      setWorkspace(FOLDER);
      setErrors((current) => ({ ...current, workspacePath: undefined }));
    } catch (error) {
      setFormError(errorMessage(error));
    }
  }

  /** Workspace fields of the request; only what changed is sent when editing. */
  function workspaceInput(): Pick<CreateSessionInput, 'projectId' | 'workspacePath'> | null {
    if (workspace.startsWith(PROJECT_PREFIX)) {
      const projectId = workspace.slice(PROJECT_PREFIX.length);
      return isEdit && session.projectId === projectId ? {} : { projectId };
    }
    if (workspace === FOLDER) {
      if (pickedFolder !== null) return { workspacePath: pickedFolder };
      if (isEdit && session.workspacePath !== null) return {};
      setErrors((current) => ({ ...current, workspacePath: 'Choose a folder.' }));
      return null;
    }
    return {};
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const location = workspaceInput();
    if (location === null) return;
    const base = {
      name,
      objective,
      executionProfile: profile,
      constraints: parseLines(constraints),
    };

    let request: () => Promise<IpcResult<AtlasSession>>;
    if (isEdit) {
      const clearWorkspace =
        workspace === NO_WORKSPACE &&
        (session.projectId !== null || session.workspacePath !== null);
      const input: UpdateSessionInput = {
        ...base,
        ...location,
        ...(clearWorkspace ? { projectId: null, workspacePath: null } : {}),
      };
      const parsed = UpdateSessionInputSchema.safeParse(input);
      if (!parsed.success) {
        setErrors(toFieldErrors(zodIssues(parsed.error.issues)));
        return;
      }
      request = () => api().sessions.update(session.id, input);
    } else {
      const input: CreateSessionInput = { ...base, ...location };
      const parsed = CreateSessionInputSchema.safeParse(input);
      if (!parsed.success) {
        setErrors(toFieldErrors(zodIssues(parsed.error.issues)));
        return;
      }
      request = () => api().sessions.create(input);
    }

    setErrors({});
    setBusy(true);
    try {
      onSaved(await unwrap(request()));
    } catch (error) {
      if (error instanceof ApiError && error.issues.length > 0) {
        setErrors(toFieldErrors(error.issues));
      }
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const fieldId = (field: string) => `${formId}-${field}`;
  const errorId = (field: Field) => `${formId}-${field}-error`;
  const describedBy = (field: Field) => (errors[field] ? errorId(field) : undefined);
  const fieldError = (field: Field) =>
    errors[field] && (
      <p id={errorId(field)} className="text-destructive text-xs">
        {errors[field]}
      </p>
    );
  const selectedProfile = EXECUTION_PROFILE_DEFINITIONS.find((item) => item.id === profile);

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        data-testid="session-form-dialog"
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit draft session' : 'New session'}</DialogTitle>
          <DialogDescription>
            A session records an objective and its plan. No AI provider is needed, and nothing runs
            until execution adapters are available.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor={fieldId('name')}>Name</Label>
            <Input
              id={fieldId('name')}
              value={name}
              maxLength={SESSION_NAME_MAX_LENGTH}
              autoComplete="off"
              autoFocus
              placeholder="NOVA authentication"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={describedBy('name')}
              onChange={(event) => setName(event.target.value)}
            />
            {fieldError('name')}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={fieldId('objective')}>Objective</Label>
            <Textarea
              id={fieldId('objective')}
              value={objective}
              rows={4}
              maxLength={SESSION_OBJECTIVE_MAX_LENGTH}
              placeholder="Implement authentication with refresh tokens."
              aria-invalid={errors.objective ? true : undefined}
              aria-describedby={describedBy('objective')}
              onChange={(event) => setObjective(event.target.value)}
            />
            {fieldError('objective')}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={fieldId('workspace')}>Workspace</Label>
            <Select value={workspace} onValueChange={setWorkspace}>
              <SelectTrigger
                id={fieldId('workspace')}
                className="w-full"
                aria-describedby={describedBy('workspacePath')}
                data-testid="session-workspace"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_WORKSPACE}>No workspace yet</SelectItem>
                <SelectItem value={FOLDER}>Folder…</SelectItem>
                {projects.map((item) => (
                  <SelectItem key={item.project.id} value={PROJECT_PREFIX + item.project.id}>
                    Project: {item.project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {workspace === FOLDER && (
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="bg-input/30 min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-xs"
                  data-testid="session-folder"
                  title={folderPath ?? undefined}
                >
                  {folderPath ?? 'No folder selected'}
                </span>
                <Button type="button" variant="outline" onClick={() => void chooseFolder()}>
                  <FolderOpen />
                  {folderPath ? 'Change…' : 'Choose…'}
                </Button>
              </div>
            )}
            <p className="text-muted-foreground text-xs">
              Associating a directory does not sandbox it. Access is checked before the session is
              prepared for execution.
            </p>
            {fieldError('workspacePath')}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={fieldId('profile')}>Execution profile</Label>
            <Select
              value={profile}
              onValueChange={(value) => setProfile(value as ExecutionProfile)}
            >
              <SelectTrigger
                id={fieldId('profile')}
                className="w-full"
                data-testid="session-profile"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXECUTION_PROFILE_DEFINITIONS.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              {selectedProfile?.description} Planning only; security policies are the same for every
              profile.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={fieldId('constraints')}>
              Constraints <span className="text-muted-foreground font-normal">(one per line)</span>
            </Label>
            <Textarea
              id={fieldId('constraints')}
              value={constraints}
              rows={3}
              placeholder="Do not change the public API"
              aria-invalid={errors.constraints ? true : undefined}
              aria-describedby={describedBy('constraints')}
              onChange={(event) => setConstraints(event.target.value)}
            />
            {fieldError('constraints')}
          </div>

          {formError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription data-testid="form-error">{formError}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : isEdit ? 'Save draft' : 'Create session'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function zodIssues(issues: { path: PropertyKey[]; message: string }[]) {
  return issues.map((issue) => ({ field: String(issue.path[0] ?? ''), message: issue.message }));
}
