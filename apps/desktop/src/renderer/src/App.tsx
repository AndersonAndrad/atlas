import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from './api';
import { EmptyState } from './components/EmptyState';
import { Icon } from './components/Icon';
import { ProjectDetailsPanel } from './components/ProjectDetailsPanel';
import { ProjectFormDialog } from './components/ProjectFormDialog';
import { ProjectList } from './components/ProjectList';
import { RemoveProjectDialog } from './components/RemoveProjectDialog';
import { Sidebar } from './components/Sidebar';
import type { Project, ProjectDetails } from './types';

type DialogState =
  | { kind: 'add' }
  | { kind: 'edit'; project: Project }
  | { kind: 'remove'; project: Project }
  | null;

export function App() {
  const [items, setItems] = useState<ProjectDetails[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const reload = useCallback(async () => {
    try {
      const list = await unwrap(api().projects.list());
      setItems(list);
      setLoadError(null);
      return list;
    } catch (error) {
      setLoadError(errorMessage(error));
      return null;
    }
  }, []);

  // Initial load: restore the previously selected project (FR-008).
  useEffect(() => {
    void (async () => {
      const [list, selected] = await Promise.all([
        reload(),
        unwrap(api().projects.getSelected()).catch(() => null),
      ]);
      if (list && selected) setSelectedId(selected.project.id);
    })();
  }, [reload]);

  // Pick up changes made from the CLI while the window was in the background.
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  const select = useCallback(
    async (id: string) => {
      setSelectedId(id);
      try {
        await unwrap(api().projects.select(id));
        await reload();
      } catch (error) {
        setNotice(errorMessage(error));
      }
    },
    [reload],
  );

  const selected = items?.find((item) => item.project.id === selectedId) ?? null;
  const closeDialog = () => setDialog(null);

  return (
    <div className="app">
      <Sidebar />
      <main className="workspace">
        <header className="toolbar">
          <h1 className="toolbar__title">Projects</h1>
          <div className="toolbar__actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => void reload()}
              aria-label="Refresh projects"
              title="Refresh"
            >
              <Icon name="refresh" />
            </button>
            {items && items.length > 0 && (
              <button
                type="button"
                className="button button--primary"
                onClick={() => setDialog({ kind: 'add' })}
              >
                <Icon name="plus" />
                Add project
              </button>
            )}
          </div>
        </header>

        <p className="sr-only" role="status" aria-live="polite">
          {notice ?? ''}
        </p>
        {notice && (
          <div className="callout callout--info notice" data-testid="notice">
            <span>{notice}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
            >
              <Icon name="close" />
            </button>
          </div>
        )}

        {loadError && (
          <div className="callout callout--error" role="alert">
            <span>{loadError}</span>
            <button type="button" className="button" onClick={() => void reload()}>
              Retry
            </button>
          </div>
        )}

        {items === null && !loadError && (
          <p className="muted loading" role="status">
            Loading projects…
          </p>
        )}

        {items && items.length === 0 && <EmptyState onAdd={() => setDialog({ kind: 'add' })} />}

        {items && items.length > 0 && (
          <div className="panels">
            <div className="panels__list">
              <ProjectList items={items} selectedId={selectedId} onSelect={select} />
            </div>
            <div className="panels__details">
              {selected ? (
                <ProjectDetailsPanel
                  details={selected}
                  onEdit={() => setDialog({ kind: 'edit', project: selected.project })}
                  onRemove={() => setDialog({ kind: 'remove', project: selected.project })}
                />
              ) : (
                <p className="muted details-placeholder">Select a project to see its details.</p>
              )}
            </div>
          </div>
        )}
      </main>

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
          onClose={closeDialog}
          onRemoved={(id) => {
            closeDialog();
            if (selectedId === id) setSelectedId(null);
            setNotice(`Project "${dialog.project.name}" removed from the registry.`);
            void reload();
          }}
        />
      )}
    </div>
  );
}
