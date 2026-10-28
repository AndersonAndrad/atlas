import {
  ACTIVE_AUDIT_STATUSES,
  AUDIT_CATEGORY_LABELS,
  AUDIT_SEVERITIES,
  type AuditMetrics,
  type AuditScope,
  type ProjectAudit,
} from '@atlas/contracts';
import { ScanSearch, SquareTerminal, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/context/format';
import { useKeyedLoad } from '@/context/hooks/useContextData';
import { cn } from '@/lib/utils';
import { openOperationsJob } from '@/operations/navigation';
import { onTerminalLifecycle } from '@/terminal/state/terminal-events';
import { AUDIT_PROVIDER_LABELS, AUDIT_STATUS_LABELS, WORKSPACE_CHECK_LABELS } from './audit-labels';
import { FindingsReview } from './FindingsReview';

const SEVERITY_ORDER = new Map(AUDIT_SEVERITIES.map((severity, index) => [severity, index]));

/** The project's audits, newest first, kept current by `audit` events. */
function useProjectAudits(projectId: string) {
  const loaded = useKeyedLoad(`audits:${projectId}`, () => api().audit.list(projectId));
  const [updates, setUpdates] = useState<Map<string, ProjectAudit>>(new Map());
  useEffect(
    () =>
      onTerminalLifecycle((event) => {
        if (event.type !== 'audit' || event.audit.projectId !== projectId) return;
        setUpdates((current) => new Map(current).set(event.audit.id, event.audit));
      }),
    [projectId],
  );
  const merged = new Map((loaded.value ?? []).map((audit) => [audit.id, audit]));
  for (const [id, audit] of updates) if (audit.projectId === projectId) merged.set(id, audit);
  const audits = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { audits, loading: loaded.value === null && loaded.error === null, error: loaded.error };
}

export function scopeLabel(scope: AuditScope, files: readonly string[]): string {
  switch (scope.kind) {
    case 'project':
      return 'Entire project';
    case 'changed':
      return `Changed files (${files.length})`;
    case 'directories':
      return `Folders: ${scope.paths.join(', ')}`;
    case 'files':
      return `Files: ${scope.paths.join(', ')}`;
  }
}

function metricsLabel(metrics: AuditMetrics | null): string {
  if (metrics === null) return 'Not reported by the provider';
  const parts = [
    metrics.inputTokens === null ? null : `${metrics.inputTokens.toLocaleString()} input tokens`,
    metrics.outputTokens === null ? null : `${metrics.outputTokens.toLocaleString()} output tokens`,
    metrics.costUsd === null ? null : `≈ US$ ${metrics.costUsd.toFixed(2)} (provider estimate)`,
    metrics.durationMs === null ? null : `${Math.round(metrics.durationMs / 1000)} s`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'Not reported by the provider' : parts.join(' · ');
}

interface AuditsPanelProps {
  projectId: string;
  onAnalyze: () => void;
  /** Shows a task created from a finding; `execute` opens Execute with ATLAS for it. */
  onOpenTask: (taskId: string, options: { execute: boolean }) => void;
}

/**
 * Audits of a project (SDD-026 Task 01): history and the validated findings of each run,
 * which the user turns into tasks, rejects or defers (PLAN-056).
 */
export function AuditsPanel({ projectId, onAnalyze, onOpenTask }: AuditsPanelProps) {
  const { audits, loading, error } = useProjectAudits(projectId);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const selected = audits.find((audit) => audit.id === chosenId) ?? audits[0] ?? null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 lg:flex-row"
      data-testid="hub-audits"
    >
      <section className="flex shrink-0 flex-col gap-2 lg:w-72" aria-label="Audit history">
        <Button onClick={onAnalyze} data-testid="hub-analyze-project">
          <ScanSearch />
          Analyze project…
        </Button>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {loading && <p className="text-muted-foreground text-sm">Loading audits…</p>}
        {!loading && audits.length === 0 && !error && (
          <p className="text-muted-foreground text-sm" data-testid="audits-empty">
            No audits yet. Analyze the project to get findings you can review.
          </p>
        )}
        <ul className="flex flex-col gap-1.5">
          {audits.map((audit) => (
            <li key={audit.id}>
              <button
                type="button"
                className={cn(
                  'hover:bg-accent/60 flex w-full min-w-0 flex-col gap-0.5 rounded-md border p-2 text-left text-sm',
                  selected?.id === audit.id && 'border-sidebar-primary bg-accent/40',
                )}
                aria-current={selected?.id === audit.id ? 'true' : undefined}
                onClick={() => setChosenId(audit.id)}
                data-testid="audit-history-item"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{AUDIT_PROVIDER_LABELS[audit.provider]}</span>
                  <span className="text-muted-foreground text-xs">
                    {AUDIT_STATUS_LABELS[audit.status]}
                  </span>
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatDateTime(audit.createdAt)}
                  {audit.status === 'COMPLETED' ? ` · ${audit.findingCount} finding(s)` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {selected !== null && (
        <AuditDetailsView key={selected.id} audit={selected} onOpenTask={onOpenTask} />
      )}
    </div>
  );
}

function AuditDetailsView({
  audit,
  onOpenTask,
}: {
  audit: ProjectAudit;
  onOpenTask: AuditsPanelProps['onOpenTask'];
}) {
  // Findings are stored once, when the audit completes.
  const details = useKeyedLoad(audit.status === 'COMPLETED' ? `audit:${audit.id}` : null, () =>
    api().audit.get(audit.id),
  );
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const active = ACTIVE_AUDIT_STATUSES.includes(audit.status);
  const findings = [...(details.value?.findings ?? [])].sort(
    (a, b) =>
      (SEVERITY_ORDER.get(a.severity) ?? 0) - (SEVERITY_ORDER.get(b.severity) ?? 0) ||
      a.ordinal - b.ordinal,
  );

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      await unwrap(api().audit.cancel(audit.id));
    } catch (caught) {
      setCancelError(errorMessage(caught));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section
      className="flex min-w-0 flex-1 flex-col gap-3"
      aria-label="Audit results"
      data-testid="audit-details"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold" data-testid="audit-status">
          {AUDIT_STATUS_LABELS[audit.status]}
          {audit.status === 'COMPLETED' ? ` · ${audit.findingCount} finding(s)` : ''}
        </h2>
        <div className="flex flex-wrap gap-2">
          {audit.jobId !== null && (
            <Button variant="outline" size="sm" onClick={() => openOperationsJob(audit.jobId!)}>
              <SquareTerminal />
              View log
            </Button>
          )}
          {active && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void cancel()}
              disabled={cancelling}
              data-testid="audit-cancel"
            >
              {cancelling ? 'Cancelling…' : 'Cancel audit'}
            </Button>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border p-3 text-sm">
        <dt className="text-muted-foreground">Provider</dt>
        <dd>
          {AUDIT_PROVIDER_LABELS[audit.provider]} · {audit.profileName ?? 'default account'}
        </dd>
        <dt className="text-muted-foreground">Categories</dt>
        <dd className="break-words">
          {audit.categories.map((category) => AUDIT_CATEGORY_LABELS[category]).join(', ')}
        </dd>
        <dt className="text-muted-foreground">Scope</dt>
        <dd className="break-words">{scopeLabel(audit.scope, audit.scopeFiles)}</dd>
        <dt className="text-muted-foreground">Started</dt>
        <dd>{formatDateTime(audit.startedAt ?? audit.createdAt)}</dd>
        {audit.finishedAt && (
          <>
            <dt className="text-muted-foreground">Finished</dt>
            <dd>{formatDateTime(audit.finishedAt)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Usage</dt>
        <dd data-testid="audit-metrics">{metricsLabel(audit.metrics)}</dd>
      </dl>

      {audit.errorSummary && (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid="audit-error">{audit.errorSummary}</AlertDescription>
        </Alert>
      )}
      {cancelError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{cancelError}</AlertDescription>
        </Alert>
      )}
      {audit.workspaceCheck !== null && (
        <Alert
          role={audit.workspaceCheck === 'changed' ? 'alert' : 'status'}
          className={cn(audit.workspaceCheck === 'changed' && 'border-warning/40')}
          data-testid="audit-workspace-check"
        >
          {audit.workspaceCheck === 'changed' && <TriangleAlert className="text-warning" />}
          <AlertDescription className="flex flex-col gap-1">
            <span>{WORKSPACE_CHECK_LABELS[audit.workspaceCheck]}</span>
            {audit.changedPaths.length > 0 && (
              <span className="font-mono text-xs break-all">{audit.changedPaths.join(', ')}</span>
            )}
          </AlertDescription>
        </Alert>
      )}
      {audit.summary && (
        <p className="text-sm break-words whitespace-pre-wrap" data-testid="audit-summary">
          {audit.summary}
        </p>
      )}
      {audit.status === 'COMPLETED' && (
        <p className="text-muted-foreground text-xs">
          Findings are the provider’s claims. ATLAS checked that the files, lines and quoted code
          exist; it did not confirm the issues. {audit.needsReviewCount} need manual review,{' '}
          {audit.invalidCount} point at files that do not exist
          {audit.malformedCount > 0
            ? `, ${audit.malformedCount} malformed entr${audit.malformedCount === 1 ? 'y was' : 'ies were'} skipped`
            : ''}
          .
        </p>
      )}
      {details.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{details.error}</AlertDescription>
        </Alert>
      )}
      {details.value !== null && (
        <FindingsReview
          auditId={audit.id}
          findings={findings}
          decisions={details.value.decisions}
          onChanged={() => void details.reload()}
          onOpenTask={onOpenTask}
        />
      )}
    </section>
  );
}
