import { ChevronRight } from 'lucide-react';
import { Accordion as AccordionPrimitive } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { GitSyncBadges } from '@/components/git/GitBadges';
import { ProjectGitBadge } from '@/components/git/ProjectGitBadge';
import { useProjectActions, type ProjectActionEntry } from '@/components/useProjectActions';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { PendingPushSection } from '@/git/components/PendingPushSection';
import { cn } from '@/lib/utils';
import type { ProjectDetails } from '@/types';
import { filterByName } from '../state/project-navigation';

export interface ProjectNavigationActions {
  onOpenTerminal: (projectId: string) => void;
  onRunQuickCommand: (projectId: string, commandId: string) => void;
  onProjectInfo: (projectId: string) => void;
}

/**
 * Gives the focus back to what had it before a surface opened from a shortcut or a button,
 * such as the terminal, instead of leaving it on the page body (opened without a trigger).
 */
export function useRestoreFocus() {
  const previous = useRef<HTMLElement | null>(null);
  return {
    rememberFocus: () => {
      previous.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    restoreFocus: () => {
      const element = previous.current;
      previous.current = null;
      if (element?.isConnected) element.focus();
    },
  };
}

interface ProjectsDrawerProps extends ProjectNavigationActions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectDetails[];
}

/**
 * Every registered project, on demand, at the right of the terminals (PLAN-052). The
 * terminal sidebar only shows what is open, so sharing the screen does not list them all.
 * Each project expands to its actions; pending pushes are listed below.
 */
export function ProjectsDrawer({ open, onOpenChange, projects, ...actions }: ProjectsDrawerProps) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  // An action that opens a terminal or a sheet runs once the drawer has closed, so the
  // drawer does not give the focus back to its trigger after the terminal took it.
  const pending = useRef<(() => void) | null>(null);
  const visible = filterByName(projects, query, (item) => item.project.name);
  const { rememberFocus, restoreFocus } = useRestoreFocus();

  /** Each opening starts unfiltered, so a stale filter never hides projects. */
  const setOpen = (next: boolean) => {
    if (!next) setQuery('');
    onOpenChange(next);
  };
  const runAfterClose = (action: () => void) => {
    pending.current = action;
    setOpen(false);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="w-full gap-0 sm:max-w-md"
        data-testid="projects-drawer"
        onOpenAutoFocus={rememberFocus}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const action = pending.current;
          pending.current = null;
          if (action === null) restoreFocus();
          else action();
        }}
      >
        <SheetHeader className="gap-3 border-b">
          <div className="flex flex-col gap-1.5 pr-8">
            <SheetTitle>Projects</SheetTitle>
            <SheetDescription>Registered projects and their actions.</SheetDescription>
          </div>
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter projects…"
            aria-label="Filter projects"
          />
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {projects.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">No projects registered.</p>
          ) : visible.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm" role="status">
              No project matches “{query.trim()}”.
            </p>
          ) : (
            <AccordionPrimitive.Root
              type="multiple"
              value={expanded}
              onValueChange={setExpanded}
              className="flex flex-col gap-0.5 p-2"
              aria-label="Projects"
            >
              {visible.map((item) => (
                <ProjectAccordionItem
                  key={item.project.id}
                  item={item}
                  expanded={expanded.includes(item.project.id)}
                  onRun={(entry) =>
                    entry.mode === 'close' ? runAfterClose(entry.run) : entry.run()
                  }
                  {...actions}
                />
              ))}
            </AccordionPrimitive.Root>
          )}
          <PendingPushSection projects={projects} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface ProjectAccordionItemProps extends ProjectNavigationActions {
  item: ProjectDetails;
  expanded: boolean;
  onRun: (entry: ProjectActionEntry) => void;
}

function ProjectAccordionItem({
  item,
  expanded,
  onRun,
  onOpenTerminal,
  onRunQuickCommand,
  onProjectInfo,
}: ProjectAccordionItemProps) {
  const { id, name } = item.project;
  const available = item.availability.status === 'available';
  const actions = useProjectActions(id, {
    available,
    onOpenTerminal: () => onOpenTerminal(id),
    onProjectInfo: () => onProjectInfo(id),
    onRunCommand: (commandId) => onRunQuickCommand(id, commandId),
  });
  const { load } = actions;
  // Read each time the project expands, so its quick commands are never outdated.
  useEffect(() => (expanded ? load() : undefined), [expanded, load]);

  // Stored state pushed by the Engine: rendering the drawer never runs Git (SDD-024).
  const snapshot =
    actions.gitState?.snapshot?.state === 'repository' ? actions.gitState.snapshot : null;
  const tracksUpstream = snapshot !== null && snapshot.ahead !== null && snapshot.behind !== null;

  return (
    <AccordionPrimitive.Item value={id} data-testid="drawer-project">
      <AccordionPrimitive.Header className="flex items-center gap-1 rounded-md pr-1 hover:bg-accent/50">
        <AccordionPrimitive.Trigger className="group/trigger flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <ChevronRight
            className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90"
            aria-hidden="true"
          />
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              available ? 'bg-success' : 'bg-warning',
            )}
            aria-hidden="true"
          />
          <span className="truncate">{name}</span>
          {!available && <span className="sr-only">(unavailable)</span>}
        </AccordionPrimitive.Trigger>
        <span className="flex shrink-0 items-center gap-1">
          <ProjectGitBadge state={actions.gitState} />
          {tracksUpstream && (
            <span className="flex items-center gap-1" data-testid="drawer-project-sync">
              <GitSyncBadges snapshot={snapshot} />
            </span>
          )}
        </span>
      </AccordionPrimitive.Header>
      <AccordionPrimitive.Content className="overflow-hidden">
        <ul
          className="flex flex-col gap-0.5 py-1 pr-1 pl-7"
          aria-label={`Actions for ${name}`}
          data-testid="project-actions"
        >
          {actions.entries.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                className="hover:bg-accent focus-visible:ring-ring/50 flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50"
                disabled={entry.disabled}
                title={entry.detail}
                data-testid={entry.testId}
                onClick={() => onRun(entry)}
              >
                <entry.icon
                  className={cn('size-4 shrink-0', entry.spinning && 'animate-spin')}
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{entry.label}</span>
                  {entry.detail && (
                    <code className="text-muted-foreground truncate font-mono text-[11px]">
                      {entry.detail}
                    </code>
                  )}
                </span>
              </button>
            </li>
          ))}
          {!actions.loaded && actions.error === null && (
            <li className="text-muted-foreground px-2 py-1 text-xs" role="status">
              Loading quick commands…
            </li>
          )}
          {actions.error && (
            <li className="text-destructive px-2 py-1 text-xs" role="alert">
              {actions.error}
            </li>
          )}
        </ul>
      </AccordionPrimitive.Content>
    </AccordionPrimitive.Item>
  );
}
