import type { TerminalSession } from '@atlas/contracts';
import {
  Check,
  ChevronDown,
  Folder,
  FolderX,
  Info,
  Plus,
  SquareTerminal,
  TriangleAlert,
} from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { useProjects } from '@/hooks/useProjects';
import { cn } from '@/lib/utils';
import { filterByName } from '@/terminal/state/project-navigation';
import {
  latestProjectTerminal,
  moveHighlight,
  projectTerminalReason,
  projectTerminals,
} from '../state/project-toolbar';

interface ProjectSwitcherProps {
  projects: ReturnType<typeof useProjects>;
  /** Every open terminal, to count and show the selected project's ones. */
  sessions: readonly TerminalSession[];
  /** The terminal group shown in the Terminals view; null elsewhere. */
  groupName: string | null;
  onShowTerminal: (terminalId: string) => void;
  onNewTerminal: (projectId: string) => void;
  onProjectDetails: (projectId: string) => void;
  onNewProject: () => void;
}

/**
 * The selected project in the upper toolbar (SDD-023 Task A05). Choosing a project only
 * selects it: no terminal opens, closes or changes folder, and no AI provider starts.
 * Its actions act on the selected project and run once the popover closed, so what they
 * open keeps the keyboard focus.
 */
export function ProjectSwitcher({
  projects,
  sessions,
  groupName,
  onShowTerminal,
  onNewTerminal,
  onProjectDetails,
  onNewProject,
}: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const pending = useRef<(() => void) | null>(null);
  const listId = useId();
  const items = projects.items ?? [];
  const matches = filterByName(items, query, (item) => item.project.name);
  const selected = projects.selected;
  const selectedTerminals = selected ? projectTerminals(sessions, selected.project.id) : [];
  const terminalReason = projectTerminalReason(selected);

  const setOpenState = (next: boolean) => {
    if (next) {
      setQuery('');
      setHighlight(-1);
    }
    setOpen(next);
  };
  const runAfterClose = (action: () => void) => {
    pending.current = action;
    setOpen(false);
  };
  const choose = (projectId: string) => {
    setOpen(false);
    if (projectId === projects.selectedId) return;
    projects.clearSelectError();
    void projects.select(projectId);
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((index) =>
        moveHighlight(index, event.key === 'ArrowDown' ? 1 : -1, matches.length),
      );
    } else if (event.key === 'Enter') {
      const match = matches[highlight] ?? (matches.length === 1 ? matches[0] : undefined);
      if (match) {
        event.preventDefault();
        choose(match.project.id);
      }
    }
  };

  const label = selected?.project.name ?? 'No project';
  return (
    <Popover open={open} onOpenChange={setOpenState}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 max-w-[45vw] min-w-0 shrink gap-1.5 px-2 sm:max-w-80"
          aria-label={`Project: ${label}${groupName ? `, group ${groupName}` : ''}`}
          title={selected?.project.workspacePath ?? 'Select a project'}
          data-testid="toolbar-project"
        >
          {selected && selected.availability.status !== 'available' ? (
            <FolderX className="text-destructive" aria-hidden="true" />
          ) : (
            <Folder aria-hidden="true" />
          )}
          <span
            className={cn('truncate', selected === null && 'text-muted-foreground')}
            data-testid="toolbar-project-name"
          >
            {label}
          </span>
          {groupName !== null && (
            <span
              className="text-muted-foreground hidden truncate md:inline"
              data-testid="toolbar-group-name"
            >
              / {groupName}
            </span>
          )}
          {projects.loadError !== null && (
            <TriangleAlert className="text-warning" aria-hidden="true" />
          )}
          <ChevronDown className="text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 p-2"
        data-testid="toolbar-project-menu"
        onCloseAutoFocus={(event) => {
          const action = pending.current;
          pending.current = null;
          if (action === null) return;
          event.preventDefault();
          action();
        }}
      >
        {projects.loadError !== null && (
          <div
            className="text-destructive flex items-center gap-2 px-1 text-xs"
            role="alert"
            data-testid="toolbar-project-error"
          >
            <span className="min-w-0 flex-1">
              {projects.items === null
                ? 'Projects could not be loaded.'
                : 'Projects could not be refreshed; this list may be outdated.'}
            </span>
            <Button variant="outline" size="xs" onClick={() => void projects.reload()}>
              Retry
            </Button>
          </div>
        )}
        {projects.selectError !== null && (
          <p
            className="text-destructive px-1 text-xs"
            role="alert"
            data-testid="toolbar-project-select-error"
          >
            The project could not be selected: {projects.selectError}
          </p>
        )}
        {projects.items === null ? (
          projects.loadError === null && (
            <p className="text-muted-foreground px-1 py-2 text-xs">Loading projects…</p>
          )
        ) : items.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-1 py-2 text-xs">
            <p className="text-muted-foreground">No projects registered yet.</p>
            <Button size="xs" onClick={() => runAfterClose(onNewProject)}>
              <Plus />
              New project…
            </Button>
          </div>
        ) : (
          <>
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(-1);
              }}
              onKeyDown={onSearchKey}
              placeholder="Search projects"
              aria-label="Search projects"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                matches[highlight] ? `${listId}-${matches[highlight].project.id}` : undefined
              }
              className="h-8"
              data-testid="toolbar-project-search"
            />
            <ul
              id={listId}
              role="listbox"
              aria-label="Projects"
              className="flex max-h-64 flex-col overflow-y-auto"
            >
              {matches.length === 0 && (
                <li className="text-muted-foreground px-2 py-1.5 text-xs">No matching project.</li>
              )}
              {matches.map((item, index) => {
                const isSelected = item.project.id === projects.selectedId;
                const missing = item.availability.status !== 'available';
                const count = projectTerminals(sessions, item.project.id).length;
                return (
                  <li
                    key={item.project.id}
                    id={`${listId}-${item.project.id}`}
                    role="option"
                    aria-selected={isSelected}
                    className={cn(
                      'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                      index === highlight
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-accent/60',
                    )}
                    onMouseMove={() => setHighlight(index)}
                    onClick={() => choose(item.project.id)}
                    data-testid="toolbar-project-option"
                  >
                    <Check
                      className={cn('size-3.5 shrink-0', !isSelected && 'invisible')}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{item.project.name}</span>
                    {missing && (
                      <span className="text-destructive shrink-0 text-[11px]">Folder missing</span>
                    )}
                    {count > 0 && (
                      <span
                        className="text-muted-foreground shrink-0 text-[11px]"
                        title={`${count} open terminal${count === 1 ? '' : 's'}`}
                      >
                        {count} <span className="sr-only">open terminals</span>
                        <SquareTerminal className="inline size-3" aria-hidden="true" />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {selected && (
          <div className="flex flex-col gap-0.5 border-t pt-2" aria-label="Selected project">
            <p className="text-muted-foreground truncate px-1 text-[11px]">
              {selected.project.name}
            </p>
            <SwitcherAction
              icon={SquareTerminal}
              label={
                selectedTerminals.length > 0
                  ? `Show terminals (${selectedTerminals.length})`
                  : 'Show terminals'
              }
              reason={selectedTerminals.length > 0 ? null : 'No open terminals.'}
              testId="toolbar-project-show-terminals"
              onClick={() => {
                const terminal = latestProjectTerminal(sessions, selected.project.id);
                if (terminal) runAfterClose(() => onShowTerminal(terminal.id));
              }}
            />
            <SwitcherAction
              icon={Plus}
              label="New terminal in project"
              reason={terminalReason}
              testId="toolbar-project-new-terminal"
              onClick={() => runAfterClose(() => onNewTerminal(selected.project.id))}
            />
            <SwitcherAction
              icon={Info}
              label="Project details"
              reason={null}
              testId="toolbar-project-details"
              onClick={() => runAfterClose(() => onProjectDetails(selected.project.id))}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function SwitcherAction({
  icon: Icon,
  label,
  reason,
  testId,
  onClick,
}: {
  icon: typeof Info;
  label: string;
  /** Null: enabled; text: disabled, with the reason shown under the label. */
  reason: string | null;
  testId: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-auto justify-start py-1.5 text-left"
      disabled={reason !== null}
      onClick={onClick}
      data-testid={testId}
    >
      <Icon className="self-start" aria-hidden="true" />
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        {reason !== null && (
          <span className="text-muted-foreground text-[11px] leading-tight">{reason}</span>
        )}
      </span>
    </Button>
  );
}
