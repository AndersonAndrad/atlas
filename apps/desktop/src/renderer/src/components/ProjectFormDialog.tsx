import {
  CreateProjectInputSchema,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  UpdateProjectInputSchema,
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
import { Textarea } from '@/components/ui/textarea';
import { AVAILABILITY_LABELS, gitSummary, parseTags } from '@/format';
import { cn } from '@/lib/utils';
import type { Project, ProjectPathInspection } from '@/types';

type FieldErrors = Partial<Record<'name' | 'description' | 'tags' | 'workspacePath', string>>;

interface ProjectFormDialogProps {
  /** When provided the dialog edits this project; otherwise it registers a new one. */
  project?: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}

function toFieldErrors(issues: { field: string; message: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const field = issue.field.split('.')[0] as keyof FieldErrors;
    if (['name', 'description', 'tags', 'workspacePath'].includes(field) && !errors[field]) {
      errors[field] = issue.message;
    }
  }
  return errors;
}

export function ProjectFormDialog({ project, onClose, onSaved }: ProjectFormDialogProps) {
  const isEdit = project !== undefined;
  const formId = useId();
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [tags, setTags] = useState(project?.tags.join(', ') ?? '');
  const [inspection, setInspection] = useState<ProjectPathInspection | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const directoryUnavailable =
    inspection !== null && inspection.availability.status !== 'available';
  const displayedPath = inspection
    ? (inspection.resolvedPath ?? inspection.inputPath)
    : project?.workspacePath;

  async function chooseDirectory() {
    setFormError(null);
    setBusy(true);
    try {
      const choice = await unwrap(api().dialog.chooseDirectory());
      if (choice.canceled || !choice.inspection) return;
      const picked = choice.inspection;
      setInspection(picked);
      setErrors((current) => ({ ...current, workspacePath: undefined }));
      if (!isEdit && name.trim() === '' && picked.suggestedName) {
        setName(picked.suggestedName);
      }
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const base = { name, description, tags: parseTags(tags) };
    let request;
    if (isEdit) {
      const input = {
        ...base,
        description: description.trim() === '' ? null : description,
        ...(inspection ? { workspacePath: inspection.inputPath } : {}),
      };
      const parsed = UpdateProjectInputSchema.safeParse(input);
      if (!parsed.success) {
        setErrors(
          toFieldErrors(
            parsed.error.issues.map((i) => ({
              field: String(i.path[0] ?? ''),
              message: i.message,
            })),
          ),
        );
        return;
      }
      request = () => api().projects.update(project.id, input);
    } else {
      if (!inspection) {
        setErrors({ workspacePath: 'Choose a directory.' });
        return;
      }
      const input = {
        ...base,
        description: description.trim() === '' ? undefined : description,
        workspacePath: inspection.inputPath,
      };
      const parsed = CreateProjectInputSchema.safeParse(input);
      if (!parsed.success) {
        setErrors(
          toFieldErrors(
            parsed.error.issues.map((i) => ({
              field: String(i.path[0] ?? ''),
              message: i.message,
            })),
          ),
        );
        return;
      }
      request = () => api().projects.create(input);
    }

    setErrors({});
    setBusy(true);
    try {
      const saved = await unwrap(request());
      onSaved(saved);
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
  const errorId = (field: string) => `${formId}-${field}-error`;
  const describedBy = (field: keyof FieldErrors) => (errors[field] ? errorId(field) : undefined);
  const fieldError = (field: keyof FieldErrors) =>
    errors[field] && (
      <p id={errorId(field)} className="text-destructive text-xs">
        {errors[field]}
      </p>
    );

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        data-testid="project-form-dialog"
        className="sm:max-w-lg"
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit project' : 'Add project'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update the project metadata or its directory.'
              : 'Register a local directory. Its files are never modified.'}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium" id={fieldId('directory-label')}>
              Directory
            </span>
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'bg-input/30 min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-xs',
                  !displayedPath && 'text-muted-foreground',
                )}
                aria-labelledby={fieldId('directory-label')}
                data-testid="selected-directory"
                title={displayedPath}
              >
                {displayedPath ?? 'No directory selected'}
              </span>
              <Button
                type="button"
                variant="outline"
                onClick={chooseDirectory}
                disabled={busy}
                aria-describedby={describedBy('workspacePath')}
              >
                <FolderOpen />
                {displayedPath ? 'Change…' : 'Choose…'}
              </Button>
            </div>
            {inspection && (
              <p
                className={cn(
                  'text-xs',
                  directoryUnavailable ? 'text-destructive' : 'text-muted-foreground',
                )}
                role="status"
                data-testid="directory-inspection"
              >
                {directoryUnavailable
                  ? AVAILABILITY_LABELS[inspection.availability.status]
                  : `Git: ${gitSummary(inspection.git, false)}`}
              </p>
            )}
            {fieldError('workspacePath')}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={fieldId('name')}>Name</Label>
            <Input
              id={fieldId('name')}
              value={name}
              maxLength={PROJECT_NAME_MAX_LENGTH}
              autoComplete="off"
              required
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={describedBy('name')}
              onChange={(event) => setName(event.target.value)}
            />
            {fieldError('name')}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={fieldId('description')}>
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea
              id={fieldId('description')}
              value={description}
              rows={3}
              maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
              aria-invalid={errors.description ? true : undefined}
              aria-describedby={describedBy('description')}
              onChange={(event) => setDescription(event.target.value)}
            />
            {fieldError('description')}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={fieldId('tags')}>
              Tags{' '}
              <span className="text-muted-foreground font-normal">(optional, comma-separated)</span>
            </Label>
            <Input
              id={fieldId('tags')}
              value={tags}
              autoComplete="off"
              placeholder="frontend, client-a"
              aria-invalid={errors.tags ? true : undefined}
              aria-describedby={describedBy('tags')}
              onChange={(event) => setTags(event.target.value)}
            />
            {fieldError('tags')}
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
            <Button type="submit" disabled={busy || directoryUnavailable}>
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
