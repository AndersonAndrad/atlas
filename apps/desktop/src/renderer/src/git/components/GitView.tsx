import type { GitOperation, GitRemote } from '@atlas/contracts';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CloudDownload,
  ListChecks,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  RefreshCw,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { relativeTime } from '@/components/git/git-format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isActive, nextToReview } from '../format';
import {
  useGitDiff,
  useGitOperations,
  useGitPreferences,
  useGitRepositories,
  useGitWorkingTree,
  type DiffSelection,
} from '../hooks/useGit';
import { BranchesDialog } from './BranchesDialog';
import { ChangesList } from './ChangesList';
import { CommitDialog } from './CommitDialog';
import { CommitSettingsDialog } from './CommitSettingsDialog';
import { DiffViewer } from './DiffViewer';
import { OperationsButton, OperationsSheet, useOperationsSheet } from './OperationsSheet';
import { MergeDialog } from './MergeDialog';
import { PullDialog, PushDialog } from './RemoteDialogs';
import { CherryPickDialog } from './CherryPickDialog';

/** Opens the Git view on the repository of a project or a terminal. */
export interface GitOpenRequest {
  projectId?: string;
  terminalId?: string;
  nonce: number;
}

type GitDialog =
  | 'commit'
  | 'push'
  | 'pull'
  | 'branches'
  | 'checks'
  | 'merge'
  | 'abort-merge'
  | 'cherry-pick'
  | 'abort-cherry-pick'
  | null;

/** Commits to push or pull, as of the last fetch; nothing without an upstream. */
function SyncCount({
  value,
  label,
  testId,
}: {
  value: number | null;
  label: string;
  testId: string;
}) {
  if (value === null) return null;
  return (
    <span
      className={
        value > 0
          ? 'bg-sidebar-primary/20 text-foreground rounded px-1.5 text-xs tabular-nums'
          : 'bg-muted text-muted-foreground rounded px-1.5 text-xs tabular-nums'
      }
      title={`${value} commit${value === 1 ? '' : 's'} ${label} (as of the last fetch)`}
      data-testid={testId}
    >
      {value}
    </span>
  );
}

interface GitViewProps {
  request: GitOpenRequest | null;
  onRequestHandled: () => void;
}

const IN_PROGRESS_TEXT = {
  merge: 'A merge is in progress.',
  rebase: 'A rebase is in progress.',
  'cherry-pick': 'A cherry-pick is in progress.',
  revert: 'A revert is in progress.',
} as const;

