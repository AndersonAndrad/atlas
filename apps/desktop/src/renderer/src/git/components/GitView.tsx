import type { GitRemote } from '@atlas/contracts';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CloudDownload,
  ListChecks,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { relativeTime } from '@/components/git/git-format';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { OperationsPanel } from './OperationsPanel';
import { PullDialog, PushDialog } from './RemoteDialogs';

/** Opens the Git view on the repository of a project or a terminal. */
export interface GitOpenRequest {
  projectId?: string;
  terminalId?: string;
  nonce: number;
}

type GitDialog = 'commit' | 'push' | 'pull' | 'branches' | 'checks' | null;

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
  const [dialog, setDialog] = useState<GitDialog>(null);
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
        <div className="flex min-w-0 items-center gap-2">
          {repositories !== null && repositories.length > 0 && (
            <Select value={repositoryRoot ?? undefined} onValueChange={choose}>
              <SelectTrigger
                className="w-64 max-w-[60vw]"
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
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDialog('push')}
                  >
                    <ArrowUp />
                    Push…
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

            {tree.inProgress && (
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

            <section aria-labelledby="git-operations-title" className="rounded-lg border p-3">
              <h2
                id="git-operations-title"
                className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-wider uppercase"
              >
                Operations
              </h2>
              <OperationsPanel operations={operations} />
            </section>
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
