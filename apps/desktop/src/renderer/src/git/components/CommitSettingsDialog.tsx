import type { GitCommitContext } from '@atlas/contracts';
import { useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CommitSettingsForm } from './CommitSettingsForm';

interface CommitSettingsDialogProps {
  repositoryRoot: string;
  onClose: () => void;
}

/** Commit checks of the project(s) in a repository, from the Git view. */
export function CommitSettingsDialog({ repositoryRoot, onClose }: CommitSettingsDialogProps) {
  const [context, setContext] = useState<GitCommitContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    unwrap(api().git.commitContext(repositoryRoot)).then(
      (value) => {
        if (cancelled) return;
        setContext(value);
        setProjectId(value.projects[0]?.id ?? null);
      },
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [repositoryRoot]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
        data-testid="commit-settings-dialog"
      >
        <DialogHeader>
          <DialogTitle>Commit checks</DialogTitle>
          <DialogDescription>
            Applied to every commit made from ATLAS in this project.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        {context !== null && context.projects.length === 0 && (
          <p className="text-muted-foreground text-sm">
            Commit checks are configured per registered project. Register this directory as a
            project to add them; until then Conventional Commits are enforced and no steps run.
          </p>
        )}
        {context !== null && context.projects.length > 1 && (
          <Select value={projectId ?? undefined} onValueChange={setProjectId}>
            <SelectTrigger aria-label="Project" className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {context.projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {projectId !== null && (
          <CommitSettingsForm
            key={projectId}
            projectId={projectId}
            settingsInvalid={
              context?.projects.find((project) => project.id === projectId)?.settingsInvalid ===
              true
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
