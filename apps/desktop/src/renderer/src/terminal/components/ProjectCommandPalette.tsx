import { ArrowLeft, Folder, History, X, type LucideIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useProjectActions } from '@/components/useProjectActions';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ProjectDetails } from '@/types';
import { filterByName, useRecentProjectIds } from '../state/project-navigation';
import { useRestoreFocus, type ProjectNavigationActions } from './ProjectsDrawer';

interface ProjectCommandPaletteProps extends ProjectNavigationActions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectDetails[];
}

/**
 * Floating search over the registered projects (PLAN-052): choose a project, then one of
 * its actions, with the keyboard or the pointer. Escape (or Backspace in an empty search)
 * goes back from the actions to the projects; Escape on the projects closes it.
 */
export function ProjectCommandPalette({
  open,
  onOpenChange,
  projects,
  ...actions
}: ProjectCommandPaletteProps) {
  const [projectId, setProjectId] = useState<string | null>(null);
  // The first step's field is focused by the dialog itself, after it noted what had the focus
  // (restored on close); a step reached from the other one focuses its own field.
  const [moved, setMoved] = useState(false);
  const goTo = (next: string | null) => {
    setMoved(true);
    setProjectId(next);
  };
  // An action that opens a terminal or a sheet runs once the palette has closed, so the
  // palette does not give the focus back to its trigger after the terminal took it.
  const pending = useRef<(() => void) | null>(null);
  const selected = projects.find((item) => item.project.id === projectId);
  const { rememberFocus, restoreFocus } = useRestoreFocus();

  const setOpen = (next: boolean) => {
    if (!next) {
      setProjectId(null);
      setMoved(false);
    }
    onOpenChange(next);
  };
  const runAfterClose = (action: () => void) => {
    pending.current = action;
    setOpen(false);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content
          className="bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 fixed top-[12%] left-1/2 z-50 flex max-h-[70vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border shadow-2xl outline-none"
          data-testid="project-palette"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (selected === undefined) return;
            event.preventDefault();
            goTo(null);
          }}
          onOpenAutoFocus={rememberFocus}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const action = pending.current;
            pending.current = null;
            if (action === null) restoreFocus();
            else action();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {selected ? `Actions for ${selected.project.name}` : 'Search projects'}
          </DialogPrimitive.Title>
          {selected ? (
            <ActionStep
              key={selected.project.id}
              item={selected}
              autoFocus={moved}
              onBack={() => goTo(null)}
              onClose={() => setOpen(false)}
              onRunAfterClose={runAfterClose}
              {...actions}
            />
          ) : (
            <ProjectStep
              projects={projects}
              autoFocus={moved}
              onChoose={goTo}
              onClose={() => setOpen(false)}
            />
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

interface ProjectStepProps {
  autoFocus: boolean;
  projects: ProjectDetails[];
  onChoose: (projectId: string) => void;
  onClose: () => void;
}

function ProjectStep({ autoFocus, projects, onChoose, onClose }: ProjectStepProps) {
  const [query, setQuery] = useState('');
  const recentIds = useRecentProjectIds();
  const option = (item: ProjectDetails, icon: LucideIcon): PaletteOption => ({
    key: item.project.id,
    label: item.project.name,
    ...(item.availability.status === 'available' ? {} : { detail: 'Unavailable' }),
    icon,
    disabled: false,
    testId: 'palette-project',
    onSelect: () => onChoose(item.project.id),
  });

  let sections: PaletteSection[];
  if (query.trim() === '') {
    const recent = recentIds
      .map((id) => projects.find((item) => item.project.id === id))
      .filter((item): item is ProjectDetails => item !== undefined);
    sections = [
      { label: 'Recently opened', options: recent.map((item) => option(item, History)) },
      {
        label: 'Projects',
        options: projects
          .filter((item) => !recentIds.includes(item.project.id))
          .map((item) => option(item, Folder)),
      },
    ];
  } else {
    sections = [
      {
        label: 'Projects',
        options: filterByName(projects, query, (item) => item.project.name).map((item) =>
          option(item, Folder),
        ),
      },
    ];
  }

  return (
    <PaletteStep
      autoFocus={autoFocus}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search projects…"
      sections={sections}
      empty={
        projects.length === 0 ? 'No projects registered.' : `No project matches “${query.trim()}”.`
      }
      leading={null}
      onClose={onClose}
    />
  );
}

interface ActionStepProps extends ProjectNavigationActions {
  autoFocus: boolean;
  item: ProjectDetails;
  onBack: () => void;
  onClose: () => void;
  onRunAfterClose: (action: () => void) => void;
}

function ActionStep({
  autoFocus,
  item,
  onBack,
  onClose,
  onRunAfterClose,
  onOpenTerminal,
  onRunQuickCommand,
  onProjectInfo,
}: ActionStepProps) {
  const { id, name } = item.project;
  const [query, setQuery] = useState('');
  const actions = useProjectActions(id, {
    available: item.availability.status === 'available',
    onOpenTerminal: () => onOpenTerminal(id),
    onProjectInfo: () => onProjectInfo(id),
    onRunCommand: (commandId) => onRunQuickCommand(id, commandId),
  });
  const { load } = actions;
  // Read when the project is chosen, so its quick commands are never outdated.
  useEffect(() => load(), [load]);

  const options = filterByName(actions.entries, query, (entry) => entry.label).map(
    (entry): PaletteOption => ({
      key: entry.key,
      label: entry.label,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      icon: entry.icon,
      spinning: entry.spinning ?? false,
      disabled: entry.disabled,
      testId: entry.testId,
      onSelect: () => (entry.mode === 'close' ? onRunAfterClose(entry.run) : entry.run()),
    }),
  );

  return (
    <PaletteStep
      autoFocus={autoFocus}
      query={query}
      onQueryChange={setQuery}
      placeholder={`Search actions for ${name}…`}
      sections={[{ label: name, options }]}
      empty={`No action matches “${query.trim()}”.`}
      onBackspaceEmpty={onBack}
      leading={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Back to projects"
          title="Back to projects (Esc)"
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
      }
      footer={
        <>
          {!actions.loaded && actions.error === null && (
            <p className="text-muted-foreground px-4 pb-3 text-xs" role="status">
              Loading quick commands…
            </p>
          )}
          {actions.error && (
            <p className="text-destructive px-4 pb-3 text-xs" role="alert">
              {actions.error}
            </p>
          )}
        </>
      }
      onClose={onClose}
    />
  );
}

interface PaletteOption {
  key: string;
  label: string;
  detail?: string;
  icon: LucideIcon;
  spinning?: boolean;
  disabled: boolean;
  testId: string;
  onSelect: () => void;
}

interface PaletteSection {
  label: string;
  options: PaletteOption[];
}

interface PaletteStepProps {
  autoFocus: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  sections: PaletteSection[];
  empty: string;
  leading: ReactNode;
  footer?: ReactNode;
  onBackspaceEmpty?: () => void;
  onClose: () => void;
}

/** A search field over a list box: arrows move, Enter chooses, the pointer works too. */
function PaletteStep({
  autoFocus,
  query,
  onQueryChange,
  placeholder,
  sections,
  empty,
  leading,
  footer,
  onBackspaceEmpty,
  onClose,
}: PaletteStepProps) {
  const listId = useId();
  const [active, setActive] = useState(0);
  const visibleSections = sections.filter((section) => section.options.length > 0);
  const flat = visibleSections.flatMap((section) => section.options);
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const optionId = (index: number) => `${listId}-option-${index}`;

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView({
      block: 'nearest',
    });
  }, [activeIndex, listId]);

  const choose = (index: number) => {
    const option = flat[index];
    if (option !== undefined && !option.disabled) option.onSelect();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (flat.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + step + flat.length) % flat.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === 'Backspace' && query === '' && onBackspaceEmpty) {
      event.preventDefault();
      onBackspaceEmpty();
    }
  };

  /** Index in `flat` of each section's first option. */
  const offsets = visibleSections.map((_, sectionIndex) =>
    visibleSections
      .slice(0, sectionIndex)
      .reduce((total, section) => total + section.options.length, 0),
  );
  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {leading}
        <input
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-label={placeholder}
          className="placeholder:text-muted-foreground h-9 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none"
          placeholder={placeholder}
          value={query}
          onChange={(event) => {
            setActive(0);
            onQueryChange(event.target.value);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
        <Button variant="ghost" size="icon-xs" aria-label="Close" title="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        <ul id={listId} role="listbox" aria-label={placeholder} className="flex flex-col">
          {visibleSections.map((section, sectionIndex) => (
            <li key={section.label} role="presentation" className="flex flex-col pb-2">
              <p
                className="text-muted-foreground px-4 pt-2 pb-1 text-xs font-medium"
                aria-hidden="true"
              >
                {section.label}
              </p>
              <ul role="group" aria-label={section.label} className="flex flex-col px-2">
                {section.options.map((option, optionIndex) => {
                  const position = (offsets[sectionIndex] ?? 0) + optionIndex;
                  return (
                    <li
                      key={option.key}
                      id={optionId(position)}
                      role="option"
                      aria-selected={position === activeIndex}
                      aria-disabled={option.disabled || undefined}
                      data-testid={option.testId}
                      className={cn(
                        'flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm',
                        position === activeIndex && 'bg-accent text-accent-foreground',
                        option.disabled && 'cursor-default opacity-50',
                      )}
                      onPointerMove={() => position !== activeIndex && setActive(position)}
                      // Keeps the focus in the search field.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(position)}
                    >
                      <option.icon
                        className={cn(
                          'text-muted-foreground size-4 shrink-0',
                          option.spinning && 'animate-spin',
                        )}
                        aria-hidden="true"
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{option.label}</span>
                        {option.detail && (
                          <code className="text-muted-foreground truncate font-mono text-[11px]">
                            {option.detail}
                          </code>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        {flat.length === 0 && (
          <p className="text-muted-foreground px-4 py-6 text-center text-sm" role="status">
            {empty}
          </p>
        )}
      </div>
      {footer}
    </>
  );
}
