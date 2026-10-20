import type { GitFileDiff } from '@atlas/contracts';
import { FileDiff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CHANGE_LABELS } from '../format';
import { LineStats } from './ChangesList';

interface DiffViewerProps {
  diff: GitFileDiff | null;
  error: string | null;
  /** Nothing is selected yet. */
  empty: boolean;
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'bg-sky-500/10 text-sky-300';
  if (line.startsWith('+')) return 'bg-success/10 text-success';
  if (line.startsWith('-')) return 'bg-destructive/10 text-destructive';
  if (line.startsWith('\\')) return 'text-muted-foreground italic';
  return 'text-foreground/80';
}

/** Read-only unified diff of one file in one area (staged or unstaged). */
export function DiffViewer({ diff, error, empty }: DiffViewerProps) {
  if (empty) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-6 text-sm">
        <FileDiff className="size-6" aria-hidden="true" />
        Select a file to inspect its changes.
      </div>
    );
  }
  if (error) {
    return (
      <p className="text-destructive p-4 text-sm" role="alert">
        {error}
      </p>
    );
  }
  if (diff === null) {
    return <p className="text-muted-foreground p-4 text-sm">Loading diff…</p>;
  }
  const lines = diff.text === '' ? [] : diff.text.split('\n');
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="git-diff">
      <header className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-sm">
        <span
          className="min-w-0 truncate font-mono text-xs"
          title={diff.path}
          data-testid="git-diff-path"
        >
          {diff.originalPath ? `${diff.originalPath} → ${diff.path}` : diff.path}
        </span>
        <span className="text-muted-foreground text-xs">
          {CHANGE_LABELS[diff.change]} · {diff.area === 'staged' ? 'staged' : 'not staged'}
        </span>
        <span className="ml-auto">
          <LineStats stats={diff.binary ? null : { added: diff.added, removed: diff.removed }} />
        </span>
      </header>
      {diff.truncated && (
        <p className="text-warning border-b px-3 py-1.5 text-xs" role="status">
          This diff is too large and was shortened. Open the file in an editor to see everything.
        </p>
      )}
      {diff.binary ? (
        <p className="text-muted-foreground p-4 text-sm">Binary file; no text diff is shown.</p>
      ) : lines.length === 0 ? (
        <p className="text-muted-foreground p-4 text-sm">
          No content changes (for example, only the file mode changed).
        </p>
      ) : (
        <pre
          className="min-h-0 flex-1 overflow-auto py-1 font-mono text-xs leading-5"
          aria-label={`Diff of ${diff.path}`}
          tabIndex={0}
        >
          {lines.map((line, index) => (
            <div key={index} className={cn('px-3 whitespace-pre', lineClass(line))}>
              {line === '' ? ' ' : line}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
