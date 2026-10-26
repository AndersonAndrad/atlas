import {
  EDITOR_LAYOUT_TABS_MAX,
  FILE_PATH_MAX,
  FILE_VERSIONS_MAX,
  FILE_WATCH_MAX,
  isRelativeFilePath,
  isValidFileName,
  type EditorLayout,
  type FileEntry,
  type FileVersionInfo,
  type TerminalPreferences,
} from '@atlas/contracts';
import { FileSearch, FolderTree, PanelBottom, Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { useProjects } from '@/hooks/useProjects';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { NameDialog } from '@/terminal/components/NameDialog';
import type { TerminalContextAction } from '@/terminal/components/TerminalPane';
import type { useTerminalSessions } from '@/terminal/hooks/useTerminalSessions';
import { onTerminalLifecycle } from '@/terminal/state/terminal-events';
import { useEditorPreferences } from '../hooks/useEditorPreferences';
import { useFileTree } from '../hooks/useFileTree';
import { loadMonaco, type Monaco } from '../monaco/monaco';
import { EditorBuffers } from '../state/buffers';
import {
  EMPTY_TABS,
  closeTab,
  fileName,
  isWithin,
  layoutTabs,
  newTab,
  openTab,
  parentPath,
  renameTabs,
  updateTab,
  watchedDirectories,
  type EditorTab,
  type TabsState,
  type ViewState,
} from '../state/tabs';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { ConfirmDialog, QuickOpenDialog, UnsavedDialog } from './EditorDialogs';
import { EditorTabs } from './EditorTabs';
import { EditorTerminalPanel } from './EditorTerminalPanel';
import { FileExplorer, type ExplorerActions } from './FileExplorer';

const isMac = navigator.userAgent.includes('Mac');

interface Panels {
  explorerVisible: boolean;
  explorerSize: number;
  terminalVisible: boolean;
  terminalSize: number;
}

const DEFAULT_PANELS: Panels = {
  explorerVisible: true,
  explorerSize: 22,
  terminalVisible: false,
  terminalSize: 32,
};

type NameRequest =
  | { kind: 'create'; folder: string; entry: 'file' | 'directory' }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'save-as'; path: string };

interface UnsavedPrompt {
  paths: string[];
  action: string;
  proceed: () => void;
}

interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  run: () => Promise<string | null>;
}

export interface EditorViewProps {
  projects: ReturnType<typeof useProjects>;
  terminals: ReturnType<typeof useTerminalSessions>;
  terminalPreferences: TerminalPreferences | null;
  /** The view stays mounted while hidden, so unsaved buffers are kept (FR-1105). */
  visible: boolean;
  onOpenGit: (terminalId: string) => void;
  onOpenPreflight: (terminalId: string) => void;
  onContextAction: (terminalId: string, action: TerminalContextAction) => void;
  onOpenProjects: () => void;
}