/** Git workspace: works without AI and without a registered project. */
export function GitView({ request, onRequestHandled }: GitViewProps) {
  const { repositories, error: listError, reload: reloadRepositories } = useGitRepositories();
  const { preferences, update: updatePreferences } = useGitPreferences();
  const [chosenRoot, setChosenRoot] = useState<string | null>(null);
  const [pending, setPending] = useState<GitOpenRequest | null>(null);
  const [handledRequest, setHandledRequest] = useState<number | null>(null);
  // Per-repository UI state, so switching repositories never shows stale data.
  const [selected, setSelected] = useState<{ root: string; selection: DiffSelection } | null>(null);
  const [loadedRemotes, setLoadedRemotes] = useState<{ root: string; remotes: GitRemote[] } | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  // A request from a project or terminal: taken once, then resolved against the
  // repository list as soon as it contains the project's or terminal's repository.
  if (request !== null && request.nonce !== handledRequest) {
    setHandledRequest(request.nonce);
    setPending(request);
  }
  useEffect(() => {
    if (request === null) return;
    onRequestHandled();
    void (async () => {
      await reloadRepositories();
    })();
  }, [request, onRequestHandled, reloadRepositories]);
  const requested =
    pending === null
      ? undefined
      : repositories?.find(
          (entry) =>
            (pending.projectId !== undefined && entry.projectIds.includes(pending.projectId)) ||
            (pending.terminalId !== undefined && entry.terminalIds.includes(pending.terminalId)),
        );
  if (requested !== undefined) {
    setPending(null);
    setChosenRoot(requested.repositoryRoot);
  }

  const known = (root: string | null | undefined) =>
    root != null && repositories?.some((entry) => entry.repositoryRoot === root) === true;
  const repositoryRoot = known(chosenRoot)
    ? chosenRoot
    : known(preferences?.lastRepositoryRoot)
      ? preferences!.lastRepositoryRoot
      : (repositories?.[0]?.repositoryRoot ?? null);

  const { tree, error: treeError, loading, refresh } = useGitWorkingTree(repositoryRoot);
  const operations = useGitOperations(repositoryRoot);
  const [dialog, setDialog] = useState<GitDialog>(null);
  // Results shown in a dialog (e.g. Commit & Push) do not also open the panel on top of it.
  const operationsSheet = useOperationsSheet(operations, dialog === null);
  const selection = selected?.root === repositoryRoot ? selected.selection : null;
  const remotes = loadedRemotes?.root === repositoryRoot ? loadedRemotes.remotes : null;
  // A selection whose file no longer has changes in that area is dropped.
  const shownSelection =
    selection !== null &&
    tree?.files.some(
      (file) =>
        file.path === selection.path &&
        (selection.area === 'staged' ? file.staged : file.unstaged) !== null,
    ) === true
      ? selection
      : null;
  const { diff, error: diffError } = useGitDiff(repositoryRoot, shownSelection, tree?.inspectedAt);

  const choose = (root: string) => {
    setPending(null);
    setChosenRoot(root);
    // Saving would replace unreadable preferences with the defaults, silently dropping
    // stricter conventions; they are only replaced from the Git settings.
    if (preferences?.invalid !== true) {
      void updatePreferences({ lastRepositoryRoot: root }).catch(() => undefined);
    }
  };

  /** Runs a Git action and refreshes the tree; resolves to its result, or null when it threw. */
  /** Result of the last Continue or Skip, shown while the cherry-pick is still stopped. */
  const [cherryResult, setCherryResult] = useState<GitOperation | null>(null);
  async function mutate<T>(action: () => Promise<T>): Promise<T | null> {
    setActionError(null);
    try {
      return await action();
    } catch (caught) {
      setActionError(errorMessage(caught));
      return null;
    } finally {
      void refresh();
    }
  }
  const busy = operations.some((operation) => isActive(operation) && operation.kind !== 'fetch');
  const fetching = operations.some(
    (operation) => isActive(operation) && operation.kind === 'fetch',
  );
  const fetch = (remote?: string) =>
    void mutate(() =>
      unwrap(api().git.fetch({ repositoryRoot: repositoryRoot!, ...(remote ? { remote } : {}) })),
    );

  const error = actionError ?? listError ?? treeError;

  // Approving from the diff stages the file and, once staged, moves on to the next file to review.
  const shownFile =
    shownSelection === null
      ? undefined
      : tree?.files.find((file) => file.path === shownSelection.path);
  const reviewAction =
    tree === null ||
    shownSelection === null ||
    shownFile === undefined ||
    shownFile.staged === 'conflicted'
      ? undefined
      : shownSelection.area === 'unstaged'
        ? {
            kind: 'approve' as const,
            disabled: busy,
            run: () => {
              const path = shownSelection.path;
              const next = nextToReview(tree.files, path);
              const root = tree.repositoryRoot;
              void mutate(() =>
                unwrap(api().git.stage({ repositoryRoot: root, paths: [path] })),
              ).then((operation) => {
                // A Git failure is reported on the operation; the file stays shown. A file the
                // user selected meanwhile is kept too.
                if (operation?.status !== 'succeeded' || next === null) return;
                setSelected((current) =>
                  current?.root === root && current.selection.path === path
                    ? { root, selection: { path: next, area: 'unstaged' } }
                    : current,
                );
              });
            },
          }
        : {
            kind: 'revoke' as const,
            disabled: busy,
            run: () =>
              void mutate(() =>
                unwrap(
                  api().git.unstage({
                    repositoryRoot: tree.repositoryRoot,
                    paths: [shownSelection.path],
                  }),
                ),
              ),
          };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="git-view">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">Git</h1>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          {repositories !== null && repositories.length > 0 && (
            <Select value={repositoryRoot ?? undefined} onValueChange={choose}>
              <SelectTrigger
                className="w-64 min-w-0 shrink"
                aria-label="Repository"
                data-testid="git-repository-select"
              >
                <SelectValue placeholder="Repository" />
              </SelectTrigger>
              <SelectContent>
                {repositories.map((entry) => (
                  <SelectItem key={entry.repositoryRoot} value={entry.repositoryRoot}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{entry.name}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {repositoryRoot !== null && (
            <OperationsButton
              running={operationsSheet.running}
              unseenFailure={operationsSheet.unseenFailure}
              onClick={() => operationsSheet.setOpen(true)}
            />
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh repository status"
            title="Refresh"
            disabled={repositoryRoot === null || loading}
            onClick={() => {
              void reloadRepositories();
              void refresh();
            }}
          >
            <RefreshCw className={loading ? 'animate-spin' : undefined} />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="git-error">{error}</AlertDescription>
          </Alert>
        )}

        {repositories !== null && repositories.length === 0 && (
          <div
            className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm"
            data-testid="git-empty"
          >
            <GitBranch className="size-8" aria-hidden="true" />
            <p className="text-foreground font-medium">No Git repositories</p>
            <p className="max-w-sm">
              Register a project or open a terminal inside a Git repository. Directories without Git
              are not listed.
            </p>
          </div>
        )}

        {tree && (
          <>
            <section
              className="flex flex-col gap-3 rounded-lg border p-3"
              aria-label="Repository"
              data-testid="git-summary"
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h2
                    className="truncate text-base font-semibold"
                    data-testid="git-repository-name"
                  >
                    {tree.repositoryName}
                  </h2>
                  <p
                    className="text-muted-foreground truncate font-mono text-xs [direction:rtl]"
                    title={tree.repositoryRoot}
                  >
                    <span dir="ltr">{tree.repositoryRoot}</span>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <div className="flex">
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-r-none"
                      disabled={fetching}
                      onClick={() => fetch()}
                    >
                      <CloudDownload />
                      {fetching ? 'Fetching…' : 'Fetch'}
                    </Button>
                    <DropdownMenu
                      onOpenChange={(open) => {
                        if (open && remotes === null) {
                          const root = tree.repositoryRoot;
                          void unwrap(api().git.remotes(root)).then(
                            (list) => setLoadedRemotes({ root, remotes: list }),
                            () => setLoadedRemotes({ root, remotes: [] }),
                          );
                        }
                      }}
                    >
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-l-none border-l-0 px-1.5"
                          aria-label="Fetch from a remote"
                          disabled={fetching}
                        >
                          <ChevronDown />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Fetch from</DropdownMenuLabel>
                        {remotes === null && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
                        {remotes?.length === 0 && (
                          <DropdownMenuItem disabled>No remotes</DropdownMenuItem>
                        )}
                        {remotes?.map((remote) => (
                          <DropdownMenuItem key={remote.name} onSelect={() => fetch(remote.name)}>
                            <span className="flex min-w-0 flex-col">
                              <span>{remote.name}</span>
                              <span className="text-muted-foreground truncate text-xs">
                                {remote.fetchUrl}
                              </span>
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDialog('pull')}
                  >
                    <ArrowDown />
                    Pull…
                    <SyncCount value={tree.behind} label="to pull" testId="git-pull-count" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDialog('push')}
                  >
                    <ArrowUp />
                    Push…
                    <SyncCount value={tree.ahead} label="to push" testId="git-push-count" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || tree.inProgress !== null}
                    onClick={() => setDialog('merge')}
                  >
                    <GitMerge />
                    Merge…
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || tree.inProgress !== null || tree.branch === null}
                    onClick={() => setDialog('cherry-pick')}
                  >
                    <GitCommitHorizontal />
                    Cherry-pick…
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDialog('branches')}
                  >
                    <GitBranch />
                    Branches…
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setDialog('checks')}>
                    <ListChecks />
                    Commit checks…
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => setDialog('commit')}>
                    <GitCommitHorizontal />
                    Commit…
                  </Button>
                </div>
              </div>
              <dl className="text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 text-xs">
                <div className="flex items-center gap-1">
                  <dt className="sr-only">Branch</dt>
                  <GitBranch className="size-3" aria-hidden="true" />
                  <dd className="text-foreground" data-testid="git-branch-name">
                    {tree.branch ?? (tree.detachedHead ? 'detached HEAD' : 'unknown')}
                    {tree.unbornHead && ' (no commits yet)'}
                  </dd>
                </div>
                <div className="flex items-center gap-1">
                  <dt className="sr-only">Upstream</dt>
                  <dd data-testid="git-upstream">
                    {tree.upstream === null
                      ? 'No upstream'
                      : tree.upstreamGone
                        ? `${tree.upstream} (gone)`
                        : tree.upstream}
                  </dd>
                </div>
                {tree.ahead !== null && (
                  <div
                    className="flex items-center gap-1 tabular-nums"
                    data-testid="git-ahead-behind"
                    data-ahead={tree.ahead}
                    data-behind={tree.behind ?? undefined}
                  >
                    <dt className="sr-only">Ahead and behind</dt>
                    <dd className="flex items-center gap-1">
                      <ArrowUp className="size-3" aria-label="ahead" />
                      {tree.ahead}
                      <ArrowDown className="size-3" aria-label="behind" />
                      {tree.behind}
                    </dd>
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <dt className="sr-only">Last fetch</dt>
                  <dd data-testid="git-last-fetch">
                    {tree.lastFetchAt === null
                      ? 'Never fetched'
                      : `Fetched ${relativeTime(tree.lastFetchAt)}`}
                  </dd>
                </div>
                <div className="flex items-center gap-1">
                  <dt className="sr-only">Identity</dt>
                  <UserRound className="size-3" aria-hidden="true" />
                  <dd data-testid="git-identity">
                    {tree.identity.name || tree.identity.email
                      ? [tree.identity.name, tree.identity.email].filter(Boolean).join(' · ')
                      : 'Identity not configured'}
                  </dd>
                </div>
              </dl>
            </section>

            {tree.inProgress === 'merge' && (
              <Alert role="status" className="border-warning/40" data-testid="git-merge-banner">
                <GitMerge className="text-warning" />
                <AlertDescription className="flex flex-col gap-2">
                  <span>
                    <strong className="text-foreground">Merge in progress</strong>
                    {tree.mergeMessage ? ` — ${tree.mergeMessage.split('\n', 1)[0]}` : ''}.{' '}
                    {tree.files.some((file) => file.staged === 'conflicted')
                      ? 'Resolve the conflicts in your editor, mark them resolved, then commit.'
                      : 'Review the changes, then commit to finish the merge.'}
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy} onClick={() => setDialog('commit')}>
                      <GitCommitHorizontal />
                      Commit merge
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setDialog('abort-merge')}
                    >
                      Abort merge…
                    </Button>
                  </span>
                </AlertDescription>
              </Alert>
            )}
            {tree.inProgress === 'cherry-pick' && (
              <Alert
                role="status"
                className="border-warning/40"
                data-testid="git-cherry-pick-banner"
              >
                <GitCommitHorizontal className="text-warning" />
                <AlertDescription className="flex flex-col gap-2">
                  <span>
                    <strong className="text-foreground">Cherry-pick in progress</strong>
                    {tree.cherryPick
                      ? ` — stopped at ${tree.cherryPick.hash.slice(0, 7)} ${tree.cherryPick.subject}` +
                        (tree.cherryPick.remaining > 0
                          ? ` (${tree.cherryPick.remaining} more after it)`
                          : '')
                      : ''}
                    .{' '}
                    {tree.files.some((file) => file.staged === 'conflicted')
                      ? 'Resolve the conflicts in your editor and mark them resolved, then continue.'
                      : 'Continue to commit it with its original message, or skip it.'}
                  </span>
                  {cherryResult?.status === 'failed' && cherryResult.error && (
                    <span className="text-destructive" data-testid="git-cherry-pick-error">
                      {cherryResult.error.message}
                    </span>
                  )}
                  <span className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={busy || tree.files.some((file) => file.staged === 'conflicted')}
                      onClick={() =>
                        void mutate(async () =>
                          setCherryResult(
                            await unwrap(api().git.continueCherryPick(tree.repositoryRoot)),
                          ),
                        )
                      }
                    >
                      Continue
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void mutate(async () =>
                          setCherryResult(
                            await unwrap(api().git.skipCherryPick(tree.repositoryRoot)),
                          ),
                        )
                      }
                    >
                      Skip this commit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setDialog('abort-cherry-pick')}
                    >
                      Abort cherry-pick…
                    </Button>
                  </span>
                </AlertDescription>
              </Alert>
            )}
            {tree.inProgress &&
              tree.inProgress !== 'merge' &&
              tree.inProgress !== 'cherry-pick' && (
                <Alert role="status" className="border-warning/40">
                  <TriangleAlert className="text-warning" />
                  <AlertDescription>
                    {IN_PROGRESS_TEXT[tree.inProgress]} Finish or abort it in a terminal; ATLAS does
                    not resolve conflicts for you.
                  </AlertDescription>
                </Alert>
              )}
            {tree.truncated && (
              <p className="text-warning text-xs" role="status">
                Only the first {tree.files.length} changed files are listed.
              </p>
            )}

            <div className="grid shrink-0 grid-cols-1 gap-3 lg:min-h-80 lg:flex-1 lg:shrink lg:grid-cols-[minmax(260px,380px)_minmax(0,1fr)]">
              <section
                className="max-h-80 min-h-32 min-w-0 overflow-y-auto rounded-lg border p-2 lg:max-h-none"
                aria-label="Changed files"
              >
                {tree.files.length === 0 ? (
                  <p className="text-muted-foreground p-2 text-sm" data-testid="git-clean">
                    Working tree clean.
                  </p>
                ) : (
                  <ChangesList
                    files={tree.files}
                    selection={shownSelection}
                    busy={busy}
                    onSelect={(value) =>
                      setSelected({ root: tree.repositoryRoot, selection: value })
                    }
                    onStage={(paths) =>
                      void mutate(() =>
                        unwrap(api().git.stage({ repositoryRoot: tree.repositoryRoot, paths })),
                      )
                    }
                    onUnstage={(paths) =>
                      void mutate(() =>
                        unwrap(api().git.unstage({ repositoryRoot: tree.repositoryRoot, paths })),
                      )
                    }
                  />
                )}
              </section>
              <section
                className="bg-terminal h-96 min-w-0 overflow-hidden rounded-lg border lg:h-auto"
                aria-label="Diff"
              >
                <DiffViewer
                  diff={diff}
                  error={diffError}
                  empty={shownSelection === null}
                  {...(reviewAction ? { action: reviewAction } : {})}
                />
              </section>
            </div>
          </>
        )}
      </div>

      {tree && dialog === 'commit' && (
        <CommitDialog
          tree={tree}
          preferences={preferences}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void refresh();
          }}
        />
      )}
      {tree && dialog === 'push' && (
        <PushDialog tree={tree} onClose={() => setDialog(null)} onDone={() => setDialog(null)} />
      )}
      {tree && dialog === 'pull' && (
        <PullDialog tree={tree} onClose={() => setDialog(null)} onDone={() => setDialog(null)} />
      )}
      {tree && (
        <OperationsSheet
          repositoryName={tree.repositoryName}
          repositoryRoot={tree.repositoryRoot}
          operations={operations}
          open={operationsSheet.open}
          onOpenChange={operationsSheet.setOpen}
        />
      )}
      {tree && dialog === 'merge' && (
        <MergeDialog
          tree={tree}
          onClose={() => setDialog(null)}
          onCommit={() =>
            // The merge ran in the dialog: refresh first so the commit dialog sees it.
            void refresh().then(() => setDialog('commit'))
          }
        />
      )}
      {tree && dialog === 'abort-merge' && (
        <AlertDialog open onOpenChange={(open) => !open && setDialog(null)}>
          <AlertDialogContent data-testid="abort-merge-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Abort the merge?</AlertDialogTitle>
              <AlertDialogDescription>
                The branch goes back to its state before the merge. Conflict resolutions and other
                changes made during the merge are lost.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep merging</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  setDialog(null);
                  void mutate(() => unwrap(api().git.abortMerge(tree.repositoryRoot)));
                }}
              >
                Abort merge
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {tree && dialog === 'cherry-pick' && (
        <CherryPickDialog
          tree={tree}
          onClose={() => {
            setDialog(null);
            void refresh();
          }}
        />
      )}
      {tree && dialog === 'abort-cherry-pick' && (
        <AlertDialog open onOpenChange={(open) => !open && setDialog(null)}>
          <AlertDialogContent data-testid="abort-cherry-pick-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Abort the cherry-pick?</AlertDialogTitle>
              <AlertDialogDescription>
                The branch goes back to its state before the cherry-pick, including commits it
                already applied. Conflict resolutions made since are lost.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep going</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  setDialog(null);
                  setCherryResult(null);
                  void mutate(() => unwrap(api().git.abortCherryPick(tree.repositoryRoot)));
                }}
              >
                Abort cherry-pick
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {tree && dialog === 'checks' && (
        <CommitSettingsDialog
          repositoryRoot={tree.repositoryRoot}
          onClose={() => setDialog(null)}
        />
      )}
      {tree && dialog === 'branches' && (
        <BranchesDialog tree={tree} onClose={() => setDialog(null)} />
      )}
    </main>
  );
}
