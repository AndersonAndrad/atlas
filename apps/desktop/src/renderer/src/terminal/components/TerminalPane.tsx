import {
  hasPendingReview,
  isFinalTerminalStatus,
  type BackgroundJob,
  type GitWorkingTree,
  type TerminalPreferences,
  type TerminalSession,
} from '@atlas/contracts';
import {
  Activity,
  CheckCheck,
  Database,
  NotebookPen,
  Radio,
  Sparkles,
  Waypoints,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Eraser,
  GitBranch,
  Info,
  RotateCcw,
  Search,
  ShieldCheck,
  TextSelect,
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
import { OperationsSheet, useOperationsSheet } from '@/git/components/OperationsSheet';
import { useGitOperations } from '@/git/hooks/useGit';
import { cn } from '@/lib/utils';
import { api, errorMessage, unwrap } from '@/api';
import { requestProjectTasks } from '@/audit/navigation';
import { openInEditor } from '@/editor/navigation';
import { isActive } from '@/git/format';
import { BranchesDialog } from '@/git/components/BranchesDialog';
import { PullDialog, PushDialog } from '@/git/components/RemoteDialogs';
import { putProjectGitState } from '@/git/state/project-git-states';
import { SubmittedNotice } from '@/operations/components/SubmittedNotice';
import { terminalActionAvailability, type TerminalActionId } from '../state/terminal-actions';
import { TerminalActionsMenu } from './TerminalActionsMenu';
import { GitBadges } from '@/components/git/GitBadges';
import { pendingGitActions } from '@/components/git/git-format';
import { useTerminalGit } from '../hooks/useGitStatus';
import { useTerminalLlmUsage } from '../hooks/useTerminalLlmUsage';
import { TerminalView } from '../state/terminal-view';
import { endedSummary } from '../format';
import { TerminalStatusDot } from './TerminalStatusDot';
import { markTerminalReviewed, useTerminalActivity } from '../state/terminal-activity';
import { LlmUsageBadge } from './LlmUsageBadge';

const isMac = navigator.userAgent.includes('Mac');
const keys = (mac: string, other: string) => (isMac ? mac : other);

export interface TerminalContextAction {
  action: 'view' | 'continue' | 'handoff' | 'attach' | 'summary';
  provider?: 'claude' | 'codex';
}

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
  /** Opens Preflight (local checks) for this terminal's project. */
  onOpenPreflight: () => void;
  /** Shared context actions for this terminal (SDD-005). */
  onContextAction: (action: TerminalContextAction) => void;
  /** Opens the Git view with the commit dialog for this terminal's repository. */
  onCommit: () => void;
  /**
   * Tab and pane actions of the Terminals view; absent in the editor's terminal panel,
   * where the menu explains that they are available in the Terminals view.
   */
  tabActions?: {
    /** Starts renaming this terminal (its tab becomes editable). */
    onRename: () => void;
    /** Splits this pane with a terminal that continues this one's project and folder. */
    onSplit: (direction: 'row' | 'column') => void;
    /** A new tab continuing this terminal's project, folder, group and shell. */
    onDuplicate: () => void;
  };
  /** The project's folder can be reached (true without a project). */
  projectAvailable: boolean;
  canSplit: boolean;
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
  onOpenPreflight,
  onContextAction,
  onCommit,
  tabActions,
  projectAvailable,
  canSplit,
  registerHandle,
}: TerminalPaneProps) {
  const git = useTerminalGit(session.id, session.currentCwd, session.status === 'RUNNING');
  const snapshot = git.context?.git.state === 'repository' ? git.context.git.snapshot : null;
  const operations = useGitOperations(snapshot?.repositoryRoot ?? null);
  const llmUsage = useTerminalLlmUsage(session.id, session.status === 'RUNNING');
  // Failures open the panel by themselves only in the Git view.
  const operationsSheet = useOperationsSheet(operations, false);
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
  // Read when the context menu opens: xterm does not report selection to React.
  const [menuHasSelection, setMenuHasSelection] = useState(false);
  const ended = isFinalTerminalStatus(session.status);
  const running = session.status === 'RUNNING';
  const fetching = operations.some((item) => isActive(item) && item.kind === 'fetch');
  const availability = terminalActionAvailability({
    running,
    repository: snapshot !== null,
    gitBusy: operations.some((item) => isActive(item) && item.kind !== 'fetch'),
    fetching,
    projectId: session.projectId,
    projectAvailable,
    canSplit,
    manageable: tabActions !== undefined,
  });
  /** A Git dialog of the Actions menu, on the repository chosen when it was opened. */
  const [gitDialog, setGitDialog] = useState<{
    kind: 'branches' | 'push' | 'pull';
    tree: GitWorkingTree;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<BackgroundJob | null>(null);

  /**
   * Runs an entry of the Actions menu (SDD-023 Task A04). The repository and project are
   * read now, from this pane's terminal: a dialog opened here keeps working on them even
   * if another tab becomes active meanwhile.
   */
  async function runAction(id: TerminalActionId) {
    if (availability[id] !== null) return;
    setActionError(null);
    const root = snapshot?.repositoryRoot ?? null;
    const projectId = session.projectId;
    try {
      switch (id) {
        case 'branch':
        case 'push':
        case 'pull': {
          const tree = await unwrap(api().git.workingTree(root!));
          setGitDialog({ kind: id === 'branch' ? 'branches' : id, tree });
          return;
        }
        case 'fetch':
          setSubmitted(
            await unwrap(
              api().jobs.create({ type: 'GIT', action: 'fetch', repositoryRoot: root! }),
            ),
          );
          return;
        case 'status':
          onOpenGit();
          return;
        case 'commit':
          onCommit();
          return;
        case 'operations':
          operationsSheet.setOpen(true);
          return;
        case 'project-details':
          onProjectInfo();
          return;
        case 'editor':
          openInEditor({ projectId: projectId! });
          return;
        case 'tasks':
          requestProjectTasks(projectId!);
          return;
        case 'refresh':
          putProjectGitState((await unwrap(api().git.refreshProject(projectId!))).state);
          return;
        case 'rename':
          tabActions?.onRename();
          return;
        case 'split-right':
          tabActions?.onSplit('row');
          return;
        case 'split-down':
          tabActions?.onSplit('column');
          return;
        case 'duplicate':
          tabActions?.onDuplicate();
          return;
        case 'clear':
          viewRef.current?.clear();
          return;
        case 'restart':
          onRestart();
          return;
        case 'close':
          // The close flow asks first when a program is still running.
          onCloseTab();
          return;
      }
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }
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
        <TerminalStatusDot session={session} />
        <span className="text-foreground/90 truncate" data-testid="pane-title" title={directoryTip}>
          {session.title}
        </span>
        {projectName && (
          <span className="hidden truncate md:inline" data-testid="pane-project">
            · {projectName}
          </span>
        )}
        {snapshot && <GitBadges snapshot={snapshot} />}
        {llmUsage && <LlmUsageBadge usage={llmUsage} />}
        <span className="ml-auto flex items-center gap-0.5">
          <ReviewActions
            sessionId={session.id}
            onOpenSession={() => onContextAction({ action: 'view' })}
          />
          <TerminalActionsMenu
            availability={availability}
            pending={snapshot ? pendingGitActions(snapshot) : []}
            gitRunning={operationsSheet.running > 0}
            gitFailure={operationsSheet.unseenFailure}
            labels={fetching ? { fetch: 'Fetching…' } : {}}
            onAction={(id) => void runAction(id)}
          />
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

      <ContextMenu
        onOpenChange={(open) => {
          if (open) setMenuHasSelection(viewRef.current?.hasSelection() ?? false);
        }}
      >
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
          <ContextMenuItem
            disabled={!menuHasSelection}
            onSelect={() => viewRef.current?.copySelection()}
          >
            <Copy />
            Copy
            <ContextMenuShortcut>{keys('⌘C', 'Ctrl+Shift+C')}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!running} onSelect={() => void viewRef.current?.paste()}>
            <ClipboardPaste />
            Paste
            <ContextMenuShortcut>{keys('⌘V', 'Ctrl+Shift+V')}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => viewRef.current?.selectAll()}>
            <TextSelect />
            Select all
            {!isMac && <ContextMenuShortcut>Ctrl+Shift+A</ContextMenuShortcut>}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={snapshot === null} onSelect={onOpenGit}>
            <GitBranch />
            Open Git panel
            <ContextMenuShortcut>⇧⌘G</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={snapshot === null}
            onSelect={() => operationsSheet.setOpen(true)}
          >
            <Activity />
            Git operations
          </ContextMenuItem>
          <ContextMenuItem onSelect={onOpenPreflight}>
            <ShieldCheck />
            Run Preflight
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={snapshot === null}
            onSelect={() => onContextAction({ action: 'view' })}
          >
            <Database />
            Shared context
          </ContextMenuItem>
          <ContextMenuItem
            disabled={snapshot === null}
            onSelect={() => onContextAction({ action: 'continue', provider: 'claude' })}
          >
            <Sparkles />
            Continue with Claude…
          </ContextMenuItem>
          <ContextMenuItem
            disabled={snapshot === null}
            onSelect={() => onContextAction({ action: 'continue', provider: 'codex' })}
          >
            <Sparkles />
            Continue with Codex…
          </ContextMenuItem>
          <ContextMenuItem
            disabled={snapshot === null}
            onSelect={() => onContextAction({ action: 'handoff' })}
          >
            <Waypoints />
            Prepare handoff…
          </ContextMenuItem>
          <ContextMenuItem
            disabled={snapshot === null}
            onSelect={() => onContextAction({ action: 'attach' })}
          >
            <Radio />
            Track as AI session
          </ContextMenuItem>
          <ContextMenuItem
            disabled={snapshot === null}
            onSelect={() => onContextAction({ action: 'summary' })}
          >
            <NotebookPen />
            Save session summary…
          </ContextMenuItem>
          <ContextMenuSeparator />
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
      {(actionError || submitted) && (
        <div
          className="flex shrink-0 flex-col gap-1 border-t px-2 py-1"
          data-testid="terminal-action-status"
        >
          {actionError && (
            <div className="text-destructive flex items-center gap-2 text-xs" role="alert">
              <span className="min-w-0 flex-1 break-words" data-testid="terminal-action-error">
                {actionError}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Dismiss"
                onClick={() => setActionError(null)}
              >
                <X />
              </Button>
            </div>
          )}
          {submitted && <SubmittedNotice job={submitted} onDismiss={() => setSubmitted(null)} />}
        </div>
      )}
      {gitDialog?.kind === 'branches' && (
        <BranchesDialog tree={gitDialog.tree} onClose={() => setGitDialog(null)} />
      )}
      {gitDialog?.kind === 'push' && (
        <PushDialog
          tree={gitDialog.tree}
          onClose={() => setGitDialog(null)}
          onSubmitted={(job) => {
            setGitDialog(null);
            setSubmitted(job);
          }}
        />
      )}
      {gitDialog?.kind === 'pull' && (
        <PullDialog
          tree={gitDialog.tree}
          onClose={() => setGitDialog(null)}
          onSubmitted={(job) => {
            setGitDialog(null);
            setSubmitted(job);
          }}
        />
      )}
      {snapshot && (
        <OperationsSheet
          repositoryName={snapshot.repositoryRoot.slice(
            snapshot.repositoryRoot.lastIndexOf('/') + 1,
          )}
          repositoryRoot={snapshot.repositoryRoot}
          operations={operations}
          open={operationsSheet.open}
          onOpenChange={operationsSheet.setOpen}
        />
      )}
    </section>
  );
}

/**
 * Shown while the terminal has a finished result to review (SDD-023 Task A02): "Mark as
 * reviewed", and the AI session that recorded it when the project keeps shared context.
 */
function ReviewActions({
  sessionId,
  onOpenSession,
}: {
  sessionId: string;
  onOpenSession: () => void;
}) {
  const summary = useTerminalActivity(sessionId);
  if (!hasPendingReview(summary)) return null;
  const recorded = summary!.activities.some((item) => item.contextSessionId !== null);
  return (
    <>
      {recorded && (
        <Button variant="ghost" size="xs" onClick={onOpenSession}>
          Open AI session
        </Button>
      )}
      <Button
        variant="outline"
        size="xs"
        className="h-6 px-1.5 text-xs"
        onClick={() => void markTerminalReviewed(sessionId).catch(() => undefined)}
        data-testid="mark-reviewed"
      >
        <CheckCheck />
        Mark as reviewed
      </Button>
    </>
  );
}
