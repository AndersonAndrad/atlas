import {
  GIT_OPERATION_KINDS,
  type GitCommandRecord,
  type GitOperationKind,
  type GitOperationLogDetails,
  type GitOperationLogEntry,
  type GitOperationStatus,
  type GitReflogEntry,
} from '@atlas/contracts';
import { Ban, CircleCheck, CircleX, Copy } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { relativeTime } from '@/components/git/git-format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { OPERATION_LABELS } from '../format';
import { OperationResult, formatDuration } from './OperationsPanel';

const ALL = '__all__';
const PAGE_SIZE = 50;
const STATUSES: GitOperationStatus[] = ['succeeded', 'failed', 'cancelled', 'running', 'queued'];

/** The log of one operation as plain text, for copying into an issue or a chat. */
function operationText(details: GitOperationLogDetails): string {
  const { operation, commands } = details;
  const lines = [
    `${OPERATION_LABELS[operation.kind]} — ${operation.status} — ${operation.repositoryRoot}`,
    `Started ${operation.startedAt}; finished ${operation.finishedAt ?? '—'}`,
    ...(operation.summary ? [operation.summary] : []),
    ...(operation.error ? [`Error (${operation.error.code}): ${operation.error.message}`] : []),
  ];
  for (const command of commands) {
    lines.push(
      '',
      `$ git ${command.args.join(' ')}`,
      `# ${command.outcome}, exit ${command.exitCode ?? '—'}, ${command.durationMs} ms`,
      ...(command.stdout ? [command.stdout] : []),
      ...(command.stderr ? [command.stderr] : []),
    );
  }
  return lines.join('\n');
}

function CommandRow({ command }: { command: GitCommandRecord }) {
  const Icon =
    command.outcome === 'succeeded' ? CircleCheck : command.outcome === 'failed' ? CircleX : Ban;
  return (
    <li className="flex min-w-0 flex-col gap-0.5 text-xs" data-testid="git-command">
      <span className="flex min-w-0 items-start gap-2">
        <Icon
          className={cn(
            'mt-0.5 size-3.5 shrink-0',
            command.outcome === 'succeeded'
              ? 'text-success'
              : command.outcome === 'failed'
                ? 'text-destructive'
                : 'text-muted-foreground',
          )}
          aria-label={command.outcome}
        />
        <code className="min-w-0 flex-1 break-all">git {command.args.join(' ')}</code>
        <span className="text-muted-foreground shrink-0 tabular-nums">
          exit {command.exitCode ?? '—'} · {formatDuration(command.durationMs)}
        </span>
      </span>
      {(command.stdout || command.stderr) && (
        <details className="pl-5">
          <summary className="text-muted-foreground cursor-pointer select-none">
            Output{command.truncated ? ' (end only)' : ''}
          </summary>
          <pre className="bg-muted/50 mt-1 max-h-48 overflow-auto rounded p-2 font-mono whitespace-pre-wrap">
            {[command.stdout, command.stderr].filter(Boolean).join('\n')}
          </pre>
        </details>
      )}
    </li>
  );
}

function OperationDetails({ id }: { id: string }) {
  const [details, setDetails] = useState<GitOperationLogDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    unwrap(api().git.operationDetails(id)).then(
      (value) => !cancelled && setDetails(value),
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <p className="text-destructive text-xs">{error}</p>;
  if (details === null) return <p className="text-muted-foreground text-xs">Loading…</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="git-operation-details">
      {details.commands.length === 0 ? (
        <p className="text-muted-foreground text-xs">No Git commands were recorded.</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {details.commands.map((command) => (
            <CommandRow key={command.sequence} command={command} />
          ))}
        </ol>
      )}
      <Button
        variant="outline"
        size="xs"
        className="self-start"
        onClick={() =>
          void copyText(operationText(details)).then(
            () => setCopied(true),
            () => undefined,
          )
        }
      >
        <Copy />
        {copied ? 'Copied' : 'Copy log'}
      </Button>
    </div>
  );
}

/**
 * Operations ATLAS ran in this repository, kept across restarts (PLAN-016), with the
 * Git commands of each one. `refreshKey` changes when an operation finishes.
 */
