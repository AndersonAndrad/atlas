import { GitBranch } from 'lucide-react';
import { formatDate, gitSummary } from '@/format';
import { cn } from '@/lib/utils';
import type { ProjectDetails } from '@/types';
import { useProjectGitState } from '@/git/state/project-git-states';
import { ProjectGitBadge } from './git/ProjectGitBadge';
import { StatusBadge } from './StatusBadge';

interface ProjectListProps {
  items: ProjectDetails[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ProjectList({ items, selectedId, onSelect }: ProjectListProps) {
  return (
    <ul className="flex flex-col gap-2" aria-label="Registered projects">
      {items.map((item) => {
        const { project } = item;
        const selected = project.id === selectedId;
        return (
          <li key={project.id}>
            <button
              type="button"
              className={cn(
                'bg-card hover:bg-accent/60 focus-visible:ring-ring/50 flex w-full min-w-0 flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors outline-none focus-visible:ring-[3px]',
                selected && 'border-sidebar-primary bg-accent/60',
              )}
              aria-pressed={selected}
              onClick={() => onSelect(project.id)}
              data-testid="project-card"
              data-project-id={project.id}
            >
              <span className="flex min-w-0 items-center justify-between gap-2">
                <span className="truncate font-medium">{project.name}</span>
                <StatusBadge status={item.availability.status} />
              </span>
              {/* RTL container truncates from the start; the inner LTR span keeps path order. */}
              <span
                className="text-muted-foreground truncate font-mono text-xs [direction:rtl]"
                title={project.workspacePath}
              >
                <span dir="ltr">{project.workspacePath}</span>
              </span>
              <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1" data-testid="git-status">
                  <GitBranch className="size-3" aria-hidden="true" />
                  {gitSummary(item.git, project.git.isRepository)}
                </span>
                <ProjectCardGitBadge projectId={project.id} />
                <span>Opened: {formatDate(project.lastOpenedAt)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Stored Git status of a project card; never runs Git (SDD-024). */
function ProjectCardGitBadge({ projectId }: { projectId: string }) {
  return <ProjectGitBadge state={useProjectGitState(projectId)} focusable={false} />;
}
