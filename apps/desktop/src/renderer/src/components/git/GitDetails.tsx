import type { GitStatus, ProjectGitSnapshot, ProjectGitState } from '@atlas/contracts';
import { GitBranch, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { formatDate } from '@/format';
import {
  GIT_UNAVAILABLE_LABELS,
  branchLabel,
  relativeTime,
  trackingDescription,
} from './git-format';

interface GitDetailsProps {
  status: GitStatus | null;
  loading: boolean;
  onRefresh: () => void;
  /** Stored state and monitoring preference (SDD-024); undefined while loading. */
  gitState?: ProjectGitState | undefined;
  onMonitoringChange?: (enabled: boolean) => void;
  monitoringError?: string | null;
}

/** Repository details of a project. Never shows invented counts. */
export function GitDetails({
  status,
  loading,
  onRefresh,
  gitState,
  onMonitoringChange,
  monitoringError,
}: GitDetailsProps) {
  const cached = status === null && !loading ? (gitState?.snapshot ?? null) : null;
  return (
    <section
      className="bg-card flex flex-col gap-3 rounded-lg border p-4"
      aria-labelledby="git-title"
      data-testid="git-details"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 id="git-title" className="flex items-center gap-2 font-semibold">
          <GitBranch className="size-4" aria-hidden="true" />
          Git
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh Git status"
        >
          <RefreshCw className={loading ? 'animate-spin' : undefined} />
          Refresh
        </Button>
      </header>
      {gitState !== undefined && (
        <GitMonitoring
          state={gitState}
          onChange={onMonitoringChange}
          error={monitoringError ?? null}
        />
      )}
      {cached !== null ? (
        <CachedGitBody snapshot={cached} />
      ) : (
        <GitBody status={status} loading={loading} />
      )}
    </section>
  );
}

const FRESHNESS_LABELS = { live: 'Live', cached: 'Cached', none: 'No data yet' } as const;

/** Monitoring switch, whether the data is live or cached, and the last refresh (FR-007). */
function GitMonitoring({
  state,
  onChange,
  error,
}: {
  state: ProjectGitState;
  onChange: ((enabled: boolean) => void) | undefined;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="git-monitoring">
      <div className="flex items-start gap-2">
        <Checkbox
          id="git-monitoring-enabled"
          className="mt-0.5"
          checked={state.monitoringEnabled}
          disabled={onChange === undefined}
          onCheckedChange={(checked) => onChange?.(checked === true)}
          aria-describedby="git-monitoring-help"
        />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="git-monitoring-enabled" className="font-normal">
            Monitor Git status automatically
          </Label>
          <p id="git-monitoring-help" className="text-muted-foreground text-xs">
            {state.monitoringEnabled
              ? 'ATLAS checks this repository in the background. It never fetches, pulls or pushes.'
              : 'Paused: no background checks. The last known status is kept; use Refresh to update it.'}
          </p>
        </div>
      </div>
      <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <Badge
          variant={state.freshness === 'live' ? 'secondary' : 'outline'}
          data-testid="git-freshness"
          data-freshness={state.freshness}
        >
          {FRESHNESS_LABELS[state.freshness]}
        </Badge>
        <span data-testid="git-last-refresh">
          {state.refreshedAt === null
            ? 'Never refreshed'
            : `Last refreshed ${relativeTime(state.refreshedAt)} (${formatDate(state.refreshedAt)})`}
        </span>
      </p>
      {state.error !== null && (
        <p className="text-warning text-xs" role="status" data-testid="git-refresh-error">
          Last refresh failed: {GIT_UNAVAILABLE_LABELS[state.error.reason]}
        </p>
      )}
      {error !== null && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The stored subset shown while no live status was read (monitoring paused). */
function CachedGitBody({ snapshot }: { snapshot: ProjectGitSnapshot }) {
  if (snapshot.state === 'not-repository') {
    return (
      <p className="text-muted-foreground text-sm" data-testid="git-none">
        No Git repository (as of the last refresh).
      </p>
    );
  }
  const { changes } = snapshot;
  return (
    <dl
      className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm"
      data-testid="git-cached-details"
    >
      <dt className="text-muted-foreground">Current branch</dt>
      <dd data-testid="git-current-branch">{branchLabel(snapshot)}</dd>

      <dt className="text-muted-foreground">Changes</dt>
      <dd data-testid="git-changes">
        Modified: {changes.modified} · Staged: {changes.staged} · Untracked: {changes.untracked}
        {changes.conflicted > 0 && ` · Conflicted: ${changes.conflicted}`}
      </dd>

      <dt className="text-muted-foreground">Ahead / behind</dt>
      <dd data-testid="git-tracking">
        {snapshot.ahead !== null && snapshot.behind !== null ? (
          <span>
            ↑ {snapshot.ahead} ahead · ↓ {snapshot.behind} behind
          </span>
        ) : (
          <span className="text-muted-foreground">Unavailable</span>
        )}
        <p className="text-muted-foreground text-xs">{trackingDescription(snapshot)}</p>
      </dd>
    </dl>
  );
}

function GitBody({ status, loading }: { status: GitStatus | null; loading: boolean }) {
  if (status === null) {
    return (
      <p className="text-muted-foreground text-sm">
        {loading ? 'Reading Git information…' : 'Git information could not be read.'}
      </p>
    );
  }
  if (status.state === 'not-repository') {
    return (
      <p className="text-muted-foreground text-sm" data-testid="git-none">
        No Git repository. ATLAS works with plain folders and never initializes Git.
      </p>
    );
  }
  if (status.state === 'unavailable') {
    return (
      <p className="text-warning text-sm" data-testid="git-unavailable">
        {GIT_UNAVAILABLE_LABELS[status.reason]}
      </p>
    );
  }
  const { snapshot } = status;
  const { changes } = snapshot;
  const counters: [string, number, string][] = [
    ['Modified', changes.modified, 'Tracked files changed in the working tree, not staged'],
    ['Staged', changes.staged, 'Files with changes in the index'],
    ['Untracked', changes.untracked, 'Files not tracked by Git'],
    ['Deleted', changes.deleted, 'Deleted files, staged or not'],
    ['Renamed', changes.renamed, 'Staged renames'],
  ];
  if (changes.conflicted > 0)
    counters.push(['Conflicted', changes.conflicted, 'Unresolved merge conflicts']);

  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Repository root</dt>
      <dd className="font-mono text-xs break-all" data-testid="git-root">
        {snapshot.repositoryRoot}
      </dd>

      <dt className="text-muted-foreground">Current branch</dt>
      <dd data-testid="git-current-branch">
        {branchLabel(snapshot)}
        {snapshot.unbornHead && <span className="text-muted-foreground"> (no commits yet)</span>}
      </dd>

      <dt className="text-muted-foreground">Git user</dt>
      <dd data-testid="git-identity">
        {snapshot.identity.name ?? <span className="text-muted-foreground">Not configured</span>}
        {' · '}
        {snapshot.identity.email ?? (
          <span className="text-muted-foreground">no email configured</span>
        )}
      </dd>

      <dt className="text-muted-foreground">Local branches</dt>
      <dd data-testid="git-branch-count">{snapshot.localBranchCount}</dd>

      <dt className="text-muted-foreground">Recent branches by latest commit</dt>
      <dd>
        {snapshot.recentBranches.length === 0 ? (
          <span className="text-muted-foreground">None yet</span>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="git-recent-branches">
            {snapshot.recentBranches.map((branch) => (
              <li key={branch.name} className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{branch.name}</Badge>
                <span className="text-muted-foreground text-xs">
                  {relativeTime(branch.latestCommitAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </dd>

      <dt className="text-muted-foreground">Changes</dt>
      <dd>
        <p className="mb-1" data-testid="git-total">
          {changes.total === 0
            ? 'Working tree clean'
            : `${changes.total} changed file${changes.total === 1 ? '' : 's'}`}
        </p>
        <ul
          className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-3"
          data-testid="git-changes"
        >
          {counters.map(([label, value, title]) => (
            <li key={label} title={title}>
              {label}: <span className="text-foreground tabular-nums">{value}</span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-1 text-xs">
          A file can be both staged and modified; the total counts it once.
        </p>
      </dd>

      <dt className="text-muted-foreground">Ahead / behind</dt>
      <dd data-testid="git-tracking">
        {snapshot.ahead !== null && snapshot.behind !== null ? (
          <span>
            ↑ {snapshot.ahead} ahead · ↓ {snapshot.behind} behind
          </span>
        ) : (
          <span className="text-muted-foreground">Unavailable</span>
        )}
        <p className="text-muted-foreground text-xs">{trackingDescription(snapshot)}</p>
      </dd>

      <dt className="text-muted-foreground">Last refreshed</dt>
      <dd>{formatDate(snapshot.inspectedAt)}</dd>
    </dl>
  );
}
