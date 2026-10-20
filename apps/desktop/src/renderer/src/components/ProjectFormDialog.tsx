import {
  CreateProjectInputSchema,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  UpdateProjectInputSchema,
} from '@atlas/contracts';
import { useId, useState, type FormEvent } from 'react';
import { ApiError, api, errorMessage, unwrap } from '../api';
import { AVAILABILITY_LABELS, gitSummary, parseTags } from '../format';
import type { Project, ProjectPathInspection } from '../types';
import { Icon } from './Icon';
import { Modal } from './Modal';

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

  return (
    <Modal
      title={isEdit ? 'Edit project' : 'Add project'}
      onClose={onClose}
      busy={busy}
      testId="project-form-dialog"
    >
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <span className="field__label" id={fieldId('directory-label')}>
            Directory
          </span>
          <div className="directory-picker">
            <span
              className={`directory-picker__path mono${displayedPath ? '' : ' muted'}`}
              aria-labelledby={fieldId('directory-label')}
              data-testid="selected-directory"
            >
              {displayedPath ?? 'No directory selected'}
            </span>
            <button
              type="button"
              className="button"
              onClick={chooseDirectory}
              disabled={busy}
              aria-describedby={describedBy('workspacePath')}
            >
              <Icon name="folder" />
              {displayedPath ? 'Change…' : 'Choose…'}
            </button>
          </div>
          {inspection && (
            <p
              className={`field__hint${directoryUnavailable ? ' field__hint--error' : ''}`}
              role="status"
              data-testid="directory-inspection"
            >
              {directoryUnavailable
                ? AVAILABILITY_LABELS[inspection.availability.status]
                : `Git: ${gitSummary(inspection.git, false)}`}
            </p>
          )}
          {errors.workspacePath && (
            <p id={errorId('workspacePath')} className="field__error">
              {errors.workspacePath}
            </p>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={fieldId('name')}>
            Name
          </label>
          <input
            id={fieldId('name')}
            className="input"
            value={name}
            maxLength={PROJECT_NAME_MAX_LENGTH}
            autoComplete="off"
            required
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={describedBy('name')}
            onChange={(event) => setName(event.target.value)}
          />
          {errors.name && (
            <p id={errorId('name')} className="field__error">
              {errors.name}
            </p>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={fieldId('description')}>
            Description <span className="muted">(optional)</span>
          </label>
          <textarea
            id={fieldId('description')}
            className="input input--textarea"
            value={description}
            rows={3}
            maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={describedBy('description')}
            onChange={(event) => setDescription(event.target.value)}
          />
          {errors.description && (
            <p id={errorId('description')} className="field__error">
              {errors.description}
            </p>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor={fieldId('tags')}>
            Tags <span className="muted">(optional, comma-separated)</span>
          </label>
          <input
            id={fieldId('tags')}
            className="input"
            value={tags}
            autoComplete="off"
            placeholder="frontend, client-a"
            aria-invalid={errors.tags ? true : undefined}
            aria-describedby={describedBy('tags')}
            onChange={(event) => setTags(event.target.value)}
          />
          {errors.tags && (
            <p id={errorId('tags')} className="field__error">
              {errors.tags}
            </p>
          )}
        </div>

        {formError && (
          <p className="callout callout--error" role="alert" data-testid="form-error">
            {formError}
          </p>
        )}

        <footer className="modal__footer">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={busy || directoryUnavailable}
          >
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add project'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
