import type { PreflightRun } from '@atlas/contracts';
import { Download, FileText, RotateCcw, Square, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import {
  RUN_STATUS_LABELS,
  STATUS_LABELS,
  formatDuration,
  formatTime,
  statusClass,
} from '../format';
import { LogViewer } from './LogViewer';

const RETRYABLE = new Set(['FAILED', 'TIMED_OUT', 'CANCELLED', 'BLOCKED', 'SKIPPED']);

/** A run's checks, their status and output (FR-716 – FR-718). */
export function RunPanel({
  run,
  onCancel,
  onRetry,
}: {
  run: PreflightRun;
  onCancel: () => void;
  onRetry: (checkIds: string[]) => void;
}) {
  // Until the user picks a check, the panel follows the running check, then the first
  // check that did not pass.
  const [picked, setPicked] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const automatic =
    run.results.find((item) => item.status === 'RUNNING') ??
    run.results.find((item) => !['PASSED', 'PENDING', 'RUNNING'].includes(item.status)) ??
    run.results[0];
  const result = (picked === null ? undefined : run.results[picked]) ?? automatic;
  const retry = run.results
    .filter((item) => RETRYABLE.has(item.status))
    .map((item) => item.checkId);
  const running = run.status === 'RUNNING';

  async function report(action: 'copy' | 'save') {
    setMessage(null);
    try {
      const text = await unwrap(api().preflight.report(run.id));
      if (action === 'copy') {
        await copyText(text);
        setMessage('Report copied.');
      } else {
        const name = `preflight-${run.startedAt.slice(0, 19).replace(/[:T]/g, '-')}.md`;
        const { saved } = await unwrap(api().app.saveText(name, text));
        if (saved) setMessage('Report saved.');
      }
    } catch (caught) {
      setMessage(errorMessage(caught));
    }
  }

  return (
    <section className="flex flex-col gap-3" data-testid="preflight-run" aria-label="Run">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={statusClass(run.status)}
          data-testid="preflight-run-status"
        >
          {RUN_STATUS_LABELS[run.status]}
        </Badge>
        <span className="text-sm font-medium">{run.profileName}</span>
        <span className="text-muted-foreground text-xs">
          {formatTime(run.startedAt)}
          {run.branch ? ` · ${run.branch}` : ''}
          {run.sourceRevision ? ` · ${run.sourceRevision.slice(0, 10)}` : ''}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {running ? (
            <Button size="sm" variant="outline" onClick={onCancel}>
              <Square />
              Cancel
            </Button>
          ) : (
            retry.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => onRetry(retry)}>
                <RotateCcw />
                Retry {retry.length === 1 ? 'check' : `${retry.length} checks`}
              </Button>
            )
          )}
          <Button size="sm" variant="outline" onClick={() => void report('copy')}>
            <FileText />
            Copy report
          </Button>
          <Button size="sm" variant="outline" onClick={() => void report('save')}>
            <Download />
            Save report
          </Button>
        </div>
      </div>
      {message && <p className="text-muted-foreground text-sm">{message}</p>}
      {run.sourceChangedDuringRun && (
        <p className="text-warning flex items-center gap-1.5 text-sm">
          <TriangleAlert className="size-4" />
          The code changed while this run was in progress.
        </p>
      )}
      {!running && run.requiredOutcome !== 'NONE' && (
        <p className="text-sm">
          Required checks:{' '}
          <span
            className={statusClass(
              run.requiredOutcome === 'PASSED'
                ? 'PASSED'
                : run.requiredOutcome === 'FAILED'
                  ? 'FAILED'
                  : 'INCOMPLETE',
            )}
          >
            {RUN_STATUS_LABELS[run.requiredOutcome]}
          </span>
        </p>
      )}
      <div className="flex flex-col gap-3 lg:flex-row">
        <ul className="grid shrink-0 content-start gap-1 lg:w-72" aria-label="Checks">
          {run.results.map((item) => (
            <li key={item.position}>
              <button
                type="button"
                onClick={() => setPicked(item.position)}
                aria-current={item.position === result?.position}
                className={cn(
                  'hover:bg-accent flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm',
                  item.position === result?.position && 'bg-accent',
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {item.name}
                  {item.required && <span className="text-muted-foreground"> · required</span>}
                </span>
                <span className={cn('text-xs', statusClass(item.status))}>
                  {STATUS_LABELS[item.status]}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {result && (
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              <dt>Runs</dt>
              <dd className="font-mono break-all">{result.reference}</dd>
              <dt>Where</dt>
              <dd>{result.environment}</dd>
              <dt>Duration</dt>
              <dd>{formatDuration(result.durationMs)}</dd>
              {result.detail && (
                <>
                  <dt>Result</dt>
                  <dd className={statusClass(result.status)}>{result.detail}</dd>
                </>
              )}
            </dl>
            <LogViewer
              key={`${run.id}:${result.position}`}
              runId={run.id}
              position={result.position}
            />
          </div>
        )}
      </div>
    </section>
  );
}
