import type {
  HttpCollection,
  HttpExecutionResult,
  HttpFolder,
  HttpHistoryEntry,
  HttpRequestSummary,
} from '@atlas/contracts';
import { emptyHttpRequestDefinition, httpParamsFromUrl } from '@atlas/contracts';
import { Copy, Library, PanelLeft, Plus, Save, Send, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { ProjectDetails } from '@/types';
import { methodClass } from '../format';
import { isDirty, useWorkbench, type RequestTab } from '../useWorkbench';
import { CollectionsPanel, type CollectionActions } from './CollectionsPanel';
import { HistoryPanel } from './HistoryPanel';
import { RequestEditor } from './RequestEditor';
import { ResponseViewer } from './ResponseViewer';
import { SnapshotsDialog } from './SnapshotsDialog';
import {
  CollectionDialog,
  ConfirmDialog,
  NameDialog,
  SaveRequestDialog,
  type Confirmation,
} from './WorkbenchDialogs';

type NamePrompt = {
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  testId: string;
  description?: string;
  warning?: string;
  run: (name: string) => Promise<void>;
};

type PlaceDialog = { mode: 'save'; tabKey: string } | { mode: 'move'; request: HttpRequestSummary };

/** Requests in folders below `folder`, including its own. */
function requestsUnder(collection: HttpCollection, folder: HttpFolder): string[] {
  const folders = new Set([folder.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of collection.folders) {
      if (candidate.parentId && folders.has(candidate.parentId) && !folders.has(candidate.id)) {
        folders.add(candidate.id);
        grew = true;
      }
    }
  }
  return collection.requests.filter((r) => r.folderId && folders.has(r.folderId)).map((r) => r.id);
}

interface ApiWorkbenchViewProps {
  visible: boolean;
  projects: ProjectDetails[];
  /** The project in view: its collections and the global ones are listed (FR-1417). */
  projectId: string | null;
}

/**
 * The API Workbench (SDD-014 Milestone A): requests run in the Engine, collections live in
 * SQLite, and secret values stay in this window only.
 */
export function ApiWorkbenchView({ visible, projects, projectId }: ApiWorkbenchViewProps) {
  const workbench = useWorkbench(projectId);
  const {
    collections,
    tabs,
    activeTab,
    activeKey,
    setActiveKey,
    updateTab,
    reloadCollections,
    forgetSaved,
  } = workbench;
  const [leftTab, setLeftTab] = useState<'collections' | 'history'>('collections');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [recentUrls, setRecentUrls] = useState<string[]>([]);
  const [collectionDialog, setCollectionDialog] = useState<{
    collection: HttpCollection | null;
  } | null>(null);
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null);
  const [placeDialog, setPlaceDialog] = useState<PlaceDialog | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [snapshotsFor, setSnapshotsFor] = useState<{ requestId: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const projectNames = useMemo(
    () => new Map(projects.map(({ project }) => [project.id, project.name])),
    [projects],
  );
  const allCollections = useMemo(() => collections ?? [], [collections]);

  useEffect(() => {
    void unwrap(api().http.recentUrls()).then(setRecentUrls, () => undefined);
  }, [workbench.historyVersion]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setNotice(errorMessage(caught));
    }
  }, []);

  const saveActive = useCallback(
    (tab: RequestTab) => {
      if (tab.requestId !== null && tab.collectionId !== null) {
        void run(() => workbench.save(tab.key));
      } else {
        setPlaceDialog({ mode: 'save', tabKey: tab.key });
      }
    },
    [run, workbench],
  );

  const closeTab = (tab: RequestTab) => {
    if (!isDirty(tab)) {
      workbench.closeTab(tab.key);
      return;
    }
    setConfirmation({
      title: `Close ${tab.name}?`,
      description: 'Its unsaved changes will be lost.',
      confirmLabel: 'Discard changes',
      run: () => workbench.closeTab(tab.key),
    });
  };

  const actions: CollectionActions = {
    openRequest: (request) => void run(() => workbench.openRequest(request.id)),
    newRequest: (collectionId, folderId) => workbench.newRequest(collectionId, folderId),
    newFolder: (collectionId, parentId) =>
      setNamePrompt({
        title: 'New folder',
        label: 'Name',
        initial: '',
        submitLabel: 'Create folder',
        testId: 'folder-dialog',
        run: async (name) => {
          await unwrap(api().http.createFolder({ collectionId, parentId, name }));
          await reloadCollections();
        },
      }),
    editCollection: (collection) => setCollectionDialog({ collection }),
    duplicateCollection: (collection) =>
      void run(async () => {
        await unwrap(api().http.duplicateCollection(collection.id));
        await reloadCollections();
      }),
    deleteCollection: (collection) =>
      setConfirmation({
        title: `Delete ${collection.name}?`,
        description: `Its ${collection.requests.length} requests, folders and saved responses links are deleted. This cannot be undone.`,
        confirmLabel: 'Delete collection',
        run: () =>
          run(async () => {
            await unwrap(api().http.deleteCollection(collection.id));
            forgetSaved((tab) => tab.collectionId === collection.id);
            await reloadCollections();
          }),
      }),
    renameFolder: (folder) =>
      setNamePrompt({
        title: 'Rename folder',
        label: 'Name',
        initial: folder.name,
        submitLabel: 'Rename',
        testId: 'folder-dialog',
        run: async (name) => {
          await unwrap(api().http.renameFolder({ id: folder.id, name }));
          await reloadCollections();
        },
      }),
    deleteFolder: (folder) => {
      const collection = allCollections.find((c) => c.id === folder.collectionId);
      const removed = new Set(collection ? requestsUnder(collection, folder) : []);
      setConfirmation({
        title: `Delete ${folder.name}?`,
        description: `Its subfolders and ${removed.size} requests are deleted. This cannot be undone.`,
        confirmLabel: 'Delete folder',
        run: () =>
          run(async () => {
            await unwrap(api().http.deleteFolder(folder.id));
            forgetSaved((tab) => tab.requestId !== null && removed.has(tab.requestId));
            await reloadCollections();
          }),
      });
    },
    duplicateRequest: (request) =>
      void run(async () => {
        const copy = await unwrap(api().http.duplicateRequest(request.id));
        await reloadCollections();
        await workbench.openRequest(copy.id);
      }),
    moveRequest: (request) => setPlaceDialog({ mode: 'move', request }),
    deleteRequest: (request) =>
      setConfirmation({
        title: `Delete ${request.name}?`,
        description: 'The request is deleted. Its history entries and saved responses are kept.',
        confirmLabel: 'Delete request',
        run: () =>
          run(async () => {
            await unwrap(api().http.deleteRequest(request.id));
            forgetSaved((tab) => tab.requestId === request.id);
            await reloadCollections();
          }),
      }),
  };

  /** A saved request opens itself; any other entry opens as a new, unsaved request. */
  const openHistoryEntry = (entry: HttpHistoryEntry) => {
    const { requestId } = entry;
    if (requestId !== null) {
      void run(() => workbench.openRequest(requestId));
      return;
    }
    workbench.newRequest(null, null, {
      name: `${entry.method} ${entry.url}`.slice(0, 120),
      definition: {
        ...emptyHttpRequestDefinition(),
        method: entry.method,
        url: entry.url,
        params: httpParamsFromUrl(entry.url, []),
      },
    });
  };

  const saveSnapshot = (tab: RequestTab, result: HttpExecutionResult) =>
    setNamePrompt({
      title: 'Save response',
      label: 'Name',
      initial: `${tab.name} ${result.status}`.slice(0, 120),
      submitLabel: 'Save response',
      testId: 'snapshot-dialog',
      warning:
        'The body is stored on this computer and may contain personal or sensitive data. Credential headers and cookies are not stored.',
      run: async (name) => {
        await unwrap(
          api().http.saveSnapshot({
            executionId: result.executionId,
            requestId: tab.requestId,
            name,
          }),
        );
        setNotice('Response saved.');
      },
    });

  const placeTab =
    placeDialog?.mode === 'save' ? tabs.find((t) => t.key === placeDialog.tabKey) : undefined;

  return (
    <section
      className={cn('flex h-full min-h-0 flex-col', !visible && 'hidden')}
      aria-label="API Workbench"
      data-testid="api-workbench"
      onKeyDown={(event) => {
        if (event.key === 's' && (event.metaKey || event.ctrlKey) && activeTab) {
          event.preventDefault();
          saveActive(activeTab);
        }
      }}
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button
          size="icon-sm"
          variant="ghost"
          className="md:hidden"
          aria-label="Show collections"
          aria-pressed={sidebarOpen}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <PanelLeft />
        </Button>
        <h1 className="text-lg font-semibold">API Workbench</h1>
        <span className="text-muted-foreground truncate text-sm">
          {projectId ? (projectNames.get(projectId) ?? 'Project') : 'No project selected'}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCollectionDialog({ collection: null })}
          >
            <Library /> New collection
          </Button>
          <Button size="sm" onClick={() => workbench.newRequest(null, null)}>
            <Plus /> New request
          </Button>
        </div>
      </header>
      {notice && (
        <div
          className="bg-muted flex items-center gap-2 px-4 py-1.5 text-sm"
          role="status"
          data-testid="workbench-notice"
        >
          <span className="flex-1">{notice}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
          >
            <X />
          </Button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <aside
          className={cn(
            'bg-background flex w-72 shrink-0 flex-col gap-2 border-r p-3',
            'absolute inset-y-0 left-0 z-20 md:static',
            sidebarOpen ? 'flex' : 'hidden md:flex',
          )}
        >
          <Tabs
            value={leftTab}
            onValueChange={(value) => setLeftTab(value as typeof leftTab)}
            className="min-h-0 flex-1"
          >
            <TabsList className="w-full">
              <TabsTrigger value="collections">Collections</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="collections" className="flex min-h-0 flex-col">
              <CollectionsPanel
                collections={collections}
                error={workbench.collectionsError}
                scope={workbench.scope}
                onScopeChange={workbench.setScope}
                projectNames={projectNames}
                activeRequestId={activeTab?.requestId ?? null}
                actions={actions}
                onCreateCollection={() => setCollectionDialog({ collection: null })}
              />
            </TabsContent>
            <TabsContent value="history" className="flex min-h-0 flex-col">
              <HistoryPanel
                version={workbench.historyVersion}
                onOpen={openHistoryEntry}
                onClear={() =>
                  setConfirmation({
                    title: 'Clear history?',
                    description: 'Every history entry is deleted. Collections are kept.',
                    confirmLabel: 'Clear history',
                    run: () =>
                      run(async () => {
                        await unwrap(api().http.clearHistory());
                        setRecentUrls([]);
                      }),
                  })
                }
              />
            </TabsContent>
          </Tabs>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className="flex items-center gap-1 overflow-x-auto border-b px-2"
            role="tablist"
            aria-label="Open requests"
          >
            {tabs.map((tab) => (
              <div
                key={tab.key}
                className={cn(
                  'group flex max-w-56 shrink-0 items-center gap-1 border-b-2 px-2 py-1.5 text-sm',
                  tab.key === activeKey
                    ? 'border-primary'
                    : 'border-transparent text-muted-foreground',
                )}
                data-testid="request-tab"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.key === activeKey}
                  className="flex min-w-0 items-center gap-1.5"
                  onClick={() => setActiveKey(tab.key)}
                >
                  <span
                    className={cn(
                      'font-mono text-[10px] font-semibold',
                      methodClass(tab.definition.method),
                    )}
                  >
                    {tab.definition.method.slice(0, 7)}
                  </span>
                  <span className="truncate">{tab.name}</span>
                  {isDirty(tab) && (
                    <span
                      className="bg-primary size-1.5 shrink-0 rounded-full"
                      aria-label="Unsaved changes"
                    />
                  )}
                </button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Close ${tab.name}`}
                  onClick={() => closeTab(tab)}
                >
                  <X />
                </Button>
              </div>
            ))}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="New request"
              onClick={() => workbench.newRequest(null, null)}
            >
              <Plus />
            </Button>
          </div>
          {activeTab === null ? (
            <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
              <Send className="size-6" aria-hidden />
              <p>Open a request from a collection, or create one.</p>
              <Button size="sm" onClick={() => workbench.newRequest(null, null)}>
                <Plus /> New request
              </Button>
            </div>
          ) : (
            <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
              <ResizablePanel id="api-request" minSize="20" defaultSize="50">
                <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={activeTab.name}
                      maxLength={120}
                      onChange={(event) =>
                        updateTab(activeTab.key, (tab) => ({ ...tab, name: event.target.value }))
                      }
                      aria-label="Request name"
                      className="h-8 max-w-80 font-medium"
                    />
                    <span className="text-muted-foreground truncate text-xs">
                      {activeTab.collectionId
                        ? (allCollections.find((c) => c.id === activeTab.collectionId)?.name ??
                          'Collection')
                        : 'Not saved'}
                    </span>
                    <div className="ml-auto flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={activeTab.name.trim() === ''}
                        onClick={() => saveActive(activeTab)}
                      >
                        <Save /> Save
                      </Button>
                      {activeTab.requestId !== null && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPlaceDialog({ mode: 'save', tabKey: activeTab.key })}
                        >
                          <Copy /> Save as…
                        </Button>
                      )}
                    </div>
                  </div>
                  <RequestEditor
                    key={activeTab.key}
                    definition={activeTab.definition}
                    onChange={(definition) =>
                      updateTab(activeTab.key, (tab) => ({ ...tab, definition }))
                    }
                    sending={activeTab.response.status === 'sending'}
                    onSend={() => void workbench.send(activeTab.key)}
                    onCancel={() => workbench.cancel(activeTab.key)}
                    recentUrls={recentUrls}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="api-response" minSize="15" defaultSize="50">
                <div className="flex h-full min-h-0 flex-col overflow-auto">
                  <ResponseViewer
                    key={activeTab.key}
                    response={activeTab.response}
                    collectionId={activeTab.collectionId}
                    onSaveSnapshot={(result) => saveSnapshot(activeTab, result)}
                    onCompare={() => setSnapshotsFor({ requestId: activeTab.requestId })}
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </div>
      </div>

      <CollectionDialog
        open={collectionDialog !== null}
        collection={collectionDialog?.collection ?? null}
        projects={projects}
        projectId={projectId}
        onOpenChange={(open) => !open && setCollectionDialog(null)}
        onSubmit={async (input) => {
          const editing = collectionDialog?.collection;
          if (editing) {
            await unwrap(api().http.updateCollection({ id: editing.id, ...input }));
          } else {
            await unwrap(api().http.createCollection(input));
          }
          await reloadCollections();
        }}
      />
      <NameDialog
        open={namePrompt !== null}
        title={namePrompt?.title ?? ''}
        label={namePrompt?.label ?? ''}
        initial={namePrompt?.initial ?? ''}
        submitLabel={namePrompt?.submitLabel ?? ''}
        testId={namePrompt?.testId ?? 'name-dialog'}
        onOpenChange={(open) => !open && setNamePrompt(null)}
        onSubmit={(name) => namePrompt!.run(name)}
      >
        {namePrompt?.warning && <p className="text-warning text-sm">{namePrompt.warning}</p>}
      </NameDialog>
      <SaveRequestDialog
        open={placeDialog !== null}
        mode={placeDialog?.mode ?? 'save'}
        collections={allCollections}
        initial={
          placeDialog?.mode === 'move'
            ? {
                name: placeDialog.request.name,
                collectionId: placeDialog.request.collectionId,
                folderId: placeDialog.request.folderId,
              }
            : {
                name: placeTab?.name ?? 'New request',
                collectionId: placeTab?.collectionId ?? null,
                folderId: placeTab?.folderId ?? null,
              }
        }
        onOpenChange={(open) => !open && setPlaceDialog(null)}
        onCreateCollection={() => {
          setPlaceDialog(null);
          setCollectionDialog({ collection: null });
        }}
        onSubmit={async (target) => {
          if (placeDialog?.mode === 'move') {
            await unwrap(
              api().http.move({
                kind: 'request',
                id: placeDialog.request.id,
                collectionId: target.collectionId,
                folderId: target.folderId,
                position: 100_000,
              }),
            );
            for (const tab of tabs.filter((t) => t.requestId === placeDialog.request.id)) {
              updateTab(tab.key, (current) => ({
                ...current,
                collectionId: target.collectionId,
                folderId: target.folderId,
              }));
            }
            await reloadCollections();
          } else if (placeDialog) {
            await workbench.save(placeDialog.tabKey, target);
          }
        }}
      />
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
      <SnapshotsDialog
        open={snapshotsFor !== null}
        requestId={snapshotsFor?.requestId ?? null}
        onOpenChange={(open) => !open && setSnapshotsFor(null)}
      />
    </section>
  );
}
