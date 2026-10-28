import {
  FolderPlus,
  Layers,
  Plus,
  SquarePlus,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ProjectDetails } from '@/types';
import { projectTerminalReason } from '../state/project-toolbar';

const isMac = navigator.userAgent.includes('Mac');

interface NewMenuProps {
  selected: ProjectDetails | null;
  onNewTerminal: () => void;
  onNewProjectTerminal: (projectId: string) => void;
  onNewProject: () => void;
  onNewGroup: () => void;
}

/**
 * Creation actions of the upper toolbar (SDD-023 Task A05), through the flows ATLAS already
 * has: the New terminal command, a terminal in a project, the project form and the terminal
 * group dialog. The chosen action runs once the menu closed, so what it opens keeps focus.
 */
export function NewMenu({
  selected,
  onNewTerminal,
  onNewProjectTerminal,
  onNewProject,
  onNewGroup,
}: NewMenuProps) {
  const pending = useRef<(() => void) | null>(null);
  const projectReason = projectTerminalReason(selected);
  const entries: {
    key: string;
    label: string;
    icon: LucideIcon;
    reason: string | null;
    shortcut?: string;
    run: () => void;
  }[] = [
    {
      key: 'terminal',
      label: 'New terminal',
      icon: SquareTerminal,
      reason: null,
      shortcut: isMac ? '⌘T' : 'Ctrl+Shift+T',
      run: onNewTerminal,
    },
    {
      key: 'project-terminal',
      label: selected ? `New terminal in ${selected.project.name}` : 'New terminal in project',
      icon: SquarePlus,
      reason: projectReason,
      run: () => selected && onNewProjectTerminal(selected.project.id),
    },
    { key: 'project', label: 'New project…', icon: FolderPlus, reason: null, run: onNewProject },
    {
      key: 'group',
      label: 'New terminal group…',
      icon: Layers,
      reason: null,
      run: onNewGroup,
    },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2"
          aria-label="New"
          data-testid="toolbar-new"
        >
          <Plus aria-hidden="true" />
          <span className="hidden sm:inline">New</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64"
        data-testid="toolbar-new-menu"
        onCloseAutoFocus={(event) => {
          const action = pending.current;
          pending.current = null;
          if (action === null) return;
          event.preventDefault();
          action();
        }}
      >
        {entries.map((entry) => (
          <DropdownMenuItem
            key={entry.key}
            disabled={entry.reason !== null}
            onSelect={() => {
              pending.current = entry.run;
            }}
            className="items-start"
            data-testid={`toolbar-new-${entry.key}`}
          >
            <entry.icon className="mt-0.5" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{entry.label}</span>
              {entry.reason !== null && (
                <span className="text-muted-foreground text-[11px] leading-tight">
                  {entry.reason}
                </span>
              )}
            </span>
            {entry.shortcut !== undefined && (
              <span className="text-muted-foreground ml-auto pl-2 text-[11px]">
                {entry.shortcut}
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