function useNarrow(): boolean {
  const query = '(max-width: 767px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

/**
 * Code editor workspace (SDD-011 Milestone A): explorer, Monaco tabs and an optional
 * terminal of the project. Monaco loads the first time this view opens.
 */
export function EditorView(props: EditorViewProps) {
  const { visible } = props;
  const details = props.projects.items;
  const projectItems = useMemo(() => details?.map((entry) => entry.project) ?? null, [details]);
  const { preferences, update: updatePreferences } = useEditorPreferences();
  const narrow = useNarrow();
  const [monaco, setMonaco] = useState<Monaco | null>(null);
  const [monacoError, setMonacoError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  /** The buffers whose project layout has been restored. */
  const [restoredFor, setRestoredFor] = useState<EditorBuffers | null>(null);
  // Tabs belong to one project: those of another project are never shown.
  const [tabsHolder, setTabsHolder] = useState<{ projectId: string | null; state: TabsState }>({
    projectId: null,
    state: EMPTY_TABS,
  });
  const tabs = tabsHolder.projectId === projectId ? tabsHolder.state : EMPTY_TABS;
  const [panels, setPanels] = useState<Panels>(DEFAULT_PANELS);
  const [expandedInitial, setExpandedInitial] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [nameRequest, setNameRequest] = useState<NameRequest | null>(null);
  const [unsavedPrompt, setUnsavedPrompt] = useState<UnsavedPrompt | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [overlayExplorer, setOverlayExplorer] = useState(false);
  const editorHandle = useRef<CodeEditorHandle | null>(null);
  const viewStates = useRef(new Map<string, ViewState>());
  const loadingTabs = useRef(new Set<string>());
  const autoSaveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const setTabsFor = useCallback(
    (owner: string, change: (current: TabsState) => TabsState) =>
      setTabsHolder((holder) => ({
        projectId: owner,
        state: change(holder.projectId === owner ? holder.state : EMPTY_TABS),
      })),
    [],
  );
  const setTabs = useCallback(
    (change: (current: TabsState) => TabsState) => {
      if (projectId !== null) setTabsFor(projectId, change);
    },
    [projectId, setTabsFor],
  );
  // One set of buffers per project; created when Monaco is available.
  const buffers = useMemo(
    () =>
      monaco === null || projectId === null
        ? null
        : new EditorBuffers(monaco, projectId, (path, dirty) =>
            setTabsFor(projectId, (current) => updateTab(current, path, { dirty })),
          ),
    [monaco, projectId, setTabsFor],
  );
  useEffect(() => () => buffers?.disposeAll(), [buffers]);

  const tabsRef = useRef(tabs);
  const prefsRef = useRef(preferences);
  const buffersRef = useRef(buffers);
  useEffect(() => {
    tabsRef.current = tabs;
    prefsRef.current = preferences;
    buffersRef.current = buffers;
  });

  // A removed project leaves the editor, unless that would discard unsaved changes: they
  // stay visible (to copy) until the user switches project and confirms.
  const projectRemoved =
    projectId !== null &&
    projectItems !== null &&
    !projectItems.some((item) => item.id === projectId);
  if (projectRemoved && !tabs.tabs.some((tab) => tab.dirty)) {
    setProjectId(projectItems[0]?.id ?? null);
  }

  const project = projectItems?.find((item) => item.id === projectId) ?? null;
  const ready = buffers !== null && restoredFor === buffers;
  const tree = useFileTree(
    ready ? projectId : null,
    { showHidden: preferences.showHiddenFiles, showIgnored: preferences.showIgnoredFiles },
    expandedInitial,
  );
  const { toggle: treeToggle, reveal: treeReveal, refresh: treeRefresh, expanded } = tree;
  const activeTab = tabs.tabs.find((tab) => tab.path === tabs.activePath) ?? null;

  // Monaco is loaded the first time the editor is shown (terminal-only use never loads it).
  useEffect(() => {
    if (!visible || monaco !== null) return;
    let cancelled = false;
    loadMonaco().then(
      (loaded) => !cancelled && setMonaco(loaded),
      () =>
        !cancelled &&
        setMonacoError('The code editor could not be loaded. Restart ATLAS and try again.'),
    );
    return () => {
      cancelled = true;
    };
  }, [visible, monaco]);

  // The first project: the last one edited, else the selected one, else the first.
  useEffect(() => {
    if (projectItems === null || projectId !== null || projectItems.length === 0) return;
    let cancelled = false;
    void unwrap(api().editor.getLastProject())
      .catch(() => null)
      .then((last) => {
        if (cancelled) return;
        const ids = projectItems.map((item) => item.id);
        const preferred = [last, props.projects.selectedId].find(
          (id) => id != null && ids.includes(id),
        );
        setProjectId(preferred ?? ids[0]!);
      });
    return () => {
      cancelled = true;
    };
  }, [projectItems, projectId, props.projects.selectedId]);

  const setTab = useCallback(
    (path: string, patch: Partial<Omit<EditorTab, 'path'>>) =>
      setTabs((current) => updateTab(current, path, patch)),
    [setTabs],
  );

  const save = useCallback(
    async (path: string, options: { overwrite?: boolean } = {}): Promise<boolean> => {
      const current = buffersRef.current;
      const tab = tabsRef.current.tabs.find((candidate) => candidate.path === path);
      const snapshot = current?.snapshot(path);
      if (current == null || projectId === null || tab?.status !== 'ready' || snapshot == null) {
        return false;
      }
      if (tab.readOnly) {
        setNotice(`${fileName(path)} is read-only for ATLAS.`);
        return false;
      }
      setTab(path, { saving: true });
      try {
        const written = await unwrap(
          api().projectFiles.write({
            projectId,
            path,
            content: snapshot.content,
            encoding: tab.encoding,
            expectedVersion: tab.version,
            ...(options.overwrite ? { overwrite: true } : {}),
          }),
        );
        if (buffersRef.current !== current) return false;
        // Edits typed while saving stay modified (they are not in the saved version).
        current.markSaved(path, snapshot.versionId);
        setTab(path, { saving: false, version: written.version, conflict: null, reloaded: false });
        return true;
      } catch (caught) {
        setTab(path, { saving: false });
        if (caught instanceof ApiError && caught.code === 'FILE_CONFLICT') {
          const [info] = await unwrap(
            api().projectFiles.versions({ projectId, paths: [path] }),
          ).catch(() => []);
          setTab(path, { conflict: info?.exists === false ? 'deleted' : 'changed' });
        } else {
          setNotice(`${fileName(path)} was not saved: ${errorMessage(caught)}`);
        }
        return false;
      }
    },
    [projectId, setTab],
  );

  const saveMany = useCallback(
    async (paths: readonly string[]) => {
      let ok = true;
      for (const path of paths) if (!(await save(path))) ok = false;
      return ok;
    },
    [save],
  );

  const scheduleAutoSave = useCallback(
    (path: string) => {
      const prefs = prefsRef.current;
      if (prefs.autoSave !== 'after-delay') return;
      clearTimeout(autoSaveTimers.current.get(path));
      autoSaveTimers.current.set(
        path,
        setTimeout(() => {
          autoSaveTimers.current.delete(path);
          const tab = tabsRef.current.tabs.find((candidate) => candidate.path === path);
          const dirty = buffersRef.current?.isDirty(path) ?? false;
          if (dirty && tab?.conflict === null && !tab.saving) void save(path);
        }, prefs.autoSaveDelayMs),
      );
    },
    [save],
  );
  useEffect(() => {
    buffers?.setEditListener(scheduleAutoSave);
  }, [buffers, scheduleAutoSave]);

  // Restoring the project's layout reopens the files that are still there.
  useEffect(() => {
    if (buffers === null || projectId === null) return;
    let cancelled = false;
    const timers = autoSaveTimers.current;
    loadingTabs.current.clear();
    void api().editor.setLastProject(projectId);
    void (async () => {
      const layout = await unwrap(api().editor.getLayout(projectId)).catch(() => null);
      let restored = layout?.tabs ?? [];
      if (restored.length > 0) {
        // Only files that still exist inside the project are restored (FR-1110).
        const versions = await unwrap(
          api().projectFiles.versions({ projectId, paths: restored.map((tab) => tab.path) }),
        ).catch(() => []);
        const existing = new Set(versions.filter((info) => info.exists).map((info) => info.path));
        restored = restored.filter((tab) => existing.has(tab.path));
      }
      if (cancelled) return;
      viewStates.current = new Map(
        restored.map(({ path, line, column, scrollTop }) => [
          path,
          {
            ...(line ? { line } : {}),
            ...(column ? { column } : {}),
            ...(scrollTop ? { scrollTop } : {}),
          },
        ]),
      );
      setPanels(
        layout
          ? {
              explorerVisible: layout.explorerVisible,
              explorerSize: layout.explorerSize,
              terminalVisible: layout.terminalVisible,
              terminalSize: layout.terminalSize,
            }
          : DEFAULT_PANELS,
      );
      setExpandedInitial(layout?.expanded ?? []);
      const paths = restored.map((tab) => tab.path);
      setTabsFor(projectId, () => ({
        tabs: paths.map(newTab),
        activePath:
          layout?.activePath && paths.includes(layout.activePath)
            ? layout.activePath
            : (paths.at(-1) ?? null),
      }));
      setRestoredFor(buffers);
    })();
    return () => {
      cancelled = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [buffers, projectId, setTabsFor]);

  /** Reads a file into its buffer (first open, or reload from disk). */
  const loadTab = useCallback(
    async (path: string, mode: 'open' | 'reload' | 'auto-reload') => {
      const current = buffersRef.current;
      if (current === null || projectId === null || loadingTabs.current.has(path)) return;
      loadingTabs.current.add(path);
      try {
        const file = await unwrap(api().projectFiles.read({ projectId, path }));
        if (buffersRef.current !== current) return;
        if (mode === 'open' || !current.has(path)) current.create(path, file.content, file.eol);
        else current.reload(path, file.content, file.eol);
        setTab(path, {
          status: 'ready',
          error: null,
          encoding: file.encoding,
          eol: file.eol,
          mixedEol: file.mixedEol,
          readOnly: file.readOnly,
          version: file.version,
          dirty: false,
          conflict: null,
          reloaded: mode === 'auto-reload',
        });
      } catch (caught) {
        if (buffersRef.current !== current) return;
        if (mode === 'open') setTab(path, { status: 'error', error: errorMessage(caught) });
        else {
          // e.g. it grew beyond the size limit: the buffer no longer matches the disk.
          setTab(path, { conflict: 'changed' });
          setNotice(`${fileName(path)} could not be reloaded: ${errorMessage(caught)}`);
        }
      } finally {
        loadingTabs.current.delete(path);
      }
    },
    [projectId, setTab],
  );

  // Restored tabs are read when they are first shown.
  const pendingPath =
    activeTab?.status === 'loading' && buffers !== null && !buffers.has(activeTab.path)
      ? activeTab.path
      : null;
  useEffect(() => {
    if (pendingPath === null) return;
    const timer = setTimeout(() => void loadTab(pendingPath, 'open'), 0);
    return () => clearTimeout(timer);
  }, [pendingPath, loadTab]);

  const openFile = useCallback(
    (path: string) => {
      setTabs((current) => openTab(current, path));
      if (narrow) setOverlayExplorer(false);
    },
    [narrow, setTabs],
  );

  /** Compares open tabs with the disk (FR-1107): unchanged files reload, edited ones conflict. */
  const checkTabs = useCallback(
    async (paths: readonly string[] | null) => {
      const current = buffersRef.current;
      if (current === null || projectId === null) return;
      const candidates = tabsRef.current.tabs.filter(
        (tab) =>
          tab.status === 'ready' &&
          !tab.saving &&
          (paths === null || paths.some((changed) => isWithin(tab.path, changed))),
      );
      if (candidates.length === 0) return;
      const infos: FileVersionInfo[] = [];
      try {
        // In batches: a request names at most FILE_VERSIONS_MAX files.
        for (let start = 0; start < candidates.length; start += FILE_VERSIONS_MAX) {
          const paths = candidates.slice(start, start + FILE_VERSIONS_MAX).map((tab) => tab.path);
          infos.push(...(await unwrap(api().projectFiles.versions({ projectId, paths }))));
        }
      } catch {
        return;
      }
      if (buffersRef.current !== current) return;
      for (const info of infos) {
        const tab = tabsRef.current.tabs.find((candidate) => candidate.path === info.path);
        if (tab === undefined || tab.saving || tab.status !== 'ready') continue;
        if (!info.exists) {
          setTab(info.path, { conflict: 'deleted' });
        } else if (info.version !== tab.version) {
          // A null version (e.g. the file grew beyond the limit) cannot match either.
          if (!current.isDirty(info.path) && prefsRef.current.autoReload) {
            void loadTab(info.path, 'auto-reload');
          } else {
            setTab(info.path, { conflict: 'changed' });
          }
        } else if (info.version === tab.version && tab.conflict !== null) {
          setTab(info.path, { conflict: null });
        }
      }
    },
    [projectId, setTab, loadTab],
  );

  // Changes reported by the Engine, the Engine restarting and the window regaining focus.
  useEffect(() => {
    if (!ready || projectId === null) return;
    const stop = onTerminalLifecycle((event) => {
      if (event.type !== 'files' || event.projectId !== projectId) return;
      treeRefresh(event.paths);
      void checkTabs(event.paths);
    });
    const stopRestart = api().app.onEngineRestarted(() => {
      treeRefresh(null);
      void checkTabs(null);
    });
    const onFocus = () => void checkTabs(null);
    window.addEventListener('focus', onFocus);
    return () => {
      stop();
      stopRestart();
      window.removeEventListener('focus', onFocus);
    };
  }, [ready, projectId, treeRefresh, checkTabs]);

  // Watch the folders shown in the explorer and those of open files.
  const watchKey = JSON.stringify(
    ready ? watchedDirectories(tabs.tabs, expanded, FILE_WATCH_MAX) : [],
  );
  useEffect(() => {
    if (!ready || projectId === null) return;
    const timer = setTimeout(() => {
      void unwrap(
        api().projectFiles.watch({ projectId, directories: JSON.parse(watchKey) as string[] }),
      )
        // Changes made before the folders were watched are caught by comparing versions.
        .then(() => checkTabs(null))
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [ready, projectId, watchKey, checkTabs]);
  useEffect(() => () => void api().projectFiles.watch({ projectId: null, directories: [] }), []);

  // Layout persistence (FR-1110): file references, positions and panel sizes only.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const persistRef = useRef<() => void>(() => undefined);
  /** The save scheduled last, bound to the project it was scheduled for. */
  const pendingPersist = useRef<(() => void) | null>(null);
  useEffect(() => {
    persistRef.current = () => {
      if (!ready || projectId === null) return;
      const layout: EditorLayout = {
        ...layoutTabs(tabs, viewStates.current, EDITOR_LAYOUT_TABS_MAX),
        ...panels,
        expanded: [...expanded].slice(0, FILE_WATCH_MAX),
      };
      void api().editor.setLayout(projectId, layout);
    };
  });
  const flushPersist = useCallback(() => {
    clearTimeout(persistTimer.current);
    const run = pendingPersist.current;
    pendingPersist.current = null;
    run?.();
  }, []);
  const schedulePersist = useCallback(() => {
    clearTimeout(persistTimer.current);
    pendingPersist.current = persistRef.current;
    persistTimer.current = setTimeout(flushPersist, 600);
  }, [flushPersist]);
  const tabPaths = tabs.tabs.map((tab) => tab.path).join('\n');
  const expandedKey = [...expanded].join('\n');
  useEffect(() => {
    if (ready) schedulePersist();
  }, [ready, tabPaths, tabs.activePath, panels, expandedKey, schedulePersist]);
  // Switching project (or leaving) saves the pending layout of the previous project.
  useEffect(() => flushPersist, [projectId, flushPersist]);

  // Quitting or closing the window asks while any tab has unsaved changes.
  const dirtyCount = tabs.tabs.filter((tab) => tab.dirty).length;
  useEffect(() => {
    void api().app.setUnsavedFiles(dirtyCount);
  }, [dirtyCount]);
  useEffect(() => () => void api().app.setUnsavedFiles(0), []);

  // Cmd+W, Cmd+F, Cmd+D… belong to the editor while it is shown (PLAN-033 R1).
  useEffect(() => {
    void api().app.setTerminalShortcuts(!visible);
    if (visible) editorHandle.current?.focus();
  }, [visible]);
  useEffect(() => () => void api().app.setTerminalShortcuts(true), []);

  const requestClose = useCallback(
    (path: string) => {
      const proceed = () => {
        buffersRef.current?.dispose(path);
        clearTimeout(autoSaveTimers.current.get(path));
        setTabs((current) => closeTab(current, path));
      };
      // The buffer is the source of truth: a key typed just before Cmd+W counts.
      if (buffersRef.current?.isDirty(path)) {
        setUnsavedPrompt({ paths: [path], action: 'Close', proceed });
      } else proceed();
    },
    [setTabs],
  );

  const changeProject = (next: string) => {
    if (next === projectId) return;
    const dirty = buffersRef.current?.dirtyPaths() ?? [];
    const proceed = () => setProjectId(next);
    if (dirty.length > 0) setUnsavedPrompt({ paths: dirty, action: 'Switch project', proceed });
    else proceed();
  };

  /** Save As (FR-1106): a new file in the project; replacing one needs confirmation. */
  const saveAs = useCallback(
    async (from: string, to: string): Promise<string | null> => {
      const attempt = async (overwrite: boolean): Promise<string | null> => {
        const current = buffersRef.current;
        const tab = tabsRef.current.tabs.find((candidate) => candidate.path === from);
        const snapshot = current?.snapshot(from);
        if (current == null || projectId === null || tab === undefined || snapshot == null) {
          return 'The file is not open.';
        }
        try {
          const written = await unwrap(
            api().projectFiles.write({
              projectId,
              path: to,
              content: snapshot.content,
              encoding: tab.encoding,
              expectedVersion: null,
              ...(overwrite ? { overwrite: true } : {}),
            }),
          );
          current.dispose(to);
          current.create(to, snapshot.content, tab.eol);
          if (from !== to) current.dispose(from);
          setTabs((state) =>
            updateTab(openTab(from === to ? state : closeTab(state, from), to), to, {
              status: 'ready',
              error: null,
              encoding: tab.encoding,
              eol: tab.eol,
              mixedEol: false,
              readOnly: false,
              version: written.version,
              dirty: false,
              saving: false,
              conflict: null,
              reloaded: false,
            }),
          );
          treeReveal(to);
          return null;
        } catch (caught) {
          if (caught instanceof ApiError && caught.code === 'FILE_ALREADY_EXISTS' && !overwrite) {
            setConfirm({
              title: `Replace ${fileName(to)}?`,
              description: `${to} already exists. Replacing it overwrites its content with this file.`,
              confirmLabel: 'Replace',
              destructive: true,
              run: () => attempt(true),
            });
            return null;
          }
          return errorMessage(caught);
        }
      };
      return attempt(false);
    },
    [projectId, setTabs, treeReveal],
  );

  const explorerActions: ExplorerActions = useMemo(
    () => ({
      open: openFile,
      toggle: treeToggle,
      create: (folder, entry) => setNameRequest({ kind: 'create', folder, entry }),
      rename: (entry) => setNameRequest({ kind: 'rename', entry }),
      trash: (entry) =>
        setConfirm({
          title: `Move ${entry.name} to the Trash?`,
          description:
            entry.kind === 'directory'
              ? `The folder ${entry.path} and everything in it go to the system Trash.`
              : `${entry.path} goes to the system Trash.`,
          confirmLabel: 'Move to Trash',
          destructive: true,
          run: async () => {
            if (projectId === null) return null;
            const affected = tabsRef.current.tabs.filter((tab) => isWithin(tab.path, entry.path));
            try {
              await unwrap(api().projectFiles.trash({ projectId, path: entry.path }));
            } catch (caught) {
              return errorMessage(caught);
            }
            for (const tab of affected) {
              if (buffersRef.current?.isDirty(tab.path)) setTab(tab.path, { conflict: 'deleted' });
              else {
                buffersRef.current?.dispose(tab.path);
                setTabs((current) => closeTab(current, tab.path));
              }
            }
            treeRefresh([parentPath(entry.path)]);
            return null;
          },
        }),
      reveal: (entry) => {
        if (projectId === null) return;
        void unwrap(api().projectFiles.reveal({ projectId, path: entry.path })).catch(
          (caught: unknown) => setNotice(errorMessage(caught)),
        );
      },
      copyPath: (entry) =>
        void copyText(entry.path).catch(() => setNotice('The path could not be copied.')),
      move: (from, folder) => {
        if (projectId === null) return;
        const to = folder === '' ? fileName(from) : `${folder}/${fileName(from)}`;
        void unwrap(api().projectFiles.move({ projectId, from, to })).then(
          () => {
            for (const tab of tabsRef.current.tabs) {
              if (isWithin(tab.path, from))
                buffersRef.current?.rename(tab.path, to + tab.path.slice(from.length));
            }
            setTabs((current) => renameTabs(current, from, to));
            treeRefresh([parentPath(from), folder]);
          },
          (caught: unknown) => setNotice(errorMessage(caught)),
        );
      },
    }),
    [openFile, projectId, setTab, setTabs, treeToggle, treeRefresh],
  );

  const submitName = async (request: NameRequest, value: string): Promise<string | null> => {
    if (projectId === null) return 'Choose a project first.';
    if (request.kind === 'save-as') {
      if (!isRelativeFilePath(value) || value === '') {
        return 'Use a path inside the project, like src/new-file.ts (no ".." or leading "/").';
      }
      return saveAs(request.path, value);
    }
    if (!isValidFileName(value)) return 'Use a name without "/" that is not "." or "..".';
    try {
      if (request.kind === 'create') {
        const path = request.folder === '' ? value : `${request.folder}/${value}`;
        await unwrap(api().projectFiles.create({ projectId, path, kind: request.entry }));
        if (request.folder !== '' && !expanded.has(request.folder)) treeToggle(request.folder);
        treeRefresh([path]);
        if (request.entry === 'file') openFile(path);
        return null;
      }
      const from = request.entry.path;
      const parent = parentPath(from);
      const to = parent === '' ? value : `${parent}/${value}`;
      if (to === from) return null;
      await unwrap(api().projectFiles.move({ projectId, from, to }));
      for (const tab of tabsRef.current.tabs) {
        if (isWithin(tab.path, from))
          buffersRef.current?.rename(tab.path, to + tab.path.slice(from.length));
      }
      setTabs((current) => renameTabs(current, from, to));
      treeRefresh([from, to]);
      return null;
    } catch (caught) {
      return errorMessage(caught);
    }
  };

  // Editor shortcuts (FR-1111), active only while the editor is shown.
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"], [role="alertdialog"]')) return;
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (event.ctrlKey && !event.metaKey && event.code === 'Backquote') {
        event.preventDefault();
        setPanels((current) => ({ ...current, terminalVisible: !current.terminalVisible }));
        return;
      }
      if (!mod) return;
      // Typing in the terminal panel keeps its own keys.
      if (target?.closest('[data-testid="editor-terminal"]')) return;
      const active = tabsRef.current.activePath;
      const key = event.code;
      if (key === 'KeyS' && event.altKey && !event.shiftKey) {
        event.preventDefault();
        void saveMany(buffersRef.current?.dirtyPaths() ?? []);
      } else if (key === 'KeyS' && event.shiftKey) {
        event.preventDefault();
        if (active !== null) setNameRequest({ kind: 'save-as', path: active });
      } else if (key === 'KeyS') {
        event.preventDefault();
        if (active !== null) void save(active);
      } else if (key === 'KeyW' && !event.shiftKey) {
        event.preventDefault();
        if (active !== null) requestClose(active);
      } else if (key === 'KeyP' && !event.shiftKey) {
        event.preventDefault();
        if (projectId !== null) setQuickOpen(true);
      } else if (key === 'KeyB' && !event.shiftKey) {
        event.preventDefault();
        setPanels((current) => ({ ...current, explorerVisible: !current.explorerVisible }));
        setOverlayExplorer((open) => !open);
      } else if (key === 'KeyF' && !event.shiftKey && !target?.closest('.monaco-editor, input')) {
        // Find works from anywhere in the editor view, not only with the cursor in the code.
        event.preventDefault();
        editorHandle.current?.run('actions.find');
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [visible, projectId, save, saveMany, requestClose]);

  // Auto save when the editor or the window loses focus.
  const onEditorBlur = useCallback(() => {
    if (prefsRef.current.autoSave !== 'on-focus-change') return;
    const active = tabsRef.current.tabs.find((tab) => tab.path === tabsRef.current.activePath);
    if (active && buffersRef.current?.isDirty(active.path) && active.conflict === null) {
      void save(active.path);
    }
  }, [save]);
  useEffect(() => {
    const onBlur = () => {
      if (prefsRef.current.autoSave !== 'on-focus-change') return;
      void saveMany(
        tabsRef.current.tabs
          .filter((tab) => tab.dirty && tab.conflict === null)
          .map((tab) => tab.path),
      );
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [saveMany]);

  // Clears "reloaded" a moment after an automatic reload.
  useEffect(() => {
    if (!activeTab?.reloaded) return;
    const timer = setTimeout(() => setTab(activeTab.path, { reloaded: false }), 4000);
    return () => clearTimeout(timer);
  }, [activeTab, setTab]);

  const model = activeTab?.status === 'ready' ? (buffers?.model(activeTab.path) ?? null) : null;

  // Without projects there is nothing to edit (unless unsaved changes of a removed one remain).
  if (projectItems !== null && projectItems.length === 0 && projectId === null) {
    return (
      <main
        className={cn('flex min-w-0 flex-1 items-center justify-center p-6', !visible && 'hidden')}
      >
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-muted-foreground text-sm">
            Register a project to browse and edit its files here.
          </p>
          <Button onClick={props.onOpenProjects}>Open Projects</Button>
        </div>
      </main>
    );
  }

  const explorer = project && ready && (
    <FileExplorer
      projectName={project.name}
      rows={tree.rows}
      loading={tree.rootLoading}
      error={tree.rootError}
      hiddenIgnored={tree.hiddenIgnored}
      showIgnored={preferences.showIgnoredFiles}
      activePath={tabs.activePath}
      actions={explorerActions}
      onToggleIgnored={() =>
        void updatePreferences({ showIgnoredFiles: !preferences.showIgnoredFiles })
      }
      onRefresh={() => treeRefresh(null)}
      onRevealActive={() => tabs.activePath !== null && treeReveal(tabs.activePath)}
    />
  );

  const editorArea = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <EditorTabs
        tabs={tabs.tabs}
        activePath={tabs.activePath}
        onActivate={(path) => setTabs((current) => ({ ...current, activePath: path }))}
        onClose={requestClose}
      />
      {activeTab && (
        <TabBanner
          tab={activeTab}
          dirty={activeTab.dirty}
          actions={{
            reload: () => void loadTab(activeTab.path, 'reload'),
            keepMine: () => void save(activeTab.path, { overwrite: true }),
            dismiss: () => setTab(activeTab.path, { conflict: null }),
            close: () => {
              buffersRef.current?.dispose(activeTab.path);
              setTabs((current) => closeTab(current, activeTab.path));
            },
          }}
        />
      )}
      <div className="relative min-h-0 flex-1">
        {monacoError ? (
          <p className="text-destructive p-4 text-sm" role="alert">
            {monacoError}
          </p>
        ) : monaco === null ? (
          <p className="text-muted-foreground p-4 text-sm">Loading the editor…</p>
        ) : (
          <>
            <div className={cn('absolute inset-0', model === null && 'invisible')}>
              <CodeEditor
                monaco={monaco}
                model={model}
                path={model === null ? null : (activeTab?.path ?? null)}
                preferences={preferences}
                readOnly={activeTab?.readOnly ?? false}
                initialViewState={(path) => viewStates.current.get(path)}
                onViewState={(path, state) => {
                  viewStates.current.set(path, state);
                  schedulePersist();
                }}
                onBlur={onEditorBlur}
                registerHandle={(handle) => {
                  editorHandle.current = handle;
                }}
              />
            </div>
            {activeTab === null ? (
              <EmptyEditor onQuickOpen={() => setQuickOpen(true)} />
            ) : activeTab.status === 'error' ? (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
                data-testid="editor-file-error"
              >
                <p className="text-sm">{activeTab.error}</p>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      projectId !== null &&
                      void unwrap(
                        api().projectFiles.reveal({ projectId, path: activeTab.path }),
                      ).catch((caught: unknown) => setNotice(errorMessage(caught)))
                    }
                  >
                    Reveal in file manager
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => requestClose(activeTab.path)}>
                    Close tab
                  </Button>
                </div>
              </div>
            ) : activeTab.status === 'loading' ? (
              <p className="text-muted-foreground absolute inset-0 p-4 text-sm">Opening…</p>
            ) : null}
          </>
        )}
      </div>
      <StatusBar tab={activeTab} preferences={preferences} />
    </div>
  );

  const showSideExplorer = panels.explorerVisible && !narrow;
  // Unmounted while the view is hidden: the Terminals view shows the same sessions.
  const terminal = visible && project && panels.terminalVisible && props.terminalPreferences && (
    <EditorTerminalPanel
      projectId={project.id}
      projectName={project.name}
      terminals={props.terminals}
      preferences={props.terminalPreferences}
      onHide={() => setPanels((current) => ({ ...current, terminalVisible: false }))}
      onOpenGit={props.onOpenGit}
      onOpenPreflight={props.onOpenPreflight}
      onContextAction={props.onContextAction}
      onProjectInfo={props.onOpenProjects}
    />
  );

  return (
    <main
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col', !visible && 'hidden')}
      aria-label="Editor"
      data-testid="editor-view"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
        <Select value={projectId ?? ''} onValueChange={changeProject}>
          <SelectTrigger size="sm" className="w-44 min-w-0 sm:w-56" aria-label="Project">
            <SelectValue placeholder="Choose a project" />
          </SelectTrigger>
          <SelectContent>
            {(projectItems ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={
            narrow ? 'Show explorer' : panels.explorerVisible ? 'Hide explorer' : 'Show explorer'
          }
          aria-pressed={narrow ? overlayExplorer : panels.explorerVisible}
          title={`Toggle explorer (${isMac ? '⌘B' : 'Ctrl+B'})`}
          onClick={() =>
            narrow
              ? setOverlayExplorer((open) => !open)
              : setPanels((current) => ({ ...current, explorerVisible: !current.explorerVisible }))
          }
        >
          <FolderTree />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open file"
          title={`Open file (${isMac ? '⌘P' : 'Ctrl+P'})`}
          disabled={!ready}
          onClick={() => setQuickOpen(true)}
        >
          <FileSearch />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={panels.terminalVisible ? 'Hide terminal' : 'Show terminal'}
          aria-pressed={panels.terminalVisible}
          title="Toggle terminal (Ctrl+`)"
          disabled={!ready}
          onClick={() =>
            setPanels((current) => ({ ...current, terminalVisible: !current.terminalVisible }))
          }
        >
          <PanelBottom />
        </Button>
        <span className="ml-auto" />
        {notice && (
          <p
            className="text-muted-foreground hidden min-w-0 truncate text-xs sm:block"
            role="status"
            title={notice}
          >
            {notice}
          </p>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={!activeTab?.dirty || activeTab.saving}
          onClick={() => activeTab && void save(activeTab.path)}
          title={`Save (${isMac ? '⌘S' : 'Ctrl+S'})`}
        >
          <Save />
          <span className="hidden sm:inline">{activeTab?.saving ? 'Saving…' : 'Save'}</span>
        </Button>
      </header>
      {notice && (
        <Alert className="m-2 sm:hidden" role="status">
          <AlertDescription className="wrap-anywhere text-xs">{notice}</AlertDescription>
        </Alert>
      )}
      {projectRemoved && (
        <Alert
          variant="destructive"
          className="m-2 w-auto"
          role="alert"
          data-testid="editor-project-removed"
        >
          <AlertDescription>
            This project is no longer registered in ATLAS, so its files cannot be saved here. Copy
            your unsaved changes or register the folder again before switching project.
          </AlertDescription>
        </Alert>
      )}
      <div className="relative min-h-0 flex-1">
        <ResizablePanelGroup
          orientation="horizontal"
          onLayoutChanged={(layout, meta) => {
            const size = layout['editor-explorer'];
            if (meta.isUserInteraction && size !== undefined) {
              setPanels((current) => ({
                ...current,
                explorerSize: Math.min(60, Math.max(10, size)),
              }));
            }
          }}
        >
          {showSideExplorer && (
            <>
              <ResizablePanel
                id="editor-explorer"
                defaultSize={`${panels.explorerSize}`}
                minSize="10"
                maxSize="60"
              >
                {explorer}
              </ResizablePanel>
              <ResizableHandle aria-label="Resize explorer" />
            </>
          )}
          <ResizablePanel id="editor-main" minSize="30">
            {terminal ? (
              <ResizablePanelGroup
                orientation="vertical"
                onLayoutChanged={(layout, meta) => {
                  const size = layout['editor-terminal-panel'];
                  if (meta.isUserInteraction && size !== undefined) {
                    setPanels((current) => ({
                      ...current,
                      terminalSize: Math.min(85, Math.max(10, size)),
                    }));
                  }
                }}
              >
                <ResizablePanel id="editor-code" minSize="15">
                  {editorArea}
                </ResizablePanel>
                <ResizableHandle aria-label="Resize terminal" />
                <ResizablePanel
                  id="editor-terminal-panel"
                  defaultSize={`${panels.terminalSize}`}
                  minSize="10"
                >
                  {terminal}
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              editorArea
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
        {narrow && overlayExplorer && explorer && (
          <div className="bg-background absolute inset-y-0 left-0 z-20 w-[85%] max-w-80 border-r shadow-xl">
            {explorer}
          </div>
        )}
      </div>
      {quickOpen && projectId !== null && (
        <QuickOpenDialog
          projectId={projectId}
          onOpen={openFile}
          onClose={() => setQuickOpen(false)}
        />
      )}
      {nameRequest && (
        <NameDialog
          title={
            nameRequest.kind === 'save-as'
              ? 'Save as'
              : nameRequest.kind === 'rename'
                ? `Rename ${nameRequest.entry.name}`
                : nameRequest.entry === 'file'
                  ? 'New file'
                  : 'New folder'
          }
          description={
            nameRequest.kind === 'save-as'
              ? 'Path in the project. An existing file is replaced only after you confirm.'
              : nameRequest.kind === 'create' && nameRequest.folder !== ''
                ? `In ${nameRequest.folder}`
                : undefined
          }
          label={nameRequest.kind === 'save-as' ? 'Path' : 'Name'}
          initialValue={
            nameRequest.kind === 'save-as'
              ? nameRequest.path
              : nameRequest.kind === 'rename'
                ? nameRequest.entry.name
                : ''
          }
          submitLabel={
            nameRequest.kind === 'save-as'
              ? 'Save'
              : nameRequest.kind === 'rename'
                ? 'Rename'
                : 'Create'
          }
          maxLength={FILE_PATH_MAX}
          onSubmit={(value) => submitName(nameRequest, value)}
          onClose={() => setNameRequest(null)}
        />
      )}
      {unsavedPrompt && (
        <UnsavedDialog
          paths={unsavedPrompt.paths}
          action={unsavedPrompt.action}
          onCancel={() => setUnsavedPrompt(null)}
          onDiscard={() => {
            setUnsavedPrompt(null);
            unsavedPrompt.proceed();
          }}
          onSave={async () => {
            const saved = await saveMany(unsavedPrompt.paths);
            setUnsavedPrompt(null);
            if (saved) unsavedPrompt.proceed();
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.confirmLabel}
          destructive={confirm.destructive ?? false}
          onConfirm={confirm.run}
          onClose={() => setConfirm(null)}
        />
      )}
    </main>
  );
}

interface BannerActions {
  reload: () => void;
  keepMine: () => void;
  dismiss: () => void;
  close: () => void;
}

/** What the user must know about the active file: conflicts first (FR-1107). */
function TabBanner({
  tab,
  dirty,
  actions,
}: {
  tab: EditorTab;
  dirty: boolean;
  actions: BannerActions;
}) {
  let content: ReactNode = null;
  if (tab.conflict === 'deleted') {
    content = (
      <>
        <span className="mr-auto">
          This file was deleted or moved on disk.{dirty ? ' Your edits are not saved.' : ''}
        </span>
        <Button size="xs" variant="secondary" onClick={actions.keepMine}>
          Save to recreate it
        </Button>
        <Button size="xs" variant="ghost" onClick={actions.close}>
          Close tab
        </Button>
      </>
    );
  } else if (tab.conflict === 'changed') {
    content = (
      <>
        <span className="mr-auto">
          {dirty
            ? 'This file changed on disk since you opened it. Your edits are not saved.'
            : 'This file changed on disk.'}
        </span>
        <Button size="xs" variant="secondary" onClick={actions.reload}>
          {dirty ? 'Reload (discard my edits)' : 'Reload'}
        </Button>
        {dirty && (
          <Button size="xs" variant="secondary" onClick={actions.keepMine}>
            Save my version
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={actions.dismiss}>
          Keep editing
        </Button>
      </>
    );
  } else if (tab.reloaded) {
    content = <span>Reloaded: the file changed on disk.</span>;
  } else if (tab.mixedEol) {
    content = (
      <span>This file mixes LF and CRLF line endings; saving uses {tab.eol} for every line.</span>
    );
  }
  if (content === null) return null;
  return (
    <div
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs',
        tab.conflict !== null
          ? 'bg-amber-500/10 text-amber-200'
          : 'text-muted-foreground bg-accent/30',
      )}
      role={tab.conflict !== null ? 'alert' : 'status'}
      data-testid="editor-banner"
    >
      {content}
    </div>
  );
}

function StatusBar({
  tab,
  preferences,
}: {
  tab: EditorTab | null;
  preferences: { tabSize: number; insertSpaces: boolean };
}) {
  if (tab === null || tab.status !== 'ready') return <div className="h-6 shrink-0 border-t" />;
  const encoding = {
    utf8: 'UTF-8',
    utf8bom: 'UTF-8 with BOM',
    utf16le: 'UTF-16 LE',
    utf16be: 'UTF-16 BE',
  }[tab.encoding];
  return (
    <footer
      className="text-muted-foreground flex h-6 shrink-0 items-center gap-3 overflow-hidden border-t px-3 text-[11px] whitespace-nowrap"
      data-testid="editor-status"
    >
      <span className="min-w-0 truncate" title={tab.path}>
        {tab.path}
      </span>
      <span className="ml-auto">
        {tab.readOnly ? 'Read-only' : tab.saving ? 'Saving…' : tab.dirty ? 'Unsaved' : 'Saved'}
      </span>
      <span className="hidden sm:inline">
        {preferences.insertSpaces
          ? `Spaces: ${preferences.tabSize}`
          : `Tab size: ${preferences.tabSize}`}
      </span>
      <span className="hidden sm:inline">{encoding}</span>
      <span>{tab.eol}</span>
    </footer>
  );
}

function EmptyEditor({ onQuickOpen }: { onQuickOpen: () => void }) {
  return (
    <div className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm">
      <p>Open a file from the explorer.</p>
      <Button variant="link" size="sm" onClick={onQuickOpen}>
        Search files by name ({isMac ? '⌘P' : 'Ctrl+P'})
      </Button>
    </div>
  );
}
