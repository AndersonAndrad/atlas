import type { AtlasNotification } from '@atlas/contracts';
import type { AppCommand } from '@atlas/contracts/ipc';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, unwrap } from './api';
import { AboutDialog } from './components/AboutDialog';
import { ProjectsView } from './components/ProjectsView';
import { SettingsView } from './components/SettingsView';
import { GitView, type GitOpenRequest } from './git/components/GitView';
import { ContextView, type ContextOpenRequest } from './context/components/ContextView';
import { SkillsView } from './skills/components/SkillsView';
import { UsageView } from './usage/components/UsageView';
import { PreflightView, type PreflightOpenRequest } from './preflight/components/PreflightView';
import { QuickCommandsView } from './quick-commands/components/QuickCommandsView';
import { NotificationCenter } from './notifications/components/NotificationCenter';
import { Toaster } from './notifications/components/Toaster';
import { useNotifications } from './notifications/useNotifications';
import { Button } from './components/ui/button';
import { Sidebar, type AppView } from './components/Sidebar';
import { TooltipProvider } from './components/ui/tooltip';
import { useAppInfo, versionLabel } from './hooks/useAppInfo';
import { useProjects } from './hooks/useProjects';
import { SessionsView } from './sessions/components/SessionsView';
import { TerminalsView } from './terminal/components/TerminalsView';
import { useTerminalGroups } from './terminal/hooks/useTerminalGroups';
import { useTerminalPreferences } from './terminal/hooks/useTerminalPreferences';
import { runningSessionCount, useTerminalSessions } from './terminal/hooks/useTerminalSessions';

type CommandHandler = (command: AppCommand) => void;

