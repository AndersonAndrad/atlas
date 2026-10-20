import type { AppCommand } from '@atlas/contracts/ipc';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ProjectsView } from './components/ProjectsView';
import { Sidebar, type AppView } from './components/Sidebar';
import { TooltipProvider } from './components/ui/tooltip';
import { useProjects } from './hooks/useProjects';
import { TerminalsView } from './terminal/components/TerminalsView';
import { useTerminalPreferences } from './terminal/hooks/useTerminalPreferences';
import { runningSessionCount, useTerminalSessions } from './terminal/hooks/useTerminalSessions';

type CommandHandler = (command: AppCommand) => void;

export function App() {
  const [view, setView] = useState<AppView>('projects');
  const projects = useProjects();
  const terminals = useTerminalSessions();
  const preferences = useTerminalPreferences();

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
        if (command === 'view.projects' || command === 'view.terminals') {
          setView(command === 'view.projects' ? 'projects' : 'terminals');
          return;
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
    if (runningSessionCount(terminals.sessions, projectId) === 0) {
      pendingCommand.current = 'terminal.new';
    }
    void projects.select(projectId);
    setView('terminals');
  };

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full min-w-0">
        <Sidebar view={view} onNavigate={setView} />
        {view === 'projects' ? (
          <ProjectsView
            projects={projects}
            runningTerminals={(projectId) => runningSessionCount(terminals.sessions, projectId)}
            onOpenTerminal={openTerminal}
            onProjectRemoved={() => void terminals.reload()}
          />
        ) : (
          <TerminalsView
            projects={projects}
            terminals={terminals}
            preferences={preferences}
            subscribeCommands={subscribeCommands}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
