import type { ShellCatalog } from '@atlas/contracts';
import type { AppCommand } from '@atlas/contracts/ipc';
import { useEffect, useState } from 'react';
import { api, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { useProjects } from '@/hooks/useProjects';
import { cn } from '@/lib/utils';
import type { useTerminalPreferences } from '../hooks/useTerminalPreferences';
import { runningSessionCount, type TerminalSessionsState } from '../hooks/useTerminalSessions';
import { TerminalWorkspace } from './TerminalWorkspace';

interface TerminalsViewProps {
  projects: ReturnType<typeof useProjects>;
  terminals: TerminalSessionsState;
  preferences: ReturnType<typeof useTerminalPreferences>;
  subscribeCommands: (handler: (command: AppCommand) => void) => () => void;
}

/** Multi-project terminal environment: one workspace per project, all running at once. */
export function TerminalsView({
  projects,
  terminals,
  preferences,
  subscribeCommands,
}: TerminalsViewProps) {
  const { items, selected, select } = projects;
  const [shells, setShells] = useState<ShellCatalog | null>(null);

  useEffect(() => {
    unwrap(api().terminals.shells()).then(setShells, () => setShells(null));
  }, [preferences.preferences?.defaultShellId]);

  const sessions = terminals.sessions ?? [];

  return (
    <main className="flex min-h-0 min-w-0 flex-1">
      <aside
        className="hidden w-56 shrink-0 flex-col border-r md:flex"
        aria-label="Projects with terminals"
      >
        <h1 className="flex h-11 shrink-0 items-center border-b px-3 text-sm font-semibold">
          Terminals
        </h1>
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {(items ?? []).map((item) => {
            const count = runningSessionCount(terminals.sessions, item.project.id);
            const active = item.project.id === selected?.project.id;
            return (
              <li key={item.project.id}>
                <button
                  type="button"
                  className={cn(
                    'hover:bg-accent/60 focus-visible:ring-ring/50 flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm outline-none focus-visible:ring-[3px]',
                    active && 'bg-accent font-medium',
                  )}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => void select(item.project.id)}
                  data-testid="terminal-project"
                  data-project-id={item.project.id}
                >
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      item.availability.status === 'available' ? 'bg-success' : 'bg-warning',
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate">{item.project.name}</span>
                  {count > 0 && (
                    <Badge
                      variant="secondary"
                      className="ml-auto"
                      aria-label={`${count} running`}
                      data-testid="running-count"
                    >
                      {count}
                    </Badge>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Compact project switcher for narrow windows. */}
        <div className="border-b p-2 md:hidden">
          <Select value={selected?.project.id ?? ''} onValueChange={(id) => void select(id)}>
            <SelectTrigger className="w-full" aria-label="Project">
              <SelectValue placeholder="Select a project" />
            </SelectTrigger>
            <SelectContent>
              {(items ?? []).map((item) => (
                <SelectItem key={item.project.id} value={item.project.id}>
                  {item.project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {terminals.error && (
          <Alert variant="destructive" className="m-2 w-auto" role="alert">
            <AlertDescription>{terminals.error}</AlertDescription>
          </Alert>
        )}

        {items !== null && items.length === 0 && (
          <p className="text-muted-foreground p-8 text-center">
            Register a project in Projects to open terminals.
          </p>
        )}
        {items !== null && items.length > 0 && selected === null && (
          <p className="text-muted-foreground p-8 text-center">Select a project.</p>
        )}

        {selected && terminals.sessions !== null && preferences.preferences !== null && (
          <TerminalWorkspace
            // Remount per project and after an Engine restart: views reattach from Engine state.
            key={`${selected.project.id}:${terminals.epoch}`}
            project={selected}
            sessions={sessions.filter((s) => s.projectId === selected.project.id)}
            preferences={preferences.preferences}
            shells={shells}
            onSessionChanged={terminals.upsert}
            onFontSize={preferences.changeFontSize}
            onPreferences={(changes) => void preferences.update(changes)}
            subscribeCommands={subscribeCommands}
          />
        )}
      </div>
    </main>
  );
}
