import type { GitDiffArea, GitFileChange, GitFileChangeKind, GitLineStats } from '@atlas/contracts';
import { Check, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  CHANGE_LABELS,
  CHANGE_LETTERS,
  CHANGE_TONES,
  directoryName,
  fileName,
  isPartiallyStaged,
  reviewProgress,
} from '../format';
import type { DiffSelection } from '../hooks/useGit';

interface ChangesListProps {
  files: GitFileChange[];
  selection: DiffSelection | null;
  busy: boolean;
  onSelect: (selection: DiffSelection) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
}

export function LineStats({ stats }: { stats: GitLineStats | null }) {
  if (stats === null) return null;
  if (stats.added === null || stats.removed === null) {
    return <span className="text-muted-foreground text-[11px]">binary</span>;
  }
  return (
    <span className="flex shrink-0 gap-1.5 font-mono text-[11px] tabular-nums">
      <span className="text-success">+{stats.added}</span>
      <span className="text-destructive">−{stats.removed}</span>
    </span>
  );
}

export function ChangeCode({ kind }: { kind: GitFileChangeKind }) {
  return (
    <span
      className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', CHANGE_TONES[kind])}
      title={CHANGE_LABELS[kind]}
      aria-label={CHANGE_LABELS[kind]}
    >
      {CHANGE_LETTERS[kind]}
    </span>
  );
}

interface Section {
  id: string;
  title: string;
  area: GitDiffArea;
  files: GitFileChange[];
  kind: (file: GitFileChange) => GitFileChangeKind;
  stats: (file: GitFileChange) => GitLineStats | null;
  action: 'stage' | 'unstage';
  actionLabel: string;
}

/** Changed files grouped for review: conflicts, approved (staged) and to review. */
export function ChangesList({
  files,
  selection,
  busy,
  onSelect,
  onStage,
  onUnstage,
}: ChangesListProps) {
  const sections: Section[] = [
    {
      id: 'conflicts',
      title: 'Merge conflicts',
      area: 'unstaged',
      files: files.filter((file) => file.staged === 'conflicted'),
      kind: () => 'conflicted',
      stats: (file) => file.unstagedStats,
      action: 'stage',
      actionLabel: 'Mark resolved',
    },
    {
      id: 'staged',
      title: 'Approved · staged',
      area: 'staged',
      files: files.filter((file) => file.staged !== null && file.staged !== 'conflicted'),
      kind: (file) => file.staged!,
      stats: (file) => file.stagedStats,
      action: 'unstage',
      actionLabel: 'Revoke approval',
    },
    {
      id: 'unstaged',
      title: 'To review',
      area: 'unstaged',
      files: files.filter(
        (file) =>
          file.unstaged !== null && file.unstaged !== 'untracked' && file.unstaged !== 'conflicted',
      ),
      kind: (file) => file.unstaged!,
      stats: (file) => file.unstagedStats,
      action: 'stage',
      actionLabel: 'Approve',
    },
    {
      id: 'untracked',
      title: 'To review · new files',
      area: 'unstaged',
      files: files.filter((file) => file.unstaged === 'untracked'),
      kind: () => 'untracked',
      stats: (file) => file.unstagedStats,
      action: 'stage',
      actionLabel: 'Approve',
    },
  ];

  const { reviewed, total } = reviewProgress(files);
  return (
    <div className="flex flex-col gap-3" data-testid="git-changes">
      {total > 0 && (
        <div className="flex flex-col gap-1 px-1" data-testid="git-review-progress">
          <span className="text-muted-foreground text-xs">
            Reviewed <strong className="text-foreground tabular-nums">{reviewed}</strong> of{' '}
            <span className="tabular-nums">{total}</span> files · approving a file stages it
          </span>
          <span
            className="bg-muted h-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-label="Review progress"
            aria-valuenow={reviewed}
            aria-valuemin={0}
            aria-valuemax={total}
          >
            <span
              className="bg-success block h-full transition-[width]"
              style={{ width: `${(reviewed / total) * 100}%` }}
            />
          </span>
        </div>
      )}
      {sections
        .filter((section) => section.files.length > 0)
        .map((section) => {
          const run = section.action === 'stage' ? onStage : onUnstage;
          const allLabel = section.action === 'stage' ? 'Approve all' : 'Revoke all';
          return (
            <section
              key={section.id}
              aria-labelledby={`git-section-${section.id}`}
              data-testid={`git-section-${section.id}`}
            >
              <header className="flex h-7 items-center justify-between gap-2 px-1">
                <h3
                  id={`git-section-${section.id}`}
                  className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase"
                >
                  {section.title} <span className="tabular-nums">({section.files.length})</span>
                </h3>
                {section.id !== 'conflicts' && (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => run(section.files.map((file) => file.path))}
                  >
                    {allLabel}
                  </Button>
                )}
              </header>
              <ul className="flex flex-col">
                {section.files.map((file) => {
                  const selected = selection?.path === file.path && selection.area === section.area;
                  return (
                    <li
                      key={file.path}
                      className={cn(
                        'group/file flex min-w-0 items-center gap-1 rounded-md pr-1',
                        selected ? 'bg-accent' : 'hover:bg-accent/50',
                      )}
                      data-testid="git-file"
                      data-path={file.path}
                      data-section={section.id}
                    >
                      <button
                        type="button"
                        className="focus-visible:ring-ring/50 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-[3px]"
                        aria-pressed={selected}
                        title={
                          file.originalPath ? `${file.originalPath} → ${file.path}` : file.path
                        }
                        onClick={() => onSelect({ path: file.path, area: section.area })}
                      >
                        <ChangeCode kind={section.kind(file)} />
                        <span className="truncate">{fileName(file.path)}</span>
                        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs [direction:rtl]">
                          <span dir="ltr">{directoryName(file.path)}</span>
                        </span>
                        {isPartiallyStaged(file) && (
                          <span
                            className="bg-muted text-muted-foreground shrink-0 rounded px-1 text-[10px]"
                            title="This file also has changes in the other area"
                          >
                            partial
                          </span>
                        )}
                        <LineStats stats={section.stats(file)} />
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={busy}
                        aria-label={`${section.actionLabel} ${file.path}`}
                        title={section.actionLabel}
                        onClick={() => run([file.path])}
                      >
                        {section.action === 'stage' ? <Check /> : <Undo2 />}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
    </div>
  );
}
