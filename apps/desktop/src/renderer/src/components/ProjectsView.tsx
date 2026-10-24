import { Plus, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { useProjects } from '@/hooks/useProjects';
import type { Project } from '@/types';
import { EmptyState } from './EmptyState';
import { ProjectDetailsPanel } from './ProjectDetailsPanel';
import { ProjectFormDialog } from './ProjectFormDialog';
import { ProjectList } from './ProjectList';
import { RemoveProjectDialog } from './RemoveProjectDialog';

type DialogState =
  | { kind: 'add' }
  | { kind: 'edit'; project: Project }
  | { kind: 'remove'; project: Project }
  | null;

interface ProjectsViewProps {
  projects: ReturnType<typeof useProjects>;
  runningTerminals: (projectId: string) => number;
  onOpenTerminal: (projectId: string) => void;
  onNewSession: (projectId: string) => void;
  onOpenGit: (projectId: string) => void;
  onOpenContext: (projectId: string) => void;
  onOpenPreflight: (projectId: string) => void;
  /** Called after a project was removed (its terminals are gone too). */
  onProjectRemoved: () => void;
}

export function ProjectsView({
  projects,
  runningTerminals,
  onOpenTerminal,
  onNewSession,
  onOpenGit,
  onOpenContext,
  onOpenPreflight,
  onProjectRemoved,
}: ProjectsViewProps) {
  const { items, selected, selectedId, setSelectedId, loadError, reload, select } = projects;
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const closeDialog = () => setDialog(null);
  const message = notice ?? projects.selectError;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h1 className="text-lg font-semibold">Projects</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void reload()}
            aria-label="Refresh projects"
            title="Refresh"
          >
            <RefreshCw />
          </Button>
          {items && items.length > 0 && (
            <Button onClick={() => setDialog({ kind: 'add' })}>
              <Plus />
              Add project
            </Button>
          )}
        </div>
      </header>

      <p className="sr-only" role="status" aria-live="polite">
        {message ?? ''}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {message && (
          <Alert className="mb-4" data-testid="notice">
            <AlertDescription className="flex items-center justify-between gap-2">
              <span>{message}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Dismiss"
                onClick={() => {
                  setNotice(null);
                  projects.clearSelectError();
                }}
              >
                <X />
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {loadError && (
          <Alert variant="destructive" className="mb-4" role="alert">
            <AlertDescription className="flex items-center justify-between gap-2">
              <span>{loadError}</span>
              <Button variant="outline" size="sm" onClick={() => void reload()}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {items === null && !loadError && (
          <p className="text-muted-foreground" role="status">
            Loading projects…
          </p>
        )}

        {items && items.length === 0 && <EmptyState onAdd={() => setDialog({ kind: 'add' })} />}

        {items && items.length > 0 && (
          <div className="grid gap-6 lg:grid-cols-[minmax(260px,360px)_minmax(0,1fr)]">
            <ProjectList items={items} selectedId={selectedId} onSelect={select} />
            <div className="min-w-0">
              {selected ? (
                <ProjectDetailsPanel
                  details={selected}
                  onEdit={() => setDialog({ kind: 'edit', project: selected.project })}
                  onRemove={() => setDialog({ kind: 'remove', project: selected.project })}
                  onOpenTerminal={() => onOpenTerminal(selected.project.id)}
                  onNewSession={() => onNewSession(selected.project.id)}
                  onOpenGit={() => onOpenGit(selected.project.id)}
                  onOpenContext={() => onOpenContext(selected.project.id)}
                  onOpenPreflight={() => onOpenPreflight(selected.project.id)}
                />
              ) : (
                <p className="text-muted-foreground py-8 text-center">
                  Select a project to see its details.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {dialog?.kind === 'add' && (
        <ProjectFormDialog
          onClose={closeDialog}
          onSaved={(project) => {
            closeDialog();
            setNotice(`Project "${project.name}" registered.`);
            void select(project.id);
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <ProjectFormDialog
          project={dialog.project}
          onClose={closeDialog}
          onSaved={(project) => {
            closeDialog();
            setNotice(`Project "${project.name}" updated.`);
            void reload();
          }}
        />
      )}
      {dialog?.kind === 'remove' && (
        <RemoveProjectDialog
          project={dialog.project}
          runningTerminals={runningTerminals(dialog.project.id)}
          onClose={closeDialog}
          onRemoved={(id) => {
            closeDialog();
            if (selectedId === id) setSelectedId(null);
            setNotice(`Project "${dialog.project.name}" removed from the registry.`);
            void reload();
            onProjectRemoved();
          }}
        />
      )}
    </main>
  );
}
