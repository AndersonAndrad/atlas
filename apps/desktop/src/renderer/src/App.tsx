import type { AppCommand } from '@atlas/contracts/ipc';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { AboutDialog } from './components/AboutDialog';
import { ProjectsView } from './components/ProjectsView';
import { SettingsView } from './components/SettingsView';
import { GitView, type GitOpenRequest } from './git/components/GitView';
import { ContextView, type ContextOpenRequest } from './context/components/ContextView';
import { SkillsView } from './skills/components/SkillsView';
import { QuickCommandsView } from './quick-commands/components/QuickCommandsView';
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
  const projects = useProjects();
  const terminals = useTerminalSessions();
  const groups = useTerminalGroups();
  const preferences = useTerminalPreferences();
  const info = useAppInfo();

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
        {view === 'projects' && (
          <ProjectsView
            projects={projects}
            runningTerminals={(projectId) => runningSessionCount(terminals.sessions, projectId)}
            onOpenTerminal={openTerminal}
            onNewSession={newSession}
            onOpenGit={(projectId) => openGit({ projectId })}
            onOpenContext={(projectId) => openContext({ projectId, action: 'view' })}
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
            onContextAction={(terminalId, { action, provider }) =>
              openContext({ terminalId, action, ...(provider ? { provider } : {}) })
            }
          />
        )}
        {view === 'git' && <GitView request={gitRequest} onRequestHandled={clearGitRequest} />}
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
          />
        )}
        {view === 'skills' && <SkillsView projects={projects.items ?? []} />}
        {view === 'quick-commands' && <QuickCommandsView />}
        {view === 'settings' && <SettingsView preferences={preferences} />}
      </div>
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </TooltipProvider>
  );
}
