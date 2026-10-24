import type { PreflightOutputLine } from '@atlas/contracts';
import { Copy, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

const POLL_MS = 1000;
/** Lines kept on screen; older ones are dropped (the full log stays in the report). */
const MAX_LOADED_LINES = 20_000;
/** Lines rendered at once; search and copy still cover every loaded line. */
const MAX_RENDERED_LINES = 5000;
const ERROR_TEXT = /\b(?:error|errors|fail|failed|failure|fatal|exception|panic)\b|✗|✖/i;

type Filter = 'all' | 'errors';

export function isErrorLine(line: PreflightOutputLine): boolean {
  return line.stream === 'err' || ERROR_TEXT.test(line.text);
}

/**
 * Live output of one check (FR-717): polled while the check runs, with search, an
 * errors-only filter and copy. Lines arrive already redacted by the Engine.
 */
export function LogViewer({ runId, position }: { runId: string; position: number }) {
  const [lines, setLines] = useState<PreflightOutputLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let after = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A new check mounts a new viewer (keyed by run and position), so state starts empty.
    const poll = async () => {
      try {
        // Pages until the end, then waits for more while the check runs.
        for (;;) {
          const page = await unwrap(api().preflight.output({ runId, position, after }));
          if (cancelled) return;
          if (page.truncatedBefore) setTruncated(true);
          if (page.lines.length > 0) {
            setLines((current) => [...current, ...page.lines].slice(-MAX_LOADED_LINES));
          }
          after = page.next;
          if (page.complete) return;
          if (page.lines.length === 0) break;
        }
        timer = setTimeout(() => void poll(), POLL_MS);
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId, position]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return lines.filter(
      (line) =>
        (filter === 'all' || isErrorLine(line)) &&
        (needle === '' || line.text.toLowerCase().includes(needle)),
    );
  }, [lines, query, filter]);

  useEffect(() => {
    const element = scroller.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [visible]);

  async function copy() {
    try {
      await copyText(visible.map((line) => line.text).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="preflight-log">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search output"
            aria-label="Search output"
            className="h-8 pl-8"
          />
        </div>
        <div className="flex gap-1" role="group" aria-label="Lines shown">
          {(['all', 'errors'] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? 'secondary' : 'ghost'}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? 'All lines' : 'Errors'}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void copy()}
          disabled={visible.length === 0}
        >
          <Copy />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
        className="bg-muted/40 h-80 overflow-auto rounded-md border p-2 font-mono text-xs leading-5 lg:h-[28rem]"
        role="log"
        aria-live="polite"
        aria-label="Check output"
      >
        {truncated && (
          <p className="text-muted-foreground italic">
            Earlier output was dropped to keep the log small.
          </p>
        )}
        {visible.length > MAX_RENDERED_LINES && (
          <p className="text-muted-foreground italic">
            Showing the last {MAX_RENDERED_LINES} of {visible.length} lines. Search or copy to see
            the rest.
          </p>
        )}
        {visible.length === 0 ? (
          <p className="text-muted-foreground">
            {lines.length === 0 ? 'No output yet.' : 'No matching lines.'}
          </p>
        ) : (
          visible.slice(-MAX_RENDERED_LINES).map((line) => (
            <div
              key={line.seq}
              className={cn(
                'break-all whitespace-pre-wrap',
                line.stream === 'atlas' && 'text-muted-foreground italic',
                line.stream !== 'atlas' && isErrorLine(line) && 'text-destructive',
              )}
            >
              {line.text || ' '}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
