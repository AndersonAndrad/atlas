import type { JobDetails } from '@atlas/contracts';
import { X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { api, unwrap } from '@/api';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { LogViewer } from '@/preflight/components/LogViewer';
import { formatDuration, formatTime } from '@/preflight/format';
import { JOB_STATUS_LABELS, JOB_TYPE_LABELS, jobDuration, jobStatusClass } from '../format';
import { JobActions, type JobActionHandlers } from './JobActions';

/** What a job ran, how each attempt ended, its status history and its log (FR-1210). */
export function JobDetailsPanel({
  details,
  projectName,
  now,
  onClose,
  actions,
}: {
  details: JobDetails;
  projectName: string | null;
  now: number;
  onClose: () => void;
  actions: JobActionHandlers;
}) {
  const { job, attempts, history } = details;
  const latest = job.retryCount + 1;
  const [chosenAttempt, setChosenAttempt] = useState<number | null>(null);
  const attempt = chosenAttempt ?? latest;
  const load = useCallback(
    (after: number) => unwrap(api().jobs.output({ jobId: job.id, attempt, after })),
    [job.id, attempt],
  );

  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-md border p-3"
      aria-labelledby="job-details-title"
      data-testid="job-details"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id="job-details-title" className="font-semibold break-words">
            {job.title}
          </h2>
          <p className="text-muted-foreground text-xs">
            {JOB_TYPE_LABELS[job.type]}
            {projectName ? ` · ${projectName}` : ''}
            {job.description && job.description !== projectName ? ` · ${job.description}` : ''}
          </p>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Close job details" onClick={onClose}>
          <X />
        </Button>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd className={cn('font-medium', jobStatusClass(job.status))} data-testid="job-status">
          {JOB_STATUS_LABELS[job.status]}
          {job.cancelRequested && job.status === 'RUNNING' ? ' (stopping)' : ''}
        </dd>
        <dt className="text-muted-foreground">Queued</dt>
        <dd>{formatTime(job.queuedAt)}</dd>
        <dt className="text-muted-foreground">Started</dt>
        <dd>{formatTime(job.startedAt)}</dd>
        <dt className="text-muted-foreground">Duration</dt>
        <dd>{formatDuration(jobDuration(job, now))}</dd>
        {job.exitCode !== null && (
          <>
            <dt className="text-muted-foreground">Exit code</dt>
            <dd>{job.exitCode}</dd>
          </>
        )}
        {job.retryCount > 0 && (
          <>
            <dt className="text-muted-foreground">Retries</dt>
            <dd>{job.retryCount}</dd>
          </>
        )}
      </dl>
      {job.errorSummary && (
        <p className="text-destructive text-sm" data-testid="job-error">
          {job.errorSummary}
        </p>
      )}
      {job.payload.type === 'COMMAND' && (
        <pre className="bg-muted/40 overflow-x-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap break-all">
          {job.payload.command}
        </pre>
      )}
      <JobActions job={job} handlers={actions} />
      {job.capabilities.logs && (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">Output</h3>
            {attempts.length > 1 && (
              <Select
                value={String(attempt)}
                onValueChange={(value) => setChosenAttempt(Number(value))}
              >
                <SelectTrigger size="sm" className="w-36" aria-label="Attempt">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {attempts.map((item) => (
                    <SelectItem key={item.attempt} value={String(item.attempt)}>
                      Attempt {item.attempt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <LogViewer
            key={`${job.id}:${attempt}:${job.status === 'QUEUED' ? 'queued' : 'started'}`}
            runId={job.id}
            position={attempt}
            load={load}
            label="Job output"
            testId="job-log"
          />
        </div>
      )}
      {attempts.length > 0 && (
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-medium">Attempts</h3>
          <ul className="flex flex-col gap-1 text-xs">
            {attempts.map((item) => (
              <li key={item.attempt} className="flex flex-wrap gap-x-2">
                <span>Attempt {item.attempt}</span>
                <span className={jobStatusClass(item.status)}>
                  {JOB_STATUS_LABELS[item.status]}
                </span>
                <span className="text-muted-foreground">{formatTime(item.startedAt)}</span>
                {item.errorSummary && (
                  <span className="text-muted-foreground min-w-0 break-words">
                    {item.errorSummary}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="min-w-0">
        <h3 className="mb-1 text-sm font-medium">History</h3>
        <ol className="flex flex-col gap-1 text-xs" data-testid="job-history">
          {history.map((change, index) => (
            <li key={`${change.at}-${index}`} className="flex flex-wrap gap-x-2">
              <span className="text-muted-foreground">{formatTime(change.at)}</span>
              <span className={jobStatusClass(change.status)}>
                {JOB_STATUS_LABELS[change.status]}
              </span>
              {change.detail && <span className="min-w-0 break-words">{change.detail}</span>}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
