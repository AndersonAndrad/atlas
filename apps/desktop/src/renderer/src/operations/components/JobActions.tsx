import type { BackgroundJob } from '@atlas/contracts';
import { FolderOpen, GitBranch, RotateCcw, ShieldCheck, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface JobActionHandlers {
  cancel: (job: BackgroundJob) => void;
  retry: (job: BackgroundJob) => void;
  openPreflightRun: (workspaceId: string, runId: string) => void;
  /** Opens the Git view's operations of a repository (a GIT job's operation). */
  openGitOperations: (repositoryRoot: string) => void;
  openProject: (projectId: string) => void;
}

/** Only what the job's executor supports in its current state (FR-1212). */
export function JobActions({
  job,
  handlers,
  compact = false,
}: {
  job: BackgroundJob;
  handlers: JobActionHandlers;
  compact?: boolean;
}) {
  const reference = job.executionReference;
  const size = compact ? 'xs' : 'sm';
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Actions for ${job.title}`}>
      {job.capabilities.cancel && (
        <Button size={size} variant="outline" onClick={() => handlers.cancel(job)}>
          <Square />
          Cancel
        </Button>
      )}
      {job.capabilities.retry && (
        <Button size={size} variant="outline" onClick={() => handlers.retry(job)}>
          <RotateCcw />
          Retry
        </Button>
      )}
      {reference?.type === 'preflight-run' && (
        <Button
          size={size}
          variant="ghost"
          onClick={() => handlers.openPreflightRun(reference.workspaceId, reference.runId)}
        >
          <ShieldCheck />
          Open result
        </Button>
      )}
      {reference?.type === 'git-operation' && (
        <Button
          size={size}
          variant="ghost"
          onClick={() => handlers.openGitOperations(reference.repositoryRoot)}
        >
          <GitBranch />
          Open in Git
        </Button>
      )}
      {!compact && job.projectId !== null && (
        <Button size={size} variant="ghost" onClick={() => handlers.openProject(job.projectId!)}>
          <FolderOpen />
          Open project
        </Button>
      )}
    </div>
  );
}
