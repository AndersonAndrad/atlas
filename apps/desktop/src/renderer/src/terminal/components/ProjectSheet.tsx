import { PROJECT_NAME_MAX_LENGTH, type TerminalProjectContext } from '@atlas/contracts';
import { FolderPlus, Link2, SquareTerminal } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { ProjectDetailsPanel } from '@/components/ProjectDetailsPanel';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { ProjectDetails } from '@/types';

export type ProjectSheetRequest =
  { kind: 'project'; projectId: string } | { kind: 'terminal'; sessionId: string };

interface ProjectSheetProps {
  request: ProjectSheetRequest;
  projects: ProjectDetails[];
  onOpenTerminal: (projectId: string) => void;
  /** A project was registered or associated; lists must reload. */
  onChanged: () => void;
  onClose: () => void;
}

/**
 * Project details next to the terminals, without leaving or interrupting them.
 * From a terminal it shows its project, a project matching its directory, or
 * offers to register the directory.
 */
export function ProjectSheet({
  request,
  projects,
  onOpenTerminal,
  onChanged,
  onClose,
}: ProjectSheetProps) {
  const [context, setContext] = useState<TerminalProjectContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (request.kind !== 'terminal') return;
    let cancelled = false;
    unwrap(api().terminals.projectContext(request.sessionId)).then(
      (value) => !cancelled && setContext(value),
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [request]);

  const projectId =
    request.kind === 'project' ? request.projectId : (context?.associatedProjectId ?? null);
  const details = projects.find((item) => item.project.id === projectId);
  const matched =
    request.kind === 'terminal' &&
    context &&
    context.associatedProjectId === null &&
    context.matchedProjectId
      ? projects.find((item) => item.project.id === context.matchedProjectId)
      : undefined;

  async function associate(target: string) {
    if (request.kind !== 'terminal') return;
    try {
      await unwrap(api().terminals.associate(request.sessionId, target));
      setContext((current) => (current ? { ...current, associatedProjectId: target } : current));
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl" data-testid="project-sheet">
        <SheetHeader>
          <SheetTitle>Project</SheetTitle>
          <SheetDescription>
            {request.kind === 'terminal' && context
              ? `${context.directory}${context.cwdSource === 'initial' ? ' (initial directory)' : ''}`
              : 'Project details'}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {details ? (
            <>
              <ProjectDetailsPanel details={details} />
              {request.kind === 'project' && (
                <Button
                  className="self-start"
                  disabled={details.availability.status !== 'available'}
                  onClick={() => onOpenTerminal(details.project.id)}
                >
                  <SquareTerminal />
                  New terminal in project
                </Button>
              )}
            </>
          ) : matched ? (
            <div className="flex flex-col gap-3" data-testid="project-match">
              <p className="text-sm">
                This terminal is inside <strong>{matched.project.name}</strong> but not associated
                with it.
              </p>
              <Button className="self-start" onClick={() => void associate(matched.project.id)}>
                <Link2 />
                Associate with {matched.project.name}
              </Button>
              <ProjectDetailsPanel details={matched} />
            </div>
          ) : request.kind === 'terminal' && context ? (
            <RegisterDirectory
              sessionId={request.sessionId}
              directory={context.directory}
              onRegistered={(id) => {
                setContext((current) =>
                  current ? { ...current, associatedProjectId: id } : current,
                );
                onChanged();
              }}
            />
          ) : (
            !error && <p className="text-muted-foreground text-sm">Loading…</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RegisterDirectory({
  sessionId,
  directory,
  onRegistered,
}: {
  sessionId: string;
  directory: string;
  onRegistered: (projectId: string) => void;
}) {
  const fieldId = useId();
  const [name, setName] = useState(directory.split(/[\\/]/).filter(Boolean).pop() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === '') {
      setError('Name is required.');
      return;
    }
    setBusy(true);
    try {
      const result = await unwrap(
        api().terminals.registerProject(sessionId, { name: name.trim() }),
      );
      onRegistered(result.project.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={submit}
      noValidate
      data-testid="register-directory"
    >
      <p className="text-sm">This terminal is not associated with a project.</p>
      <div className="flex flex-col gap-2">
        <Label htmlFor={fieldId}>Register this directory as a project</Label>
        <Input
          id={fieldId}
          value={name}
          maxLength={PROJECT_NAME_MAX_LENGTH}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
        {error && <p className="text-destructive text-xs">{error}</p>}
      </div>
      <Button type="submit" className="self-start" disabled={busy}>
        <FolderPlus />
        Register project
      </Button>
    </form>
  );
}
