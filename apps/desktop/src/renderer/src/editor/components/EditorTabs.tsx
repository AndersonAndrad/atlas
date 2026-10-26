import { Circle, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { tabLabels, type EditorTab } from '../state/tabs';
import { FileIcon } from './FileIcon';

interface EditorTabsProps {
  tabs: EditorTab[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

/** Open files (FR-1105): a dot marks unsaved changes; the close button replaces it on hover. */
export function EditorTabs({ tabs, activePath, onActivate, onClose }: EditorTabsProps) {
  const labels = tabLabels(tabs.map((tab) => tab.path));
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activePath === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-tab-path="${CSS.escape(activePath)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activePath]);

  return (
    <div
      ref={listRef}
      className="bg-sidebar/30 flex h-9 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b"
      role="tablist"
      aria-label="Open files"
      data-testid="editor-tabs"
    >
      {tabs.map((tab) => {
        const label = labels.get(tab.path) ?? { name: tab.path, hint: '' };
        const active = tab.path === activePath;
        return (
          <div
            key={tab.path}
            role="tab"
            tabIndex={active ? 0 : -1}
            aria-selected={active}
            data-tab-path={tab.path}
            data-dirty={tab.dirty ? 'true' : 'false'}
            data-testid="editor-tab"
            title={tab.path}
            className={cn(
              'group text-muted-foreground flex max-w-56 min-w-0 shrink-0 cursor-default items-center gap-1.5 border-r pr-1 pl-3 text-[13px] select-none',
              active ? 'bg-background text-foreground' : 'hover:bg-accent/40',
              tab.conflict !== null && 'text-amber-300',
            )}
            onMouseDown={(event) => {
              // Middle click closes, like most editors.
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.path);
              }
            }}
            onClick={() => onActivate(tab.path)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onActivate(tab.path);
            }}
          >
            <FileIcon name={label.name} kind="file" className="size-3.5" />
            <span className={cn('truncate', tab.conflict === 'deleted' && 'line-through')}>
              {label.name}
            </span>
            {label.hint && (
              <span className="text-muted-foreground/70 truncate text-[11px]">{label.hint}</span>
            )}
            <button
              type="button"
              className="hover:bg-accent ml-0.5 flex size-5 shrink-0 items-center justify-center rounded"
              aria-label={`Close ${label.name}${tab.dirty ? ' (unsaved changes)' : ''}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.path);
              }}
            >
              {tab.dirty ? (
                <>
                  <Circle className="size-2.5 fill-current group-hover:hidden" aria-hidden="true" />
                  <X className="hidden size-3.5 group-hover:block" aria-hidden="true" />
                </>
              ) : (
                <X
                  className={cn('size-3.5', !active && 'opacity-0 group-hover:opacity-100')}
                  aria-hidden="true"
                />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
