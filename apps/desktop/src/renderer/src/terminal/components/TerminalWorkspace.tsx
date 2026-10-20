import type {
  ShellCatalog,
  TerminalPreferences,
  TerminalSession,
  UpdateTerminalPreferencesInput,
} from '@atlas/contracts';
import type { AppCommand } from '@atlas/contracts/ipc';
import { SquareTerminal, TriangleAlert } from 'lucide-react';
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
  removeSession,
  replaceSession,
  setSplitRatio,
  showSession,
  splitActivePane,
  type SplitDirection,
} from '../state/layout';
import { CloseTerminalDialog } from './CloseTerminalDialog';
import { TerminalLayoutView } from './TerminalLayoutView';
import type { TerminalPaneHandle } from './TerminalPane';
import { TerminalTabs } from './TerminalTabs';
import { TerminalToolbar } from './TerminalToolbar';

interface TerminalWorkspaceProps {
  project: ProjectDetails;
  /** Sessions of this project, ordered by creation. */
  sessions: TerminalSession[];
  preferences: TerminalPreferences;
  shells: ShellCatalog | null;
  onSessionChanged: (session: TerminalSession) => void;
  onFontSize: (delta: number | 'reset') => void;
  onPreferences: (changes: UpdateTerminalPreferencesInput) => void;
  /** Subscribes to menu commands while the workspace is shown. */
  subscribeCommands: (handler: (command: AppCommand) => void) => () => void;
}

interface PendingClose {
  session: TerminalSession;
  processName?: string;
}

/** Tabs and split panes of one project. Switching projects never stops processes. */
export function TerminalWorkspace({
  project,
  sessions,
  preferences,
  shells,
  onSessionChanged,
  onFontSize,
  onPreferences,
  subscribeCommands,
}: TerminalWorkspaceProps) {
  const projectId = project.project.id;
  const { layout, update } = useWorkspaceLayout(projectId, sessions);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);
  const handles = useRef(new Map<string, TerminalPaneHandle>());

  const sessionMap = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const panes = useMemo(() => listPanes(layout?.root ?? null), [layout]);
  const visibleSessionIds = useMemo(() => new Set(panes.map((pane) => pane.sessionId)), [panes]);
  const current = layout ? activePane(layout) : undefined;
  const unavailable = project.availability.status !== 'available';

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

  const createTerminal = useCallback(
    async (options: { shellId?: string; split?: SplitDirection } = {}) => {
      if (busy) return;
      setBusy(true);
      const session = await run(() =>
        unwrap(
          api().terminals.create({
            projectId,
            ...(options.shellId !== undefined ? { shellId: options.shellId } : {}),
          }),
        ),
      );
      setBusy(false);
      if (session === undefined) return;
      onSessionChanged(session);
      update((value) =>
        options.split
          ? splitActivePane(value, options.split, session.id, newLayoutId)
          : showSession(value, session.id, newLayoutId),
      );
    },
    [busy, onSessionChanged, projectId, run, update],
  );

  const dismiss = useCallback(
    async (sessionId: string) => {
      // Show another hidden terminal in the freed pane, if any.
      const hidden = sessions.filter(
        (session) => session.id !== sessionId && !visibleSessionIds.has(session.id),
      );
      const replacement = hidden.at(-1)?.id;
      const result = await run(() => unwrap(api().terminals.dismiss(sessionId)));
      if (result === undefined) return;
      update((value) => removeSession(value, sessionId, replacement));
    },
    [run, sessions, update, visibleSessionIds],
  );

  /** Closing a tab terminates the process; asks first when a program is running. */
  const requestClose = useCallback(
    async (sessionId: string) => {
      const session = sessionMap.get(sessionId);
      if (session === undefined) return;
      const info = await run(() => unwrap(api().terminals.closeInfo(sessionId)));
      if (info === undefined) return;
      if (info.requiresConfirmation) {
        setPendingClose({
          session,
          ...(info.processName !== undefined ? { processName: info.processName } : {}),
        });
      } else {
        await dismiss(sessionId);
      }
    },
    [dismiss, run, sessionMap],
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
    async (sessionId: string, title: string) => {
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
        if (!unavailable) void createTerminal();
        break;
      case 'terminal.close':
        if (current) void requestClose(current.sessionId);
        break;
      case 'terminal.next':
        cycleTab(1);
        break;
      case 'terminal.previous':
        cycleTab(-1);
        break;
      case 'terminal.splitRight':
      case 'terminal.splitDown':
        if (!unavailable && layout && canSplit(layout)) {
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
      aria-label={`Terminals of ${project.project.name}`}
      data-testid="terminal-workspace"
      data-project-id={projectId}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
        <TerminalTabs
          sessions={sessions}
          activeSessionId={current?.sessionId}
          visibleSessionIds={visibleSessionIds}
          renamingId={renamingId}
          onSelect={(sessionId) => update((value) => showSession(value, sessionId, newLayoutId))}
          onClose={(sessionId) => void requestClose(sessionId)}
          onStartRename={setRenamingId}
          onRename={(sessionId, title) => void rename(sessionId, title)}
          onCancelRename={() => setRenamingId(null)}
        />
        <TerminalToolbar
          shells={shells}
          preferences={preferences}
          canSplit={layout !== null && layout.root !== null && canSplit(layout)}
          hasSplit={panes.length > 1}
          disabled={busy || unavailable}
          onNewTerminal={(shellId) => void createTerminal(shellId !== undefined ? { shellId } : {})}
          onSplit={(direction) => void createTerminal({ split: direction })}
          onSinglePane={() => update(collapseToActivePane)}
          onFontSize={onFontSize}
          onPreferences={onPreferences}
        />
      </header>

      {(error || unavailable) && (
        <Alert
          variant={error ? 'destructive' : 'default'}
          className="m-2 w-auto"
          role="alert"
          data-testid="terminal-error"
        >
          <TriangleAlert />
          <AlertDescription>
            {error ??
              'The project directory is unavailable. Update it in Projects to open terminals.'}
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
                <h2 className="text-lg font-semibold">No terminals in {project.project.name}</h2>
                <p className="text-muted-foreground max-w-sm">
                  Terminals start in the project directory and keep running while you switch
                  projects.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground max-w-sm">
                Every terminal of this project is hidden. Select a tab to show it.
              </p>
            )}
            <Button disabled={busy || unavailable} onClick={() => void createTerminal()}>
              New terminal
            </Button>
          </div>
        ) : (
          <TerminalLayoutView
            node={layout.root}
            sessions={sessionMap}
            preferences={preferences}
            activePaneId={current?.id ?? null}
            paneCount={panes.length}
            onFocusPane={(paneId) =>
              update((value) => (value.activePaneId === paneId ? value : focusPane(value, paneId)))
            }
            onHidePane={(paneId) => update((value) => closePane(value, paneId))}
            onRestart={(sessionId) => void restart(sessionId)}
            onCloseTab={(sessionId) => void requestClose(sessionId)}
            onRatio={(splitId, ratio) => update((value) => setSplitRatio(value, splitId, ratio))}
            registerHandle={registerHandle}
          />
        )}
      </div>

      {pendingClose && (
        <CloseTerminalDialog
          session={pendingClose.session}
          {...(pendingClose.processName !== undefined
            ? { processName: pendingClose.processName }
            : {})}
          onCancel={() => setPendingClose(null)}
          onConfirm={() => {
            const { session } = pendingClose;
            setPendingClose(null);
            void dismiss(session.id);
          }}
        />
      )}
    </section>
  );
}
