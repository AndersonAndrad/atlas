import type { HttpCollection, HttpFolder, HttpRequestSummary } from '@atlas/contracts';
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderPlus,
  Library,
  Plus,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { methodClass } from '../format';

export interface CollectionActions {
  openRequest: (request: HttpRequestSummary) => void;
  newRequest: (collectionId: string, folderId: string | null) => void;
  newFolder: (collectionId: string, parentId: string | null) => void;
  editCollection: (collection: HttpCollection) => void;
  duplicateCollection: (collection: HttpCollection) => void;
  deleteCollection: (collection: HttpCollection) => void;
  renameFolder: (folder: HttpFolder) => void;
  deleteFolder: (folder: HttpFolder) => void;
  duplicateRequest: (request: HttpRequestSummary) => void;
  moveRequest: (request: HttpRequestSummary) => void;
  deleteRequest: (request: HttpRequestSummary) => void;
}

function ItemMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function RequestRow({
  request,
  depth,
  active,
  actions,
}: {
  request: HttpRequestSummary;
  depth: number;
  active: boolean;
  actions: CollectionActions;
}) {
  return (
    <li
      className={cn('group flex items-center gap-1 rounded pr-1', active && 'bg-accent')}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      data-testid="collection-request"
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm"
        onClick={() => actions.openRequest(request)}
        title={request.url}
      >
        <span
          className={cn(
            'w-12 shrink-0 font-mono text-[10px] font-semibold',
            methodClass(request.method),
          )}
        >
          {request.method.slice(0, 7)}
        </span>
        <span className="truncate">{request.name}</span>
      </button>
      <ItemMenu label={`Actions for ${request.name}`}>
        <DropdownMenuItem onSelect={() => actions.duplicateRequest(request)}>
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.moveRequest(request)}>Move to…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => actions.deleteRequest(request)}>
          Delete
        </DropdownMenuItem>
      </ItemMenu>
    </li>
  );
}

interface TreeProps {
  collection: HttpCollection;
  parentId: string | null;
  depth: number;
  activeRequestId: string | null;
  actions: CollectionActions;
  visible: (request: HttpRequestSummary) => boolean;
  forceOpen: boolean;
}

function FolderContents({
  collection,
  parentId,
  depth,
  activeRequestId,
  actions,
  visible,
  forceOpen,
}: TreeProps) {
  const folders = collection.folders.filter((folder) => folder.parentId === parentId);
  const requests = collection.requests.filter(
    (request) => request.folderId === parentId && visible(request),
  );
  return (
    <>
      {folders.map((folder) => (
        <FolderRow
          key={folder.id}
          folder={folder}
          collection={collection}
          depth={depth}
          activeRequestId={activeRequestId}
          actions={actions}
          visible={visible}
          forceOpen={forceOpen}
        />
      ))}
      {requests.map((request) => (
        <RequestRow
          key={request.id}
          request={request}
          depth={depth}
          active={request.id === activeRequestId}
          actions={actions}
        />
      ))}
    </>
  );
}

function FolderRow({ folder, ...props }: Omit<TreeProps, 'parentId'> & { folder: HttpFolder }) {
  const [open, setOpen] = useState(true);
  const { actions, depth, collection } = props;
  const expanded = open || props.forceOpen;
  return (
    <li>
      <div
        className="group flex items-center gap-1 rounded pr-1"
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-sm"
          aria-expanded={expanded}
          onClick={() => setOpen(!open)}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <Folder className="text-muted-foreground size-3.5" />
          <span className="truncate">{folder.name}</span>
        </button>
        <ItemMenu label={`Actions for folder ${folder.name}`}>
          <DropdownMenuItem onSelect={() => actions.newRequest(collection.id, folder.id)}>
            New request
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.newFolder(collection.id, folder.id)}>
            New folder
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.renameFolder(folder)}>Rename</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => actions.deleteFolder(folder)}>
            Delete
          </DropdownMenuItem>
        </ItemMenu>
      </div>
      {expanded && (
        <ul>
          <FolderContents {...props} parentId={folder.id} depth={depth + 1} />
        </ul>
      )}
    </li>
  );
}

