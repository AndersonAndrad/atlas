import type { ProjectDetails } from '../types';
import { formatDate, gitSummary } from '../format';
import { Icon } from './Icon';
import { StatusBadge } from './StatusBadge';

interface ProjectListProps {
  items: ProjectDetails[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ProjectList({ items, selectedId, onSelect }: ProjectListProps) {
  return (
    <ul className="project-list" aria-label="Registered projects">
      {items.map((item) => {
        const { project } = item;
        const selected = project.id === selectedId;
        return (
          <li key={project.id}>
            <button
              type="button"
              className={`project-card${selected ? ' project-card--selected' : ''}`}
              aria-pressed={selected}
              onClick={() => onSelect(project.id)}
              data-testid="project-card"
              data-project-id={project.id}
            >
              <span className="project-card__header">
                <span className="project-card__name">{project.name}</span>
                <StatusBadge status={item.availability.status} />
              </span>
              {/* RTL container truncates from the start; the inner LTR span keeps path order. */}
              <span className="project-card__path" title={project.workspacePath}>
                <span dir="ltr">{project.workspacePath}</span>
              </span>
              <span className="project-card__meta">
                <span className="meta" data-testid="git-status">
                  <Icon name="branch" size={13} />
                  {gitSummary(item.git, project.git.isRepository)}
                </span>
                <span className="meta">Opened: {formatDate(project.lastOpenedAt)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
