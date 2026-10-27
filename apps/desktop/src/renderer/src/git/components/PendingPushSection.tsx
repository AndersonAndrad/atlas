import { isFinalJobStatus } from '@atlas/contracts';
import type {
  BackgroundJob,
  GitCommitFiles,
  GitWorkingTree,
  PendingCommit,
  PendingCommitsState,
  ProjectGitState,
} from '@atlas/contracts';
import { ChevronDown, ChevronRight, GitCommitHorizontal, RefreshCw, Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { relativeTime } from '@/components/git/git-format';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { ProjectDetails } from '@/types';
import { putProjectGitState, useProjectGitStates } from '../state/project-git-states';
import { plural } from '../format';
import { CommitFilesPanel } from './OperationHistory';
import { PushDialog } from './RemoteDialogs';
import { SubmittedNotice } from '@/operations/components/SubmittedNotice';
import { onTerminalLifecycle } from '@/terminal/state/terminal-events';

/** Why pending commits cannot be listed; never presented as "everything pushed". */
const UNKNOWN_LABELS: Record<Exclude<PendingCommitsState, 'ok' | 'unborn'>, string> = {
  'no-upstream': 'Upstream not configured',
  'upstream-gone': 'Upstream branch no longer exists',
  detached: 'Detached HEAD',
  error: 'Could not read pending commits',
};

interface Group {
  item: ProjectDetails;
  state: ProjectGitState;
  snapshot: Extract<NonNullable<ProjectGitState['snapshot']>, { state: 'repository' }>;
}

/**
 * Local commits not pushed to their upstream, across projects (SDD-024 Task 02). Rendered
 * from stored snapshots: showing it never runs Git. Refresh, Load more and Push are explicit.
 */
export function PendingPushSection({ projects }: { projects: ProjectDetails[] }) {
  const states = useProjectGitStates();
  const [collapsed, setCollapsed] = useState(false);
  /** The last push handed to the Engine; it keeps running after its dialog closed. */
  const [submitted, setSubmitted] = useState<BackgroundJob | null>(null);
  const submittedId = submitted?.id ?? null;
  const submittedProject = submitted?.projectId ?? null;
  useEffect(() => {
    if (submittedId === null || submittedProject === null) return;
    // Monitored projects are refreshed by the Engine after the push; reading again once the
    // job finished also updates a paused project's stored list (the user asked for it).
    return onTerminalLifecycle((event) => {
      if (event.type !== 'jobs' || event.job.id !== submittedId) return;
      if (!isFinalJobStatus(event.job.status)) return;
      unwrap(api().git.refreshProject(submittedProject)).then(
        ({ state }) => putProjectGitState(state),
        () => undefined,
      );
    });
  }, [submittedId, submittedProject]);

  const groups: Group[] = [];
  let upToDate = 0;
  for (const item of projects) {
    const state = states.get(item.project.id);
    const snapshot = state?.snapshot;
    if (state === undefined || snapshot?.state !== 'repository' || snapshot.pending === null) {
      continue;
    }
    const { pending } = snapshot;
    if (pending.state === 'unborn') continue;
    if (pending.state === 'ok' && (pending.total ?? pending.commits.length) === 0) {
      upToDate += 1;
      continue;
    }
    groups.push({ item, state, snapshot });
  }
  const total = groups.reduce(
    (sum, group) =>
      group.snapshot.pending?.state === 'ok'
        ? sum + (group.snapshot.pending.total ?? group.snapshot.pending.commits.length)
        : sum,
    0,
  );

  return (
    <section
      className="mt-1 border-t"
      aria-labelledby="pending-push-title"
      data-testid="pending-push"
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1">
        <button
          type="button"
          className="text-muted-foreground flex items-center gap-1 rounded-sm text-[11px] font-semibold tracking-wider uppercase outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? (
            <ChevronRight className="size-3" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3" aria-hidden="true" />
          )}
          <span id="pending-push-title">Pending push</span>
        </button>
        {total > 0 && (
          <span
            className="bg-warning/15 text-warning rounded-full px-2 text-[11px] font-medium tabular-nums"
            data-testid="pending-push-total"
            aria-label={`${plural(total, 'commit')} to push`}
          >
            {total}
          </span>
        )}
      </div>
      {!collapsed && (
        <div className="flex flex-col gap-1.5 px-1.5 pb-3">
          {submitted !== null && (
            <SubmittedNotice job={submitted} onDismiss={() => setSubmitted(null)} />
          )}
          {groups.length === 0 ? (
            <p className="text-muted-foreground px-2 text-xs" data-testid="pending-push-empty">
              No pending commits found in the stored Git status.
            </p>
          ) : (
            groups.map((group) => (
              <PendingProject
                key={group.item.project.id}
                group={group}
                onSubmitted={setSubmitted}
              />
            ))
          )}
          {upToDate > 0 && (
            <p
              className="text-muted-foreground px-2 text-[11px]"
              data-testid="pending-push-up-to-date"
            >
              {plural(upToDate, 'project')} up to date (as of the last fetch).
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function PendingProject({
  group,
  onSubmitted,
}: {
  group: Group;
  onSubmitted: (job: BackgroundJob) => void;
}) {
  const { item, state, snapshot } = group;
  const pending = snapshot.pending!;
  const ok = pending.state === 'ok';
  const count = ok ? (pending.total ?? pending.commits.length) : null;
  const [expanded, setExpanded] = useState(ok);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Extra pages read live; keyed by the commit they continue, so a new list drops them.
  const [more, setMore] = useState<{ headOid: string | null; commits: PendingCommit[] }>({
    headOid: snapshot.headOid,
    commits: [],
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<PendingCommit | null>(null);
  const [pushTree, setPushTree] = useState<GitWorkingTree | null>(null);
  const [preparingPush, setPreparingPush] = useState(false);
  const repositoryRoot = item.git.repositoryRoot ?? item.project.git.repositoryRoot ?? null;
  const extra = more.headOid === snapshot.headOid ? more.commits : [];
  const commits = [...pending.commits, ...extra];
  const name = item.project.name;

  const refresh = () => {
    setRefreshing(true);
    setError(null);
    unwrap(api().git.refreshProject(item.project.id))
      .then(({ state: next }) => putProjectGitState(next))
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => setRefreshing(false));
  };

  const loadMore = () => {
    setLoadingMore(true);
    setError(null);
    unwrap(api().git.pendingCommits(item.project.id, commits.length))
      .then((page) => {
        if (page.headOid !== snapshot.headOid || page.branch !== snapshot.branch) {
          setError('The branch changed since the list was read. Refresh to update it.');
          return;
        }
        setMore({ headOid: snapshot.headOid, commits: [...extra, ...page.commits] });
      })
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => setLoadingMore(false));
  };

  const preparePush = () => {
    if (repositoryRoot === null) return;
    setPreparingPush(true);
    setError(null);
    // An explicit action: the live working tree gives the dialog its current destination.
    unwrap(api().git.workingTree(repositoryRoot))
      .then(setPushTree)
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => setPreparingPush(false));
  };

  const freshness = state.freshness === 'live' ? 'Live' : 'Cached';
  const updated = state.refreshedAt === null ? '' : `, updated ${relativeTime(state.refreshedAt)}`;

  return (
    <div
      className="bg-card rounded-md border"
      data-testid="pending-push-project"
      data-project-id={item.project.id}
      data-state={pending.state}
    >
      <div className="flex min-w-0 items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-expanded={expanded}
          aria-label={`${name}: ${ok ? `${plural(count ?? 0, 'commit')} to push` : UNKNOWN_LABELS[pending.state as keyof typeof UNKNOWN_LABELS]}`}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate font-medium">{name}</span>
        </button>
        {ok ? (
          <span
            className="bg-warning/15 text-warning shrink-0 rounded-full px-1.5 text-[11px] font-medium tabular-nums"
            data-testid="pending-push-count"
          >
            {count}
          </span>
        ) : (
          <span className="text-muted-foreground shrink-0 rounded-full border border-dashed px-1.5 text-[11px]">
            ?
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={refresh}
          disabled={refreshing}
          aria-label={`Refresh Git status of ${name}`}
          title="Refresh Git status"
        >
          <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} />
        </Button>
      </div>
      {expanded && (
        <div className="flex min-w-0 flex-col gap-1 border-t px-2 py-1.5 text-xs">
          <p className="text-muted-foreground truncate font-mono" data-testid="pending-push-route">
            {snapshot.branch ?? 'detached HEAD'}
            {snapshot.upstream !== null && ` → ${snapshot.upstream}`}
          </p>
          <p className="text-muted-foreground text-[11px]" data-testid="pending-push-freshness">
            {freshness}
            {updated}
            {!state.monitoringEnabled && ' · monitoring paused'}
          </p>
          {!ok && (
            <p className="text-warning" role="status" data-testid="pending-push-unknown">
              {UNKNOWN_LABELS[pending.state as keyof typeof UNKNOWN_LABELS]}. Pending commits cannot
              be determined.
            </p>
          )}
          {ok && (
            <ul className="flex min-w-0 flex-col" aria-label={`Pending commits of ${name}`}>
              {commits.map((commit) => (
                <li key={commit.hash}>
                  <button
                    type="button"
                    className="hover:bg-accent/60 flex w-full min-w-0 items-start gap-1.5 rounded-sm px-1 py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    onClick={() => setSelected(commit)}
                    data-testid="pending-commit"
                    title={`${commit.subject}\n${commit.author}${commit.committedAt ? ` · ${commit.committedAt}` : ''}`}
                  >
                    <GitCommitHorizontal
                      className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{commit.subject || '(no subject)'}</span>
                      <span className="text-muted-foreground truncate font-mono text-[11px]">
                        {commit.shortHash} · {commit.author} · {relativeTime(commit.committedAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {ok && count !== null && commits.length < count && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 self-start text-xs"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : `Load more (${count - commits.length} more)`}
            </Button>
          )}
          {error && (
            <p className="text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-muted-foreground text-[11px]">As of the last fetch.</span>
            {ok && (count ?? 0) > 0 && repositoryRoot !== null && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={preparePush}
                disabled={preparingPush}
                aria-label={`Push ${name}`}
              >
                <Upload className="size-3" />
                {preparingPush ? 'Preparing…' : 'Push'}
              </Button>
            )}
          </div>
        </div>
      )}
      {selected !== null && repositoryRoot !== null && (
        <CommitDetailsDialog
          repositoryRoot={repositoryRoot}
          commit={selected}
          onClose={() => setSelected(null)}
        />
      )}
      {pushTree !== null && (
        <PushDialog
          tree={pushTree}
          onClose={() => setPushTree(null)}
          onSubmitted={(job) => {
            setPushTree(null);
            onSubmitted(job);
          }}
        />
      )}
    </div>
  );
}

function CommitDetailsDialog({
  repositoryRoot,
  commit,
  onClose,
}: {
  repositoryRoot: string;
  commit: PendingCommit;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<GitCommitFiles | null | undefined>(undefined);
  const onLoaded = useCallback(
    (_hash: string, value: GitCommitFiles | null) => setFiles(value),
    [],
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="pending-commit-details">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{commit.shortHash}</DialogTitle>
          <DialogDescription>Not pushed yet (as of the last fetch).</DialogDescription>
        </DialogHeader>
        <CommitFilesPanel
          repositoryRoot={repositoryRoot}
          hash={commit.hash}
          cached={files}
          onLoaded={onLoaded}
        />
      </DialogContent>
    </Dialog>
  );
}
