import type { FileEntry } from '@atlas/contracts';
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  FilePlus,
  FolderPlus,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { TreeRow } from '../hooks/useFileTree';
import { parentPath } from '../state/tabs';
import { FileIcon } from './FileIcon';

const ROW_HEIGHT = 24;
/** Rows rendered above and below the visible ones. */
const OVERSCAN = 10;
const DRAG_TYPE = 'application/x-atlas-project-path';

export interface ExplorerActions {
  open: (path: string) => void;
  toggle: (folder: string) => void;
  create: (folder: string, kind: 'file' | 'directory') => void;
  rename: (entry: FileEntry) => void;
  trash: (entry: FileEntry) => void;
  reveal: (entry: FileEntry) => void;
  copyPath: (entry: FileEntry) => void;
  /** Moves `from` into `folder` ('' is the project folder). */
  move: (from: string, folder: string) => void;
}

interface FileExplorerProps {
  projectName: string;
  rows: TreeRow[];
  loading: boolean;
  error: string | null;
  hiddenIgnored: number;
  showIgnored: boolean;
  activePath: string | null;
  actions: ExplorerActions;
  onToggleIgnored: () => void;
  onRefresh: () => void;
  onRevealActive: () => void;
}

/** Folder tree of the project (FR-1101), virtualized so large folders stay fast. */
export function FileExplorer(props: FileExplorerProps) {
  const { rows, actions, activePath } = props;
  const [filter, setFilter] = useState('');
  const [focused, setFocused] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle === ''
      ? rows
      : rows.filter((row) => row.entry.name.toLowerCase().includes(needle));
  }, [rows, filter]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const update = () => setViewport({ top: list.scrollTop, height: list.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  // Keeps the active file visible when it changes (e.g. after "Reveal").
  useEffect(() => {
    const index = visible.findIndex((row) => row.entry.path === activePath);
    const list = listRef.current;
    if (index === -1 || list === null) return;
    const top = index * ROW_HEIGHT;
    if (top < list.scrollTop || top + ROW_HEIGHT > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - list.clientHeight / 2);
    }
  }, [activePath, visible]);

  const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    visible.length,
    Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN,
  );

  const activate = (row: TreeRow) => {
    if (row.entry.kind === 'directory' && !row.entry.outside) actions.toggle(row.entry.path);
    else if (row.entry.kind === 'file' && !row.entry.outside) actions.open(row.entry.path);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = visible.findIndex((row) => row.entry.path === focused);
    const row = visible[index];
    const focusAt = (next: number) => {
      const target = visible[Math.min(visible.length - 1, Math.max(0, next))];
      if (target === undefined) return;
      setFocused(target.entry.path);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(target.entry.path)}"]`)
        ?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusAt(index - 1);
        break;
      case 'ArrowRight':
        if (row?.entry.kind === 'directory' && !row.expanded) actions.toggle(row.entry.path);
        break;
      case 'ArrowLeft':
        if (row?.entry.kind === 'directory' && row.expanded) actions.toggle(row.entry.path);
        else if (row)
          focusAt(visible.findIndex((other) => other.entry.path === parentPath(row.entry.path)));
        break;
      case 'Enter':
        if (row) activate(row);
        break;
      case 'F2':
        if (row) actions.rename(row.entry);
        break;
      default:
        break;
    }
  };

  const folderOf = (entry: FileEntry) =>
    entry.kind === 'directory' && !entry.outside ? entry.path : parentPath(entry.path);

  return (
    <section
      className="bg-sidebar/40 flex h-full min-h-0 min-w-0 flex-col"
      aria-label="Explorer"
      data-testid="file-explorer"
    >
      <header className="flex h-9 shrink-0 items-center gap-0.5 border-b px-2">
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide"
          title={props.projectName}
        >
          {props.projectName}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New file"
          title="New file"
          onClick={() => actions.create('', 'file')}
        >
          <FilePlus />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New folder"
          title="New folder"
          onClick={() => actions.create('', 'directory')}
        >
          <FolderPlus />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Reveal active file"
          title="Reveal active file"
          disabled={activePath === null}
          onClick={props.onRevealActive}
        >
          <Crosshair />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh"
          title="Refresh"
          onClick={props.onRefresh}
        >
          <RefreshCw />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={props.showIgnored ? 'Hide ignored files' : 'Show ignored files'}
          aria-pressed={props.showIgnored}
          title={props.showIgnored ? 'Hide ignored files' : 'Show ignored files'}
          onClick={props.onToggleIgnored}
        >
          {props.showIgnored ? <Eye /> : <EyeOff />}
        </Button>
      </header>
      <div className="shrink-0 border-b p-1.5">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by name"
          aria-label="Filter files by name"
          className="h-7 text-xs"
        />
      </div>
      {props.error ? (
        <p className="text-destructive p-3 text-xs" role="alert">
          {props.error}
        </p>
      ) : props.loading ? (
        <p className="text-muted-foreground p-3 text-xs">Loading…</p>
      ) : null}
      <div
        ref={listRef}
        className={cn(
          'relative min-h-0 flex-1 overflow-auto',
          dropTarget === '' && 'bg-sky-500/10',
        )}
        role="tree"
        aria-label="Files"
        data-testid="file-tree"
        onScroll={(event) =>
          setViewport({
            top: event.currentTarget.scrollTop,
            height: event.currentTarget.clientHeight,
          })
        }
        onKeyDown={onKeyDown}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
          event.preventDefault();
          setDropTarget('');
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(event) => {
          const from = event.dataTransfer.getData(DRAG_TYPE);
          setDropTarget(null);
          if (from !== '' && parentPath(from) !== '') actions.move(from, '');
        }}
      >
        <div style={{ height: visible.length * ROW_HEIGHT }} className="relative">
          {visible.slice(first, last).map((row, offset) => {
            const { entry } = row;
            const index = first + offset;
            const folder = entry.kind === 'directory' && !entry.outside;
            return (
              <ContextMenu key={entry.path}>
                <ContextMenuTrigger asChild>
                  <div
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-expanded={folder ? row.expanded : undefined}
                    aria-selected={entry.path === activePath}
                    tabIndex={
                      entry.path === (focused ?? activePath ?? visible[0]?.entry.path) ? 0 : -1
                    }
                    data-path={entry.path}
                    data-testid="file-tree-row"
                    title={
                      entry.outside
                        ? 'Points outside the project folder; it cannot be opened here.'
                        : entry.path
                    }
                    className={cn(
                      'absolute inset-x-0 flex cursor-default items-center gap-1 pr-2 text-[13px] outline-none select-none',
                      'hover:bg-accent/60 focus-visible:ring-ring focus-visible:ring-1 focus-visible:ring-inset',
                      entry.path === activePath && 'bg-accent text-accent-foreground',
                      (entry.ignored || entry.outside) && 'opacity-55',
                      dropTarget === entry.path && 'bg-sky-500/20',
                    )}
                    style={{
                      top: index * ROW_HEIGHT,
                      height: ROW_HEIGHT,
                      paddingLeft: 8 + row.depth * 12,
                    }}
                    onFocus={() => setFocused(entry.path)}
                    onClick={() => activate(row)}
                    draggable={!entry.outside}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_TYPE, entry.path);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(event) => {
                      if (!folder || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
                      event.preventDefault();
                      event.stopPropagation();
                      setDropTarget(entry.path);
                    }}
                    onDrop={(event) => {
                      if (!folder) return;
                      event.preventDefault();
                      event.stopPropagation();
                      setDropTarget(null);
                      const from = event.dataTransfer.getData(DRAG_TYPE);
                      if (from !== '' && from !== entry.path && parentPath(from) !== entry.path) {
                        actions.move(from, entry.path);
                      }
                    }}
                  >
                    {folder ? (
                      row.expanded ? (
                        <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                      )
                    ) : (
                      <span className="w-3.5 shrink-0" />
                    )}
                    <FileIcon
                      name={entry.name}
                      kind={entry.kind}
                      open={row.expanded}
                      symlink={entry.symlink}
                    />
                    <span className="min-w-0 truncate">{entry.name}</span>
                    {row.status === 'error' && (
                      <span className="text-destructive ml-auto text-[11px]">unavailable</span>
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent data-testid="file-context-menu">
                  {entry.kind === 'file' && !entry.outside && (
                    <ContextMenuItem onSelect={() => actions.open(entry.path)}>
                      Open
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem onSelect={() => actions.create(folderOf(entry), 'file')}>
                    New file…
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => actions.create(folderOf(entry), 'directory')}>
                    New folder…
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => actions.rename(entry)}>Rename…</ContextMenuItem>
                  <ContextMenuItem onSelect={() => actions.copyPath(entry)}>
                    Copy relative path
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => actions.reveal(entry)}>
                    Reveal in file manager
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => actions.trash(entry)}
                  >
                    Move to Trash…
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
        {!props.loading && !props.error && rows.length === 0 && (
          <p className="text-muted-foreground p-3 text-xs">This folder is empty.</p>
        )}
      </div>
      {props.hiddenIgnored > 0 && !props.showIgnored && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground shrink-0 border-t px-3 py-1.5 text-left text-[11px]"
          onClick={props.onToggleIgnored}
        >
          {props.hiddenIgnored} ignored {props.hiddenIgnored === 1 ? 'entry' : 'entries'} hidden ·
          Show
        </button>
      )}
    </section>
  );
}