export function OperationHistory({
  repositoryRoot,
  refreshKey,
}: {
  repositoryRoot: string;
  refreshKey: string;
}) {
  const [kind, setKind] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [operations, setOperations] = useState<GitOperationLogEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: string) => {
      try {
        const page = await unwrap(
          api().git.operationLog({
            repositoryRoot,
            ...(kind !== ALL ? { kind: kind as GitOperationKind } : {}),
            ...(status !== ALL ? { status: status as GitOperationStatus } : {}),
            ...(before ? { before } : {}),
            limit: PAGE_SIZE,
          }),
        );
        setError(null);
        setOperations((current) =>
          before ? [...(current ?? []), ...page.operations] : page.operations,
        );
        setNextBefore(page.nextBefore);
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [repositoryRoot, kind, status],
  );

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load, refreshKey]);

  return (
    <div className="flex flex-col gap-3" data-testid="git-operation-history">
      <div className="grid grid-cols-2 gap-2">
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-full" aria-label="Operation kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All operations</SelectItem>
            {GIT_OPERATION_KINDS.map((value) => (
              <SelectItem key={value} value={value}>
                {OPERATION_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-full" aria-label="Operation status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any status</SelectItem>
            {STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {value[0]!.toUpperCase() + value.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {operations?.length === 0 && (
        <p className="text-muted-foreground text-xs">No logged operations match.</p>
      )}
      <ul className="flex flex-col gap-3" aria-label="Logged Git operations">
        {operations?.map((operation) => (
          <li
            key={operation.id}
            className="flex min-w-0 flex-col gap-1.5 border-b pb-2"
            data-testid="git-logged-operation"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <OperationResult operation={operation} />
              </div>
              <span
                className="text-muted-foreground shrink-0 pt-0.5 text-[11px]"
                title={new Date(operation.startedAt).toLocaleString()}
              >
                {relativeTime(operation.startedAt)}
              </span>
            </div>
            <Button
              variant="ghost"
              size="xs"
              className="self-start"
              aria-expanded={expanded === operation.id}
              onClick={() => setExpanded(expanded === operation.id ? null : operation.id)}
            >
              {expanded === operation.id ? 'Hide' : 'Show'} {operation.commandCount} Git command
              {operation.commandCount === 1 ? '' : 's'}
            </Button>
            {expanded === operation.id && <OperationDetails id={operation.id} />}
          </li>
        ))}
      </ul>
      {nextBefore && (
        <Button variant="outline" size="sm" onClick={() => void load(nextBefore)}>
          Load older operations
        </Button>
      )}
    </div>
  );
}

/** HEAD changes made by any tool (reflog), marking those that match an ATLAS operation. */
export function ReflogList({
  repositoryRoot,
  refreshKey,
}: {
  repositoryRoot: string;
  refreshKey: string;
}) {
  const [entries, setEntries] = useState<GitReflogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    unwrap(api().git.reflog({ repositoryRoot, limit: 100 })).then(
      (value) => {
        if (cancelled) return;
        setEntries(value);
        setError(null);
      },
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [repositoryRoot, refreshKey]);

  return (
    <div className="flex flex-col gap-2" data-testid="git-reflog">
      <p className="text-muted-foreground text-xs">
        Every change of HEAD recorded by Git, including <code>git</code> typed in a terminal.
        “ATLAS” marks changes made while an ATLAS operation was running (matched by time).
      </p>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {entries?.length === 0 && (
        <p className="text-muted-foreground text-xs">The reflog is empty.</p>
      )}
      <ol className="flex flex-col divide-y" aria-label="Reflog">
        {entries?.map((entry) => (
          <li
            key={`${entry.index}:${entry.hash}`}
            className="flex min-w-0 flex-col gap-0.5 py-1.5 text-xs"
            data-testid="git-reflog-entry"
            data-source={entry.atlasOperationId ? 'atlas' : 'outside'}
          >
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <code className="text-muted-foreground">{entry.hash.slice(0, 8)}</code>
              <span className="font-medium">{entry.action}</span>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium',
                  entry.atlasOperationId
                    ? 'bg-success/15 text-success'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {entry.atlasOperationId ? 'ATLAS' : 'Outside ATLAS'}
              </span>
              <span className="text-muted-foreground ml-auto shrink-0" title={entry.date ?? ''}>
                {relativeTime(entry.date)}
              </span>
            </span>
            {entry.message && <span className="min-w-0 break-words">{entry.message}</span>}
            <span className="text-muted-foreground">{entry.identity}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
