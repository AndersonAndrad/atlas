import {
  FINAL_JOB_STATUSES,
  JOB_CONCURRENCY_MAX,
  JOB_STATUSES,
  isFinalJobStatus,
  type BackgroundJob,
  type JobDetails,
  type JobStatus,
  type ProjectDetails,
} from '@atlas/contracts';
import { Activity, Plus, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatDuration, formatTime } from '@/preflight/format';
import {
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  jobDuration,
  jobProgressText,
  jobStatusClass,
} from '../format';
import { useJobEvents } from '../useJobs';
import { JobActions, type JobActionHandlers } from './JobActions';
import { JobDetailsPanel } from './JobDetailsPanel';
import { NewCommandJobDialog } from './NewCommandJobDialog';

export interface OperationsOpenRequest {
  jobId: string;
  nonce: number;
}

const ACTIVE_STATUSES: JobStatus[] = ['RUNNING', 'WAITING_APPROVAL', 'QUEUED'];
const PAGE = 30;
/** Job events arrive at most once a second per job; lists refresh after a short pause. */
const REFRESH_DELAY_MS = 250;

type StatusFilter = JobStatus | 'all';

interface JobLists {
  active: BackgroundJob[];
  history: BackgroundJob[];
  nextBefore: string | null;
}

/** Running and queued jobs, then the first page of history; one list for a status filter. */
async function fetchLists(
  query: { projectId?: string },
  statusFilter: StatusFilter,
): Promise<JobLists> {
  if (statusFilter !== 'all') {
    const page = await unwrap(api().jobs.list({ ...query, statuses: [statusFilter], limit: PAGE }));
    return { active: [], history: page.jobs, nextBefore: page.nextBefore };
  }
  const [current, finished] = await Promise.all([
    unwrap(api().jobs.list({ ...query, statuses: ACTIVE_STATUSES, limit: 200 })),
    unwrap(api().jobs.list({ ...query, statuses: [...FINAL_JOB_STATUSES], limit: PAGE })),
  ]);
  return { active: current.jobs, history: finished.jobs, nextBefore: finished.nextBefore };
}

