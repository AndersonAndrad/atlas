import {
  isFinalTerminalStatus,
  type TerminalPreferences,
  type TerminalSession,
} from '@atlas/contracts';
import {
  ChevronDown,
  ChevronUp,
  Eraser,
  GitBranch,
  Info,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ActionDot } from '@/components/git/ActionDot';
import { GitBadges } from '@/components/git/GitBadges';
import { pendingGitActions } from '@/components/git/git-format';
import { useTerminalGit } from '../hooks/useGitStatus';
import { TerminalView } from '../state/terminal-view';
import { endedSummary } from '../format';
import { TerminalStatusDot } from './TerminalStatusDot';

export interface TerminalPaneHandle {
  focus(): void;
  clear(): void;
  openSearch(): void;
}

interface TerminalPaneProps {
  paneId: string;
  session: TerminalSession;
  /** Name of the associated project, if any. */
  projectName: string | undefined;
  preferences: TerminalPreferences;
  active: boolean;
  /** Only one pane is visible: hiding it would leave the workspace empty. */
  onlyPane: boolean;
  onFocus: () => void;
  onHide: () => void;
  onRestart: () => void;
  onCloseTab: () => void;
  /** Opens the project details (or offers to register the directory). */
  onProjectInfo: () => void;
  /** Opens the Git view on the repository of this terminal's directory. */
  onOpenGit: () => void;
  registerHandle: (paneId: string, handle: TerminalPaneHandle | null) => void;
}

