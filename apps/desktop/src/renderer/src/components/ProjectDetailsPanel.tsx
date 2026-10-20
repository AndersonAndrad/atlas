import type { ProjectDetails } from '../types';
import { AVAILABILITY_LABELS, formatDate, gitSummary } from '../format';
import { StatusBadge } from './StatusBadge';

interface ProjectDetailsPanelProps {
  details: ProjectDetails;
  onEdit: () => void;
  onRemove: () => void;
}

export function ProjectDetailsPanel({ details, onEdit, onRemove }: ProjectDetailsPanelProps) {
  const { project, availability, git } = details;
  const unavailable = availability.status !== 'available';

  return (
    <section className="details" aria-labelledby="details-title" data-testid="project-details">
      <header className="details__header">
        <div className="details__title-row">
          <h2 id="details-title" className="details__title">
            {project.name}
          </h2>
          <StatusBadge status={availability.status} />
        </div>
        <div className="details__actions">
          <button type="button" className="button" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="button button--danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </header>

      {unavailable && (
        <div className="callout callout--warn" role="status" data-testid="unavailable-callout">
          <p>
            <strong>{AVAILABILITY_LABELS[availability.status]}.</strong> The project is still
            registered. If it was moved, update its directory.
          </p>
          <button type="button" className="button" onClick={onEdit}>
            Update directory
          </button>
        </div>
      )}

      {project.description && <p className="details__description">{project.description}</p>}

      <dl className="details__grid">
        <dt>Directory</dt>
        <dd className="mono" data-testid="details-path">
          {project.workspacePath}
        </dd>

        <dt>Git</dt>
        <dd data-testid="details-git">{gitSummary(git, project.git.isRepository)}</dd>

        {(git.repositoryRoot ?? project.git.repositoryRoot) && (
          <>
            <dt>Repository root</dt>
            <dd className="mono">{git.repositoryRoot ?? project.git.repositoryRoot}</dd>
          </>
        )}

        <dt>Tags</dt>
        <dd>
          {project.tags.length > 0 ? (
            <ul className="tags" aria-label="Tags">
              {project.tags.map((tag) => (
                <li key={tag} className="tag">
                  {tag}
                </li>
              ))}
            </ul>
          ) : (
            <span className="muted">None</span>
          )}
        </dd>

        <dt>Last opened</dt>
        <dd>{formatDate(project.lastOpenedAt)}</dd>

        <dt>Registered</dt>
        <dd>{formatDate(project.createdAt)}</dd>

        <dt>Updated</dt>
        <dd>{formatDate(project.updatedAt)}</dd>

        <dt>Status checked</dt>
        <dd>{formatDate(availability.checkedAt)}</dd>
      </dl>
    </section>
  );
}