function ProgressBar({ job }: { job: BackgroundJob }) {
  if (job.status !== 'RUNNING') return null;
  const percent = job.progress.percent;
  return (
    <div
      className="bg-muted h-1 w-full overflow-hidden rounded-full"
      role="progressbar"
      aria-label={`Progress of ${job.title}`}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(percent === null ? {} : { 'aria-valuenow': percent })}
    >
      <div
        className={cn('bg-primary h-full', percent === null && 'w-1/3 animate-pulse')}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

function JobRow({
  job,
  projectName,
  selected,
  now,
  onSelect,
  actions,
}: {
  job: BackgroundJob;
  projectName: string | null;
  selected: boolean;
  now: number;
  onSelect: () => void;
  actions: JobActionHandlers;
}) {
  const progress = jobProgressText(job);
  const duration = jobDuration(job, now);
  return (
    <li
      className={cn('flex flex-col gap-1.5 rounded-md border p-2', selected && 'border-primary')}
      data-testid="job-row"
      data-status={job.status}
    >
      <button
        type="button"
        className="flex min-w-0 flex-col gap-1 text-left"
        onClick={onSelect}
        aria-pressed={selected}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium" title={job.title}>
            {job.title}
          </span>
          <span className={cn('shrink-0 text-xs font-medium', jobStatusClass(job.status))}>
            {JOB_STATUS_LABELS[job.status]}
          </span>
        </span>
        <span className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
          <span>{JOB_TYPE_LABELS[job.type]}</span>
          {projectName && <span className="max-w-48 truncate">{projectName}</span>}
          <span>{formatTime(job.startedAt ?? job.queuedAt)}</span>
          {duration !== null && <span>{formatDuration(duration)}</span>}
          {job.retryCount > 0 && <span>Retried {job.retryCount}×</span>}
        </span>
        {job.status === 'RUNNING' && progress && (
          <span className="text-muted-foreground truncate text-xs">{progress}</span>
        )}
        {isFinalJobStatus(job.status) && job.errorSummary && (
          <span className="text-muted-foreground truncate text-xs">{job.errorSummary}</span>
        )}
      </button>
      <ProgressBar job={job} />
      <JobActions job={job} handlers={actions} compact />
    </li>
  );
}

/** Global and per-project limits of jobs running at once (FR-1206). */
function LimitsDialog({ onClose }: { onClose: () => void }) {
  const [total, setTotal] = useState('');
  const [perProject, setPerProject] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    unwrap(api().jobs.getSettings()).then(
      (settings) => {
        setTotal(String(settings.maxConcurrentJobs));
        setPerProject(String(settings.maxJobsPerProject));
      },
      (caught: unknown) => setError(errorMessage(caught)),
    );
  }, []);

  async function save() {
    const values = [total, perProject].map((value) => Number(value));
    if (
      values.some((value) => !Number.isInteger(value) || value < 1 || value > JOB_CONCURRENCY_MAX)
    ) {
      setError(`Enter whole numbers from 1 to ${JOB_CONCURRENCY_MAX}.`);
      return;
    }
    setBusy(true);
    try {
      await unwrap(
        api().jobs.setSettings({ maxConcurrentJobs: values[0]!, maxJobsPerProject: values[1]! }),
      );
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent data-testid="job-limits">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          noValidate
        >
          <DialogHeader>
            <DialogTitle>Job limits</DialogTitle>
            <DialogDescription>
              Jobs beyond these limits wait in the queue. Lower limits never stop running jobs or
              your terminals.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="jobs-total">Jobs at once</Label>
              <Input
                id="jobs-total"
                inputMode="numeric"
                value={total}
                onChange={(event) => setTotal(event.target.value.replace(/\D/g, ''))}
                maxLength={1}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="jobs-per-project">Per project</Label>
              <Input
                id="jobs-per-project"
                inputMode="numeric"
                value={perProject}
                onChange={(event) => setPerProject(event.target.value.replace(/\D/g, ''))}
                maxLength={1}
              />
            </div>
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Operations Center (SDD-012 FR-1211): background jobs of the Engine, running and
 * queued first, then history. Jobs keep running when this view or a terminal closes;
 * they stop when ATLAS quits.
 */
export function OperationsView({
  projects,
  request,
  onRequestHandled,
  onOpenPreflightRun,
  onOpenProject,
}: {
  projects: ProjectDetails[];
  request: OperationsOpenRequest | null;
  onRequestHandled: () => void;
  onOpenPreflightRun: (workspaceId: string, runId: string) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [active, setActive] = useState<BackgroundJob[]>([]);
  const [history, setHistory] = useState<BackgroundJob[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<JobDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [limits, setLimits] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const names = useMemo(
    () => new Map(projects.map(({ project }) => [project.id, project.name])),
    [projects],
  );
  const projectName = (job: BackgroundJob) =>
    job.projectId === null ? null : (names.get(job.projectId) ?? null);

  const query = useMemo(
    () => (projectFilter === 'all' ? {} : { projectId: projectFilter }),
    [projectFilter],
  );

  const apply = useCallback((lists: JobLists) => {
    setActive(lists.active);
    setHistory(lists.history);
    setNextBefore(lists.nextBefore);
    setError(null);
  }, []);

  const reload = useCallback(async () => {
    try {
      apply(await fetchLists(query, statusFilter));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [apply, query, statusFilter]);

  const showDetailsError = useCallback((caught: unknown) => {
    setDetails(null);
    setSelectedId(null);
    if (caught instanceof ApiError && caught.code === 'JOB_NOT_FOUND') {
      setNotice('This job no longer exists. Old jobs are removed after a while.');
    } else {
      setError(errorMessage(caught));
    }
  }, []);

  const loadDetails = useCallback(
    async (jobId: string) => {
      try {
        setDetails(await unwrap(api().jobs.get(jobId)));
      } catch (caught) {
        showDetailsError(caught);
      }
    },
    [showDetailsError],
  );

  useEffect(() => {
    let cancelled = false;
    fetchLists(query, statusFilter).then(
      (lists) => !cancelled && apply(lists),
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [apply, query, statusFilter]);

  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;
    unwrap(api().jobs.get(selectedId)).then(
      (loaded) => !cancelled && setDetails(loaded),
      (caught: unknown) => !cancelled && showDetailsError(caught),
    );
    return () => {
      cancelled = true;
    };
  }, [selectedId, showDetailsError]);
  /** Details of the selected job only; a closed or replaced job is not shown. */
  const shown = selectedId !== null && details?.job.id === selectedId ? details : null;

  // Opening a job from a notification.
  useEffect(() => {
    if (request === null) return;
    onRequestHandled();
    void (async () => {
      setNotice(null);
      setSelectedId(request.jobId);
    })();
  }, [request, onRequestHandled]);

  // Events refresh the lists and the open job, coalesced.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRef = useRef(selectedId);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);
  useJobEvents((job) => {
    if (pending.current === null) {
      pending.current = setTimeout(() => {
        pending.current = null;
        void reload();
      }, REFRESH_DELAY_MS);
    }
    if (job.id === selectedRef.current) void loadDetails(job.id);
  });
  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );

  // Durations of running jobs tick while any runs.
  const anyRunning = active.some((job) => job.status === 'RUNNING');
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  async function loadMore() {
    if (nextBefore === null) return;
    try {
      const page = await unwrap(
        api().jobs.list({
          ...query,
          statuses: statusFilter === 'all' ? [...FINAL_JOB_STATUSES] : [statusFilter],
          limit: PAGE,
          before: nextBefore,
        }),
      );
      setHistory((current) => [...(current ?? []), ...page.jobs]);
      setNextBefore(page.nextBefore);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const act = async (request: Promise<unknown>) => {
    setError(null);
    try {
      await request;
    } catch (caught) {
      setError(errorMessage(caught));
    }
    await reload();
    if (selectedRef.current !== null) await loadDetails(selectedRef.current);
  };

  const actions: JobActionHandlers = {
    cancel: (job) => void act(unwrap(api().jobs.cancel(job.id))),
    retry: (job) => void act(unwrap(api().jobs.retry(job.id))),
    openPreflightRun: onOpenPreflightRun,
    openProject: onOpenProject,
  };

  const renderList = (jobs: BackgroundJob[], label: string, empty: string) => (
    <section className="flex min-w-0 flex-col gap-2" aria-label={label}>
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {label}{' '}
        {jobs.length > 0 && `(${jobs.length}${label === 'History' && nextBefore ? '+' : ''})`}
      </h2>
      {jobs.length === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              projectName={projectName(job)}
              selected={job.id === selectedId}
              now={now}
              onSelect={() => setSelectedId(job.id === selectedId ? null : job.id)}
              actions={actions}
            />
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="operations-view">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Activity className="size-5" aria-hidden="true" />
          Operations
        </h1>
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger size="sm" className="w-48 max-w-full" aria-label="Project filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projects.map(({ project }) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value as StatusFilter)}
        >
          <SelectTrigger size="sm" className="w-44 max-w-full" aria-label="Status filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {JOB_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {JOB_STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => void reload()}>
            <RefreshCw />
            Reload
          </Button>
          <Button size="sm" variant="outline" onClick={() => setLimits(true)}>
            <SlidersHorizontal />
            Limits
          </Button>
          <Button size="sm" onClick={() => setCreating(true)} disabled={projects.length === 0}>
            <Plus />
            New command job
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <p className="text-muted-foreground text-xs">
          Background jobs run in the ATLAS Engine: closing this view, a terminal or the window does
          not stop them. Quitting ATLAS stops them, and they are reported as interrupted.
        </p>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            {statusFilter === 'all' &&
              renderList(active, 'Active', 'Nothing is running or queued.')}
            {history === null ? (
              <p className="text-muted-foreground text-sm">Loading…</p>
            ) : (
              renderList(
                history,
                statusFilter === 'all' ? 'History' : JOB_STATUS_LABELS[statusFilter],
                statusFilter === 'all' ? 'No finished jobs yet.' : 'No jobs with this status.',
              )
            )}
            {nextBefore !== null && (
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() => void loadMore()}
              >
                Load older jobs
              </Button>
            )}
          </div>
          {shown !== null && (
            <JobDetailsPanel
              key={shown.job.id}
              details={shown}
              projectName={projectName(shown.job)}
              now={now}
              onClose={() => setSelectedId(null)}
              actions={actions}
            />
          )}
        </div>
      </div>
      {creating && (
        <NewCommandJobDialog
          projects={projects}
          defaultProjectId={projectFilter === 'all' ? null : projectFilter}
          onClose={() => setCreating(false)}
          onQueued={(job) => {
            setCreating(false);
            setSelectedId(job.id);
            void reload();
          }}
        />
      )}
      {limits && <LimitsDialog onClose={() => setLimits(false)} />}
    </main>
  );
}
