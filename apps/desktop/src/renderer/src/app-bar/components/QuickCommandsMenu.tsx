import { quickCommandAvailableIn, type ProjectAction } from '@atlas/contracts';
import { Play, Settings2, Zap } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ProjectDetails } from '@/types';
import { projectTerminalReason } from '../state/project-toolbar';

type ProjectCommandAction = Extract<ProjectAction, { kind: 'run-command' }>;

interface QuickCommandsMenuProps {
  selected: ProjectDetails | null;
  /**
   * Runs the command in a new terminal of the project, as the Projects drawer does; without
   * a project (null), a command of all projects runs in a terminal in the default folder.
   */
  onRun: (projectId: string | null, commandId: string) => void;
  onManage: () => void;
}

/**
 * The selected project's quick commands in the upper toolbar (SDD-023 Task A05); without a
 * project, the commands of all projects (SDD-025 Task 03). They are read from the Engine
 * each time the menu opens, so they are never outdated; opening the menu runs nothing.
 */
export function QuickCommandsMenu({ selected, onRun, onManage }: QuickCommandsMenuProps) {
  const [commands, setCommands] = useState<ProjectCommandAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const loadToken = useRef(0);
  const reason = selected === null ? null : projectTerminalReason(selected);

  const load = (projectId: string | null) => {
    const token = ++loadToken.current;
    setCommands(null);
    setError(null);
    const request: Promise<ProjectCommandAction[]> =
      projectId === null
        ? unwrap(api().quickCommands.list()).then((list) =>
            list
              .filter((command) => quickCommandAvailableIn(command, null))
              .map((command) => ({
                kind: 'run-command' as const,
                commandId: command.id,
                name: command.name,
                command: command.command,
              })),
          )
        : unwrap(api().quickCommands.projectActions(projectId)).then((actions) =>
            actions.filter(
              (action): action is ProjectCommandAction => action.kind === 'run-command',
            ),
          );
    request.then(
      (list) => {
        if (token === loadToken.current) setCommands(list);
      },
      (caught: unknown) => {
        if (token === loadToken.current) setError(errorMessage(caught));
      },
    );
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) load(selected?.project.id ?? null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2"
          aria-label="Quick commands"
          data-testid="toolbar-quick-commands"
        >
          <Zap aria-hidden="true" />
          <span className="hidden sm:inline">Quick commands</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-72"
        data-testid="toolbar-quick-commands-menu"
        onCloseAutoFocus={(event) => {
          const action = pending.current;
          pending.current = null;
          if (action === null) return;
          event.preventDefault();
          action();
        }}
      >
        <DropdownMenuLabel className="text-muted-foreground truncate text-xs">
          {selected ? selected.project.name : 'No project selected'}
        </DropdownMenuLabel>
        {selected === null && (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">
            Commands for all projects; they open a terminal in the default folder.
          </p>
        )}
        {error !== null ? (
          <p className="text-destructive px-2 py-1.5 text-xs" role="alert">
            {error}
          </p>
        ) : commands === null ? (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">Loading…</p>
        ) : commands.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">
            {selected === null
              ? 'No quick commands for all projects.'
              : 'No quick commands for this project.'}
          </p>
        ) : (
          commands.map((command) => (
            <DropdownMenuItem
              key={command.commandId}
              disabled={reason !== null}
              onSelect={() => {
                pending.current = () => onRun(selected?.project.id ?? null, command.commandId);
              }}
              className="items-start"
              data-testid="toolbar-quick-command"
            >
              <Play className="mt-0.5" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{command.name}</span>
                <span className="text-muted-foreground truncate font-mono text-[11px]">
                  {reason ?? command.command}
                </span>
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            pending.current = onManage;
          }}
          data-testid="toolbar-quick-commands-manage"
        >
          <Settings2 />
          Manage quick commands…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
