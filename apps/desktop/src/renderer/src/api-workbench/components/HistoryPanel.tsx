import type { HttpHistoryEntry } from '@atlas/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatBytes, formatMs, methodClass, statusClass } from '../format';

const PAGE = 50;

interface HistoryPanelProps {
  /** Changes after each execution. */
  version: number;
  onOpen: (entry: HttpHistoryEntry) => void;
  onClear: () => void;
}

/** Recent executions without bodies or secret values (FR-1419). */
export function HistoryPanel({ version, onOpen, onClear }: HistoryPanelProps) {
  const [entries, setEntries] = useState<HttpHistoryEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before?: number) => {
    try {
      const page = await unwrap(api().http.history({ limit: PAGE, ...(before ? { before } : {}) }));
      setEntries((current) => (before ? [...(current ?? []), ...page.entries] : page.entries));
      setHasMore(page.hasMore);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void (async () => load())();
  }, [load, version]);

  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (entries === null) return <p className="text-muted-foreground text-sm">Loading…</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="http-history">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">Bodies and secret values are not kept.</p>
        {entries.length > 0 && (
          <Button size="xs" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
      {entries.length === 0 && (
        <p className="text-muted-foreground text-sm">No requests sent yet.</p>
      )}
      <ul className="min-h-0 flex-1 overflow-auto">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="hover:bg-accent flex w-full flex-col gap-0.5 rounded px-1 py-1.5 text-left"
              onClick={() => onOpen(entry)}
              title={entry.errorSummary ?? entry.url}
              data-testid="history-entry"
            >
              <span className="flex items-center gap-2 text-xs">
                <span className={cn('font-mono font-semibold', methodClass(entry.method))}>
                  {entry.method}
                </span>
                <span className={cn('rounded px-1 font-mono', statusClass(entry.status))}>
                  {entry.status ?? 'No response'}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {formatMs(entry.durationMs)}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {formatBytes(entry.responseBytes)}
                </span>
              </span>
              <span className="truncate font-mono text-xs">{entry.url}</span>
              <span className="text-muted-foreground text-[11px]">
                {new Date(entry.executedAt).toLocaleString()}
                {entry.errorSummary ? ` · ${entry.errorSummary}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hasMore && (
        <Button size="sm" variant="outline" onClick={() => void load(entries.at(-1)?.id)}>
          Load older
        </Button>
      )}
    </div>
  );
}
