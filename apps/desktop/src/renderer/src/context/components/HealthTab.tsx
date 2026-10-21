import type { ContextHealthReport, ContextTarget } from '@atlas/contracts';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { formatDateTime, formatTokens } from '../format';
import { useKeyedLoad } from '../hooks/useContextData';

interface HealthTabProps {
  target: ContextTarget;
  targetKey: string;
}

/**
 * Context Health (SDD-006 FR-608): counts and heuristic signals the user can act on.
 * Deliberately no overall score: these signals do not measure correctness.
 */
export function HealthTab({ target, targetKey }: HealthTabProps) {
  const loaded = useKeyedLoad(`${targetKey}:health`, () => api().context.health(target));
  const [reconciled, setReconciled] = useState<ContextHealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = reconciled ?? loaded.value;

  async function reconcile() {
    setBusy(true);
    setError(null);
    try {
      setReconciled(await unwrap(api().context.reconcile(target)));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="context-health">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground max-w-xl text-sm">
          Signals about stored context, checked against the repository now. They are heuristics to
          review, not a quality score.
        </p>
        <Button variant="outline" onClick={() => void reconcile()} disabled={busy}>
          <RefreshCw className={busy ? 'animate-spin' : undefined} />
          {busy ? 'Checking…' : 'Run reconciliation'}
        </Button>
      </div>
      {(error ?? loaded.error) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error ?? loaded.error}</AlertDescription>
        </Alert>
      )}
      {report === null ? (
        !loaded.error && <p className="text-muted-foreground text-sm">Checking…</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="context-health-totals">
            {(
              [
                ['Active entries', report.totals.activeEntries],
                ['Required entries', report.totals.requiredEntries],
                ['Obsolete entries', report.totals.obsoleteEntries],
                ['Active decisions', report.totals.activeDecisions],
                ['Superseded decisions', report.totals.supersededDecisions],
                ['Open tasks', `${report.totals.openTasks} of ${report.totals.tasks}`],
                ['Relevant context', formatTokens(report.estimatedRelevantTokens)],
                ['Branch', report.repository.branch ?? '—'],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex min-w-0 flex-col rounded-md border p-2">
                <dt className="text-muted-foreground text-xs">{label}</dt>
                <dd className="truncate text-sm font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground text-xs" data-testid="context-last-reconciliation">
            Last reconciliation:{' '}
            {report.lastReconciliation
              ? `${formatDateTime(report.lastReconciliation.at)} (${report.lastReconciliation.stale} stale, ${report.lastReconciliation.conflicts} conflicts, ${report.lastReconciliation.duplicates} duplicate groups)`
              : 'never'}
            {' · '}Relevant context is estimated ({report.tokenEstimateMethod}).
          </p>
          {report.checksTruncated && (
            <p className="text-warning text-xs">
              Only the first references were checked against Git; the rest were not verified.
            </p>
          )}
          <Signal
            title="Stale references"
            empty="No references to changed or removed files or commits."
            items={report.stale.map((item) => item.reason)}
            testId="health-stale"
          />
          <Signal
            title="Conflicts"
            empty="No conflicting decisions or notes found."
            items={report.conflicts.map((item) => item.reason)}
            testId="health-conflicts"
          />
          <Signal
            title="Duplicates"
            empty="No duplicate records found."
            items={report.duplicates.map(
              (group) => `${group.duplicateIds.length + 1} equivalent records (kept in history)`,
            )}
            testId="health-duplicates"
          />
          <Signal
            title="Pending work of closed tasks"
            empty="No pending items left on finished tasks."
            items={report.pendingOfClosedTasks.map((item) => item.title)}
            testId="health-pending"
          />
          <Signal
            title="Facts without a source"
            empty="Every factual record points at files, a commit or a session."
            items={report.missingSources.map((item) => item.title)}
            testId="health-sources"
          />
        </>
      )}
    </div>
  );
}

function Signal({
  title,
  empty,
  items,
  testId,
}: {
  title: string;
  empty: string;
  items: string[];
  testId: string;
}) {
  return (
    <section className="rounded-md border p-3" data-testid={testId}>
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {title}
        <span className="text-muted-foreground text-xs tabular-nums">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-xs">{empty}</p>
      ) : (
        <ul className="mt-1 list-disc pl-5 text-sm">
          {items.slice(0, 20).map((item, index) => (
            <li key={index} className="break-words">
              {item}
            </li>
          ))}
          {items.length > 20 && (
            <li className="text-muted-foreground list-none text-xs">
              …and {items.length - 20} more
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
