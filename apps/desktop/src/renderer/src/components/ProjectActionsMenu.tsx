import type { ProjectAction } from '@atlas/contracts';
import { Ellipsis, Play, SquareTerminal } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
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

interface ProjectActionsMenuProps {
  projectId: string;
  projectName: string;
  disabled?: boolean;
  /** The button that opens the menu; a small "…" (options) icon button by default. */
  trigger?: ReactNode;
  onOpenTerminal: () => void;
  onRunCommand: (commandId: string) => void;
}

/**
 * The actions of a project (PLAN-023): open a terminal, then its quick commands. Read
 * from the Engine each time the menu opens, so it never shows outdated commands.
 */
export function ProjectActionsMenu({
  projectId,
  projectName,
  disabled,
  trigger,
  onOpenTerminal,
  onRunCommand,
}: ProjectActionsMenuProps) {
  const [actions, setActions] = useState<ProjectAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // An action opens a terminal that takes the focus. It runs once the menu has closed, so
  // the menu neither keeps the focus while closing nor gives it back to its button.
  const pending = useRef<(() => void) | null>(null);

  function load(open: boolean) {
    if (!open) return;
    pending.current = null;
    setError(null);
    unwrap(api().quickCommands.projectActions(projectId)).then(setActions, (caught: unknown) => {
      setActions(null);
      setError(errorMessage(caught));
    });
  }

  const commands = (actions ?? []).filter(
    (action): action is Extract<ProjectAction, { kind: 'run-command' }> =>
      action.kind === 'run-command',
  );

  return (
    <DropdownMenu onOpenChange={load}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        {trigger ?? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Project actions for ${projectName}`}
            title="Project actions"
          >
            <Ellipsis data-icon="ellipsis" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64"
        data-testid="project-actions-menu"
        onCloseAutoFocus={(event) => {
          const action = pending.current;
          if (action === null) return;
          event.preventDefault();
          pending.current = null;
          action();
        }}
      >
        <DropdownMenuLabel className="truncate">{projectName}</DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => {
            pending.current = onOpenTerminal;
          }}
        >
          <SquareTerminal />
          Open terminal
        </DropdownMenuItem>
        {commands.length > 0 && <DropdownMenuSeparator />}
        {commands.map((action) => (
          <DropdownMenuItem
            key={action.commandId}
            onSelect={() => {
              pending.current = () => onRunCommand(action.commandId);
            }}
            title={action.command}
            data-testid="project-action-command"
          >
            <Play />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{action.name}</span>
              <code className="text-muted-foreground truncate font-mono text-[11px]">
                {action.command}
              </code>
            </span>
          </DropdownMenuItem>
        ))}
        {error && (
          <p className="text-destructive px-2 py-1.5 text-xs" role="alert">
            {error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