export function TerminalPane({
  paneId,
  session,
  projectName,
  preferences,
  active,
  onlyPane,
  onFocus,
  onHide,
  onRestart,
  onCloseTab,
  onProjectInfo,
  onOpenGit,
  registerHandle,
}: TerminalPaneProps) {
  const git = useTerminalGit(session.id, session.currentCwd, session.status === 'RUNNING');
  const snapshot = git.context?.git.state === 'repository' ? git.context.git.snapshot : null;
  const directoryTip =
    session.cwdSource === 'detected'
      ? session.currentCwd
      : `${session.currentCwd} (initial directory; the current one could not be detected)`;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchMiss, setSearchMiss] = useState(false);
  const ended = isFinalTerminalStatus(session.status);
  const running = session.status === 'RUNNING';
  // Read at mount only; later changes are applied through the effects below.
  const initialRef = useRef({ preferences, running });
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Swapped before paint so the header and the focused xterm always belong to
  // the same session (keys typed right after switching tabs reach the right PTY).
  // One view per mounted pane and session. Unmounting detaches the view; the
  // Engine process keeps running.
  useLayoutEffect(() => {
    const container = hostRef.current;
    if (container === null) return;
    const view = new TerminalView({
      sessionId: session.id,
      container,
      preferences: initialRef.current.preferences,
      acceptsInput: initialRef.current.running,
      onError: setAttachError,
    });
    viewRef.current = view;
    void view.start();
    // A session shown in the active pane (e.g. after switching tabs) takes focus.
    if (activeRef.current) view.focus();
    return () => {
      view.dispose();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [session.id]);

  useEffect(() => viewRef.current?.setAcceptsInput(running), [running]);
  useEffect(() => viewRef.current?.setPreferences(preferences), [preferences]);
  useEffect(() => {
    if (active) viewRef.current?.focus();
  }, [active]);

  useEffect(() => {
    registerHandle(paneId, {
      focus: () => viewRef.current?.focus(),
      clear: () => viewRef.current?.clear(),
      openSearch: () => {
        setSearchOpen(true);
        requestAnimationFrame(() => searchRef.current?.select());
      },
    });
    return () => registerHandle(paneId, null);
  }, [paneId, registerHandle]);

  const find = (direction: 'next' | 'previous') => {
    const view = viewRef.current;
    if (view === null) return;
    const found = direction === 'next' ? view.findNext(searchTerm) : view.findPrevious(searchTerm);
    setSearchMiss(searchTerm !== '' && !found);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchMiss(false);
    viewRef.current?.clearSearch();
    viewRef.current?.focus();
  };

  return (
    <section
      className={cn(
        'bg-terminal relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden border',
        active ? 'border-sidebar-primary/70' : 'border-border',
      )}
      aria-label={`Terminal ${session.title}`}
      data-testid="terminal-pane"
      data-session-id={session.id}
      data-active={active ? 'true' : 'false'}
      onMouseDown={onFocus}
      onFocus={onFocus}
    >
      <header className="text-muted-foreground flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs">
        <TerminalStatusDot status={session.status} />
        <span className="text-foreground/90 truncate" data-testid="pane-title" title={directoryTip}>
          {session.title}
        </span>
        {projectName && (
          <span className="hidden truncate md:inline" data-testid="pane-project">
            · {projectName}
          </span>
        )}
        {snapshot && <GitBadges snapshot={snapshot} />}
        <span className="ml-auto flex items-center gap-0.5">
          {snapshot && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="relative"
              aria-label="Open Git panel"
              title={['Git panel', ...pendingGitActions(snapshot)].join(' · ')}
              onClick={onOpenGit}
            >
              <GitBranch />
              <ActionDot reasons={pendingGitActions(snapshot)} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Project details"
            title="Project details"
            onClick={onProjectInfo}
          >
            <Info />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Search in terminal"
            title="Search"
            onClick={() => {
              setSearchOpen(true);
              requestAnimationFrame(() => searchRef.current?.focus());
            }}
          >
            <Search />
          </Button>
          {!onlyPane && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Hide pane"
              title="Hide pane (the terminal keeps running)"
              onClick={onHide}
            >
              <X />
            </Button>
          )}
        </span>
      </header>

      {searchOpen && (
        <div
          className="bg-popover absolute top-8 right-2 z-10 flex items-center gap-1 rounded-md border p-1 shadow-md"
          role="search"
        >
          <Input
            ref={searchRef}
            className={cn('h-7 w-44 text-xs', searchMiss && 'border-destructive')}
            placeholder="Find"
            aria-label="Find in terminal"
            value={searchTerm}
            onChange={(event) => {
              setSearchTerm(event.target.value);
              setSearchMiss(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') find(event.shiftKey ? 'previous' : 'next');
              if (event.key === 'Escape') closeSearch();
            }}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous match"
            onClick={() => find('previous')}
          >
            <ChevronUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next match"
            onClick={() => find('next')}
          >
            <ChevronDown />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Close search" onClick={closeSearch}>
            <X />
          </Button>
          <span className="sr-only" role="status">
            {searchMiss ? 'No matches' : ''}
          </span>
        </div>
      )}

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="terminal-host min-h-0 flex-1 px-2 pt-1"
            ref={hostRef}
            data-testid="terminal-host"
          />
        </ContextMenuTrigger>
        <ContextMenuContent
          data-testid="terminal-context-menu"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            viewRef.current?.focus();
          }}
        >
          <ContextMenuItem disabled={snapshot === null} onSelect={onOpenGit}>
            <GitBranch />
            Open Git panel
            <ContextMenuShortcut>⇧⌘G</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={onProjectInfo}>
            <Info />
            Project details
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => {
              setSearchOpen(true);
              requestAnimationFrame(() => searchRef.current?.focus());
            }}
          >
            <Search />
            Find…
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => viewRef.current?.clear()}>
            <Eraser />
            Clear terminal
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {(ended || attachError) && (
        <div
          className="bg-card/95 flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2 text-xs"
          role="status"
          data-testid="terminal-ended"
        >
          <span className="text-muted-foreground mr-auto">
            {attachError ?? endedSummary(session)}
          </span>
          {ended && (
            <>
              <Button size="xs" variant="secondary" onClick={onRestart}>
                <RotateCcw />
                Restart
              </Button>
              <Button size="xs" variant="ghost" onClick={onCloseTab}>
                Close
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
