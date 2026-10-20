import { Database, GitBranch, ListChecks, SquareTerminal, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AVAILABILITY_LABELS, formatDate, gitSummary } from '@/format';
import type { ProjectDetails } from '@/types';
import { useProjectGit } from '@/terminal/hooks/useGitStatus';
import { CommitSettingsForm } from '@/git/components/CommitSettingsForm';
import { ProjectAiSettings } from '@/context/components/ProjectAiSettings';
import { ActionDot } from './git/ActionDot';
import { GitDetails } from './git/GitDetails';
import { pendingGitActions } from './git/git-format';
import { StatusBadge } from './StatusBadge';

interface ProjectDetailsPanelProps {
  details: ProjectDetails;
  /** Actions are hidden when not provided (e.g. in the quick view from a terminal). */
  onEdit?: () => void;
  onRemove?: () => void;
  onOpenTerminal?: () => void;
  onNewSession?: () => void;
  /** Opens the Git view on the project's repository. */
  onOpenGit?: () => void;
  /** Opens the project's shared context. */
  onOpenContext?: () => void;
}

export function ProjectDetailsPanel({
  details,
  onEdit,
  onRemove,
  onOpenTerminal,
  onNewSession,
  onOpenGit,
  onOpenContext,
}: ProjectDetailsPanelProps) {
  const { project, availability, git } = details;
  const unavailable = availability.status !== 'available';
  const repositoryRoot = git.repositoryRoot ?? project.git.repositoryRoot;
  const projectGit = useProjectGit(project.id);
  const pendingActions =
    projectGit.status?.state === 'repository' ? pendingGitActions(projectGit.status.snapshot) : [];

  return (
    <section
      className="flex min-w-0 flex-col gap-4"
      aria-labelledby="details-title"
      data-testid="project-details"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 id="details-title" className="truncate text-xl font-semibold">
            {project.name}
          </h2>
          <StatusBadge status={availability.status} />
        </div>
        <div className="flex flex-wrap gap-2">
          {onOpenTerminal && (
            <Button variant="secondary" onClick={onOpenTerminal} disabled={unavailable}>
              <SquareTerminal />
              Open terminal
            </Button>
          )}
          {onOpenGit && projectGit.status?.state === 'repository' && (
            <Button
              variant="secondary"
              className="relative"
              onClick={onOpenGit}
              disabled={unavailable}
              title={pendingActions.join(' · ') || 'Git'}
            >
              <GitBranch />
              Git
              <ActionDot reasons={pendingActions} />
            </Button>
          )}
          {onOpenContext && (
            <Button variant="secondary" onClick={onOpenContext}>
              <Database />
              Context
            </Button>
          )}
          {onNewSession && (
            <Button variant="secondary" onClick={onNewSession}>
              <ListChecks />
              New session
            </Button>
          )}
          {onEdit && (
            <Button variant="outline" onClick={onEdit}>
              Edit
            </Button>
          )}
          {onRemove && (
            <Button variant="destructive" onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>
      </header>

      {unavailable && (
        <Alert role="status" data-testid="unavailable-callout" className="border-warning/40">
          <TriangleAlert className="text-warning" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <p>
              <strong>{AVAILABILITY_LABELS[availability.status]}.</strong> The project is still
              registered. If it was moved, update its directory.
            </p>
            {onEdit && (
              <Button variant="outline" size="sm" onClick={onEdit}>
                Update directory
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {project.description && (
        <p className="text-muted-foreground break-words whitespace-pre-wrap">
          {project.description}
        </p>
      )}

      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-sm">
        <dt className="text-muted-foreground">Directory</dt>
        <dd className="font-mono text-xs break-all" data-testid="details-path">
          {project.workspacePath}
        </dd>

        <dt className="text-muted-foreground">Git</dt>
        <dd data-testid="details-git">{gitSummary(git, project.git.isRepository)}</dd>

        {repositoryRoot && (
          <>
            <dt className="text-muted-foreground">Repository root</dt>
            <dd className="font-mono text-xs break-all">{repositoryRoot}</dd>
          </>
        )}

        <dt className="text-muted-foreground">Tags</dt>
        <dd>
          {project.tags.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
              {project.tags.map((tag) => (
                <li key={tag}>
                  <Badge variant="secondary">{tag}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </dd>

        <dt className="text-muted-foreground">Last opened</dt>
        <dd>{formatDate(project.lastOpenedAt)}</dd>

        <dt className="text-muted-foreground">Registered</dt>
        <dd>{formatDate(project.createdAt)}</dd>

        <dt className="text-muted-foreground">Updated</dt>
        <dd>{formatDate(project.updatedAt)}</dd>

        <dt className="text-muted-foreground">Status checked</dt>
        <dd>{formatDate(availability.checkedAt)}</dd>
      </dl>

      <GitDetails
        status={projectGit.status}
        loading={projectGit.loading}
        onRefresh={projectGit.refresh}
      />

      {onEdit && projectGit.status?.state === 'repository' && (
        <section
          className="flex flex-col gap-3 rounded-lg border p-4"
          aria-labelledby="commit-checks-title"
        >
          <h3 id="commit-checks-title" className="font-semibold">
            Commit checks
          </h3>
          <CommitSettingsForm key={project.id} projectId={project.id} />
        </section>
      )}

      {onEdit && (
        <section
          className="flex flex-col gap-3 rounded-lg border p-4"
          aria-labelledby="ai-context-title"
        >
          <h3 id="ai-context-title" className="font-semibold">
            AI &amp; context
          </h3>
          <ProjectAiSettings key={project.id} projectId={project.id} />
        </section>
      )}
    </section>
  );
}
