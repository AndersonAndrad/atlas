import type {
  ShellCatalog,
  TerminalPreferences,
  TerminalSession,
  UpdateTerminalPreferencesInput,
} from '@atlas/contracts';
import type { AppCommand } from '@atlas/contracts/ipc';
import { Info, SquareTerminal, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { ProjectDetails } from '@/types';
import { newLayoutId, useWorkspaceLayout } from '../hooks/useWorkspaceLayout';
import {
  activePane,
  canSplit,
  closePane,
  collapseToActivePane,
  focusAdjacentPane,
  focusPane,
  listPanes,
  replaceSession,
  setSplitRatio,
  showSession,
  splitActivePane,
  type SplitDirection,
} from '../state/layout';
import { TerminalLayoutView } from './TerminalLayoutView';
import type { TerminalContextAction, TerminalPaneHandle } from './TerminalPane';
import { TerminalTabs } from './TerminalTabs';
import { TerminalToolbar, type NewTerminalOptions } from './TerminalToolbar';

export interface TerminalWorkspaceInfo {
  /** Group id or `ungrouped`. */
  key: string;
  name: string;
  groupId: string | null;
}

interface TerminalWorkspaceProps {
  workspace: TerminalWorkspaceInfo;
  /** Terminals of this workspace, in group order. */
  sessions: TerminalSession[];
  projects: ProjectDetails[];
  preferences: TerminalPreferences;
  shells: ShellCatalog | null;
  /** A terminal to bring into view (e.g. selected in the sidebar). */
  focusRequest: { sessionId: string; nonce: number } | null;
  onSessionChanged: (session: TerminalSession) => void;
  /** Closes a terminal, asking first when a program is running. */
  onRequestClose: (sessionId: string) => void;
  onProjectInfo: (sessionId: string) => void;
  onOpenGit: (sessionId: string) => void;
  onOpenPreflight: (sessionId: string) => void;
  onContextAction: (sessionId: string, action: TerminalContextAction) => void;
  onFontSize: (delta: number | 'reset') => void;
  onPreferences: (changes: UpdateTerminalPreferencesInput) => void;
  /** Subscribes to menu commands while the workspace is shown. */
  subscribeCommands: (handler: (command: AppCommand) => void) => () => void;
}

/**
 * Tabs and split panes of one workspace. Terminals of any project (or none) can
 * share a workspace; switching workspaces never stops processes.
 */
export function TerminalWorkspace({
  workspace,
  sessions,
  projects,
  preferences,
  shells,
  focusRequest,
  onSessionChanged,
  onRequestClose,
  onProjectInfo,
  onOpenGit,
  onOpenPreflight,
  onContextAction,
  onFontSize,
  onPreferences,
  subscribeCommands,
}: TerminalWorkspaceProps) {
  const { layout, update } = useWorkspaceLayout(workspace.key, sessions);
  const [error, setError] = useState<string | null>(null);
  /** Where a split opened when it could not use the source terminal's folder (Task A01). */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const handles = useRef(new Map<string, TerminalPaneHandle>());

  const sessionMap = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const projectNames = useMemo(
    () => new Map(projects.map((item) => [item.project.id, item.project.name])),
    [projects],
  );
  const panes = useMemo(() => listPanes(layout?.root ?? null), [layout]);
  const visibleSessionIds = useMemo(() => new Set(panes.map((pane) => pane.sessionId)), [panes]);
  const current = layout ? activePane(layout) : undefined;

  const registerHandle = useCallback((paneId: string, handle: TerminalPaneHandle | null) => {
    if (handle === null) handles.current.delete(paneId);
    else handles.current.set(paneId, handle);
  }, []);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(errorMessage(caught));
      return undefined;
    }
  }, []);

  // Bring a terminal selected elsewhere (sidebar) into the active pane — once per
  // request, so later session changes never pull it back.
  const handledFocus = useRef<number | null>(null);
  useEffect(() => {
    if (focusRequest === null || handledFocus.current === focusRequest.nonce) return;
    if (!sessionMap.has(focusRequest.sessionId)) return;
    handledFocus.current = focusRequest.nonce;
    update((value) => showSession(value, focusRequest.sessionId, newLayoutId));
  }, [focusRequest, sessionMap, update]);

  const createTerminal = useCallback(
    async (options: NewTerminalOptions & { split?: SplitDirection } = {}) => {
      if (busy) return;
      setNotice(null);
      // A split continues the active terminal: same project, folder, group and shell.
      const fromSessionId = options.split ? current?.sessionId : undefined;
      let cwd: string | undefined;
      if (options.chooseFolder) {
        const choice = await run(() => unwrap(api().dialog.chooseDirectory('terminal')));
        if (!choice || choice.canceled || !choice.inspection) return;
        cwd = choice.inspection.inputPath;
      }
      setBusy(true);
      const session = await run(() =>
        unwrap(
          api().terminals.create(
            fromSessionId !== undefined
              ? { fromSessionId }
              : {
                  ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
                  ...(cwd !== undefined ? { cwd } : {}),
                  ...(options.shellId !== undefined ? { shellId: options.shellId } : {}),
                  ...(workspace.groupId !== null ? { groupId: workspace.groupId } : {}),
                },
          ),
        ),
      );
      setBusy(false);
      if (session === undefined) return;
      if (session.splitFallbackFrom !== undefined) {
        setNotice(
          `${session.splitFallbackFrom} is not available here, so the new terminal opened in ${session.cwd}.`,
        );
      }
      onSessionChanged(session);
      update((value) =>
        options.split
          ? splitActivePane(value, options.split, session.id, newLayoutId)
          : showSession(value, session.id, newLayoutId),
      );
    },
    [busy, current?.sessionId, onSessionChanged, run, update, workspace.groupId],
  );

  const restart = useCallback(
    async (sessionId: string) => {
      const next = await run(() => unwrap(api().terminals.restart(sessionId)));
      if (next === undefined) return;
      onSessionChanged(next);
      update((value) => replaceSession(value, sessionId, next.id));
    },
    [onSessionChanged, run, update],
  );

  const rename = useCallback(
    async (sessionId: string, title: string | null) => {
      setRenamingId(null);
      const renamed = await run(() => unwrap(api().terminals.rename(sessionId, title)));
      if (renamed) onSessionChanged(renamed);
    },
    [onSessionChanged, run],
  );

  const cycleTab = useCallback(
    (offset: 1 | -1) => {
      if (sessions.length === 0) return;
      const index = sessions.findIndex((session) => session.id === current?.sessionId);
      const next = sessions[(index + offset + sessions.length) % sessions.length]!;
      update((value) => showSession(value, next.id, newLayoutId));
    },
    [current?.sessionId, sessions, update],
  );

  const activeHandle = () => (current ? handles.current.get(current.id) : undefined);

  const handleCommand = (command: AppCommand) => {
    switch (command) {
      case 'terminal.new':
        void createTerminal();
        break;
      case 'terminal.close':
        if (current) onRequestClose(current.sessionId);
        break;
      case 'terminal.next':
        cycleTab(1);
        break;
      case 'terminal.previous':
        cycleTab(-1);
        break;
      case 'terminal.splitRight':
      case 'terminal.splitDown':
        if (layout && canSplit(layout)) {
          void createTerminal({ split: command === 'terminal.splitRight' ? 'row' : 'column' });
        }
        break;
      case 'terminal.focusNextPane':
        update((value) => focusAdjacentPane(value, 1));
        break;
      case 'terminal.focusPreviousPane':
        update((value) => focusAdjacentPane(value, -1));
        break;
      case 'terminal.search':
        activeHandle()?.openSearch();
        break;
      case 'terminal.clear':
        activeHandle()?.clear();
        break;
      case 'terminal.fontIncrease':
        onFontSize(1);
        break;
      case 'terminal.fontDecrease':
        onFontSize(-1);
        break;
      case 'terminal.fontReset':
        onFontSize('reset');
        break;
      default:
        break;
    }
  };
  const commandRef = useRef(handleCommand);
  useEffect(() => {
    commandRef.current = handleCommand;
  });
  useEffect(() => subscribeCommands((command) => commandRef.current(command)), [subscribeCommands]);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={`Terminals: ${workspace.name}`}
      data-testid="terminal-workspace"
      data-workspace={workspace.key}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
        <TerminalTabs
          sessions={sessions}
          activeSessionId={current?.sessionId}
          visibleSessionIds={visibleSessionIds}
          renamingId={renamingId}
          onSelect={(sessionId) => update((value) => showSession(value, sessionId, newLayoutId))}
          onClose={onRequestClose}
          onStartRename={setRenamingId}
          onRename={(sessionId, title) => void rename(sessionId, title)}
          onCancelRename={() => setRenamingId(null)}
        />
        <TerminalToolbar
          shells={shells}
          projects={projects}
          preferences={preferences}
          canSplit={layout !== null && layout.root !== null && canSplit(layout)}
          hasSplit={panes.length > 1}
          disabled={busy}
          onNewTerminal={(options) => void createTerminal(options)}
          onSplit={(direction) => void createTerminal({ split: direction })}
          onSinglePane={() => update(collapseToActivePane)}
          onFontSize={onFontSize}
          onPreferences={onPreferences}
        />
      </header>

      {error && (
        <Alert
          variant="destructive"
          className="m-2 w-auto"
          role="alert"
          data-testid="terminal-error"
        >
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {notice && (
        <Alert className="m-2 w-auto" role="status" data-testid="terminal-split-notice">
          <Info />
          <AlertDescription className="flex items-center gap-2">
            <span className="min-w-0 flex-1">{notice}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
            >
              <X />
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="min-h-0 flex-1 p-1">
        {layout === null ? null : layout.root === null ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
            data-testid="terminal-empty-state"
          >
            <SquareTerminal className="text-muted-foreground size-10" aria-hidden="true" />
            {sessions.length === 0 ? (
              <>
                <h2 className="text-lg font-semibold">No terminals in {workspace.name}</h2>
                <p className="text-muted-foreground max-w-sm">
                  Open a terminal in your default directory, a folder or a project. Terminals keep
                  running while you switch groups and projects.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground max-w-sm">
                Every terminal here is hidden. Select a tab to show it.
              </p>
            )}
            <Button disabled={busy} onClick={() => void createTerminal()}>
              New terminal
            </Button>
          </div>
        ) : (
          <TerminalLayoutView
            node={layout.root}
            sessions={sessionMap}
            projectNames={projectNames}
            preferences={preferences}
            activePaneId={current?.id ?? null}
            paneCount={panes.length}
            onFocusPane={(paneId) =>
              update((value) => (value.activePaneId === paneId ? value : focusPane(value, paneId)))
            }
            onHidePane={(paneId) => update((value) => closePane(value, paneId))}
            onRestart={(sessionId) => void restart(sessionId)}
            onCloseTab={onRequestClose}
            onProjectInfo={onProjectInfo}
            onOpenGit={onOpenGit}
            onOpenPreflight={onOpenPreflight}
            onContextAction={onContextAction}
            onRatio={(splitId, ratio) => update((value) => setSplitRatio(value, splitId, ratio))}
            registerHandle={registerHandle}
          />
        )}
      </div>
    </section>
  );
}