export function App() {
  const [view, setView] = useState<AppView>('projects');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [openRequest, setOpenRequest] = useState<{ projectId: string; nonce: number } | null>(null);
  const [sessionRequest, setSessionRequest] = useState<{
    projectId: string | null;
    nonce: number;
  } | null>(null);
  const [gitRequest, setGitRequest] = useState<GitOpenRequest | null>(null);
  const [contextRequest, setContextRequest] = useState<ContextOpenRequest | null>(null);
  const [preflightRequest, setPreflightRequest] = useState<PreflightOpenRequest | null>(null);
  const projects = useProjects();
  const terminals = useTerminalSessions();
  const groups = useTerminalGroups();
  const preferences = useTerminalPreferences();
  const info = useAppInfo();
  const notifications = useNotifications();
  /** Shown when a notification's target no longer exists (FR-908). */
  const [notice, setNotice] = useState<string | null>(null);

  // Menu commands go to the terminal workspace while it is shown. A command that
  // opens a terminal from another view switches to Terminals and is replayed there.
  const handlers = useRef(new Set<CommandHandler>());
  const pendingCommand = useRef<AppCommand | null>(null);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const subscribeCommands = useCallback((handler: CommandHandler) => {
    handlers.current.add(handler);
    const pending = pendingCommand.current;
    if (pending !== null) {
      pendingCommand.current = null;
      queueMicrotask(() => handler(pending));
    }
    return () => {
      handlers.current.delete(handler);
    };
  }, []);

  useEffect(
    () =>
      api().app.onCommand((command) => {
        switch (command) {
          case 'view.projects':
            setView('projects');
            return;
          case 'view.terminals':
            setView('terminals');
            return;
          case 'view.sessions':
            setView('sessions');
            return;
          case 'view.git':
            setView('git');
            return;
          case 'app.settings':
            setView('settings');
            return;
          case 'app.about':
            setAboutOpen(true);
            return;
          default:
            break;
        }
        if (viewRef.current === 'terminals') {
          for (const handler of handlers.current) handler(command);
        } else if (command === 'terminal.new') {
          pendingCommand.current = command;
          setView('terminals');
        }
      }),
    [],
  );

  const openTerminal = (projectId: string) => {
    void projects.select(projectId);
    setOpenRequest({ projectId, nonce: Date.now() });
    setView('terminals');
  };

  const clearOpenRequest = useCallback(() => setOpenRequest(null), []);
  const clearGitRequest = useCallback(() => setGitRequest(null), []);
  const clearContextRequest = useCallback(() => setContextRequest(null), []);
  const openContext = (request: Omit<ContextOpenRequest, 'nonce'>) => {
    setContextRequest({ ...request, nonce: Date.now() });
    setView('context');
  };
  const openGit = (target: Omit<GitOpenRequest, 'nonce'>) => {
    setGitRequest({ ...target, nonce: Date.now() });
    setView('git');
  };
  const clearSessionRequest = useCallback(() => setSessionRequest(null), []);
  const clearPreflightRequest = useCallback(() => setPreflightRequest(null), []);
  const openPreflight = (target: Omit<PreflightOpenRequest, 'nonce'>) => {
    setPreflightRequest({ ...target, nonce: Date.now() });
    setView('preflight');
  };

  /** Opens what a notification is about, after checking it still exists. */
  const openNotification = async (notification: AtlasNotification) => {
    setNotice(null);
    if (!notification.read) void notifications.markRead(notification.id);
    const action = notification.action;
    if (action === null) return;
    try {
      if (action.type === 'git-operation') {
        const repositories = await unwrap(api().git.repositories());
        if (!repositories.some((entry) => entry.repositoryRoot === action.repositoryRoot)) {
          setNotice('The repository of this notification is no longer available in ATLAS.');
          return;
        }
        openGit({ repositoryRoot: action.repositoryRoot, operations: true });
        return;
      }
      await unwrap(api().preflight.run(action.runId));
      openPreflight({ workspaceId: action.workspaceId, runId: action.runId });
    } catch {
      setNotice('What this notification refers to no longer exists.');
    }
  };

  const newSession = (projectId: string) => {
    setSessionRequest({ projectId, nonce: Date.now() });
    setView('sessions');
  };

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full min-w-0">
        <Sidebar
          view={view}
          onNavigate={setView}
          version={info ? versionLabel(info) : null}
          onAbout={() => setAboutOpen(true)}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            className="flex h-10 shrink-0 items-center justify-end gap-2 border-b px-3"
            data-testid="app-bar"
          >
            {notice && (
              <p
                className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs"
                role="alert"
                data-testid="app-notice"
              >
                <span className="truncate">{notice}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Dismiss message"
                  onClick={() => setNotice(null)}
                >
                  <X />
                </Button>
              </p>
            )}
            <NotificationCenter state={notifications} onOpen={openNotification} />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1">
            {view === 'projects' && (
              <ProjectsView
                projects={projects}
                runningTerminals={(projectId) => runningSessionCount(terminals.sessions, projectId)}
                onOpenTerminal={openTerminal}
                onNewSession={newSession}
                onOpenGit={(projectId) => openGit({ projectId })}
                onOpenContext={(projectId) => openContext({ projectId, action: 'view' })}
                onOpenPreflight={(projectId) => openPreflight({ projectId })}
                onProjectRemoved={() => void terminals.reload()}
              />
            )}
            {view === 'terminals' && (
              <TerminalsView
                projects={projects}
                terminals={terminals}
                groups={groups}
                preferences={preferences}
                openRequest={openRequest}
                onOpenRequestHandled={clearOpenRequest}
                subscribeCommands={subscribeCommands}
                onOpenGit={(terminalId) => openGit({ terminalId })}
                onOpenPreflight={(terminalId) => openPreflight({ terminalId })}
                onContextAction={(terminalId, { action, provider }) =>
                  openContext({ terminalId, action, ...(provider ? { provider } : {}) })
                }
              />
            )}
            {view === 'git' && (
              <GitView
                request={gitRequest}
                onRequestHandled={clearGitRequest}
                onOpenPreflight={(projectId) => openPreflight({ projectId })}
              />
            )}
            {view === 'preflight' && (
              <PreflightView
                projects={projects.items ?? []}
                request={preflightRequest}
                onRequestHandled={clearPreflightRequest}
              />
            )}
            {view === 'context' && (
              <ContextView
                projects={projects.items ?? []}
                request={contextRequest}
                onRequestHandled={clearContextRequest}
                onAiStarted={() => {
                  void terminals.reload();
                  setView('terminals');
                }}
              />
            )}
            {view === 'sessions' && (
              <SessionsView
                projects={projects}
                createRequest={sessionRequest}
                onCreateRequestHandled={clearSessionRequest}
                onOpenPreflight={(projectId) => openPreflight({ projectId })}
              />
            )}
            {view === 'skills' && <SkillsView projects={projects.items ?? []} />}
            {view === 'quick-commands' && <QuickCommandsView />}
            {view === 'usage' && <UsageView />}
            {view === 'settings' && <SettingsView preferences={preferences} />}
          </div>
        </div>
      </div>
      <Toaster
        toasts={notifications.toasts}
        onOpen={(notification) => void openNotification(notification)}
        onDismiss={notifications.dismissToast}
      />
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </TooltipProvider>
  );
}