function scopeLabel(collection: HttpCollection, projectNames: Map<string, string>): string {
  const { scope } = collection;
  if (scope.kind === 'global') return 'Every project';
  if (scope.kind === 'project') {
    return scope.projectId === null
      ? 'Project removed'
      : (projectNames.get(scope.projectId) ?? 'Project');
  }
  return `Shared with ${scope.projectIds.length} project${scope.projectIds.length === 1 ? '' : 's'}`;
}

interface CollectionsPanelProps {
  collections: HttpCollection[] | null;
  error: string | null;
  scope: 'project' | 'all';
  onScopeChange: (scope: 'project' | 'all') => void;
  projectNames: Map<string, string>;
  activeRequestId: string | null;
  actions: CollectionActions;
  onCreateCollection: () => void;
}

/** Collections with folders and requests, searchable (FR-1416–FR-1418). */
export function CollectionsPanel({
  collections,
  error,
  scope,
  onScopeChange,
  projectNames,
  activeRequestId,
  actions,
  onCreateCollection,
}: CollectionsPanelProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const needle = query.trim().toLowerCase();
  const visible = (request: HttpRequestSummary) =>
    needle === '' ||
    `${request.method} ${request.name} ${request.url}`.toLowerCase().includes(needle);
  const shown = (collections ?? []).filter(
    (collection) =>
      needle === '' ||
      collection.requests.some(visible) ||
      collection.name.toLowerCase().includes(needle),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="collections-panel">
      <div className="flex items-center gap-1">
        <div
          className="flex flex-1 rounded-md border p-0.5"
          role="group"
          aria-label="Collections shown"
        >
          {(['project', 'all'] as const).map((value) => (
            <Button
              key={value}
              size="xs"
              className="flex-1"
              variant={scope === value ? 'secondary' : 'ghost'}
              aria-pressed={scope === value}
              onClick={() => onScopeChange(value)}
            >
              {value === 'project' ? 'This project' : 'All'}
            </Button>
          ))}
        </div>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="New collection"
          onClick={onCreateCollection}
        >
          <Plus />
        </Button>
      </div>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search requests"
        aria-label="Search requests"
        className="h-8"
      />
      {error && <p className="text-destructive text-sm">{error}</p>}
      {collections !== null && collections.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-start gap-2 p-1 text-sm">
          <p>No collections yet.</p>
          <Button size="sm" variant="outline" onClick={onCreateCollection}>
            <Library /> New collection
          </Button>
        </div>
      )}
      <ul className="min-h-0 flex-1 overflow-auto" aria-label="Collections">
        {shown.map((collection) => {
          const open = !collapsed.has(collection.id) || needle !== '';
          return (
            <li key={collection.id} className="mb-1" data-testid="collection">
              <div className="group flex items-center gap-1 rounded pr-1">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-sm font-medium"
                  aria-expanded={open}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(collection.id)) next.delete(collection.id);
                      else next.add(collection.id);
                      return next;
                    })
                  }
                >
                  {open ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  <span className="truncate">{collection.name}</span>
                </button>
                <ItemMenu label={`Actions for collection ${collection.name}`}>
                  <DropdownMenuItem onSelect={() => actions.newRequest(collection.id, null)}>
                    <Plus /> New request
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => actions.newFolder(collection.id, null)}>
                    <FolderPlus /> New folder
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => actions.editCollection(collection)}>
                    Edit…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => actions.duplicateCollection(collection)}>
                    Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => actions.deleteCollection(collection)}
                  >
                    Delete
                  </DropdownMenuItem>
                </ItemMenu>
              </div>
              {scope === 'all' && (
                <p className="text-muted-foreground pl-5 text-xs">
                  {scopeLabel(collection, projectNames)}
                </p>
              )}
              {open && (
                <ul>
                  <FolderContents
                    collection={collection}
                    parentId={null}
                    depth={1}
                    activeRequestId={activeRequestId}
                    actions={actions}
                    visible={visible}
                    forceOpen={needle !== ''}
                  />
                  {collection.requests.length === 0 && collection.folders.length === 0 && (
                    <li className="text-muted-foreground py-1 pl-6 text-xs">No requests.</li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
