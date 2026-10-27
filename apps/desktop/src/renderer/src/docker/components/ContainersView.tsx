import {
  ContainerNameSchema,
  ContainerUserSchema,
  type ContainerLifecycleAction,
  type DockerContainerSummary,
} from '@atlas/contracts';
import {
  Boxes,
  Ellipsis,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Square,
  SquareTerminal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  CONNECTION_HINTS,
  CONNECTION_LABELS,
  CONTAINER_STATE_LABELS,
  HEALTH_LABELS,
  containerStateClass,
  formatPort,
} from '../format';
import { useDocker } from '../useDocker';
import { ContainerDetailsPanel } from './ContainerDetailsPanel';
import { CreateContainerDialog } from './CreateContainerDialog';

type StateFilter = 'all' | 'running' | 'stopped';
/** Sections planned for the next milestones; shown so the layout does not move later. */
const LATER_SECTIONS = ['Images', 'Networks', 'Volumes', 'Compose'] as const;

const ACTION_LABELS: Record<ContainerLifecycleAction, string> = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  pause: 'Pause',
  unpause: 'Resume',
};
const ACTION_ICONS = {
  start: Play,
  stop: Square,
  restart: RotateCcw,
  pause: Pause,
  unpause: Play,
} as const;

/** Asks before a shell runs as root, and lets the user choose another user (FR-1308). */
function TerminalDialog({
  container,
  busy,
  onCancel,
  onOpen,
}: {
  container: DockerContainerSummary;
  busy: boolean;
  onCancel: () => void;
  onOpen: (user: string | null, confirmRoot: boolean) => void;
}) {
  const [user, setUser] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent data-testid="container-terminal">
        <DialogHeader>
          <DialogTitle>Shell as root in {container.name}?</DialogTitle>
          <DialogDescription>
            This container runs as root. A shell as root can change anything inside it, and in
            mounted folders. Choose another user, or confirm root.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="container-user">User (optional)</Label>
          <Input
            id="container-user"
            value={user}
            onChange={(event) => setUser(event.target.value)}
            placeholder="node or 1000:1000"
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={busy || user.trim() === ''}
            onClick={() => {
              const parsed = ContainerUserSchema.safeParse(user);
              if (!parsed.success) {
                setError(parsed.error.issues[0]?.message ?? 'Invalid user.');
                return;
              }
              onOpen(parsed.data, false);
            }}
          >
            Open as {user.trim() || 'user'}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => onOpen(null, true)}>
            Open as root
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  container,
  onCancel,
  onRename,
}: {
  container: DockerContainerSummary;
  onCancel: () => void;
  onRename: (name: string) => Promise<string | null>;
}) {
  const [name, setName] = useState(container.name);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="container-rename">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = ContainerNameSchema.safeParse(name);
            if (!parsed.success) {
              setError(parsed.error.issues[0]?.message ?? 'Invalid name.');
              return;
            }
            void onRename(parsed.data).then(setError);
          }}
          noValidate
        >
          <DialogHeader>
            <DialogTitle>Rename {container.name}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="container-new-name">Name</Label>
            <Input
              id="container-new-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={error ? true : undefined}
              autoFocus
            />
            {error && <p className="text-destructive text-xs">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Container Manager (SDD-013 Milestone A): the containers of the Docker context in use,
 * with their actions, details, logs, usage and a shell. Docker is optional: without it
 * the view explains why and the rest of ATLAS is unaffected.
 */
export function ContainersView({ onTerminalOpened }: { onTerminalOpened: () => void }) {
  const docker = useDocker();
  const { status, contexts, containers, context } = docker;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StateFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The details tab to open with, e.g. Logs from the row's logs button. */
  const [opened, setOpened] = useState<{ tab: 'overview' | 'logs'; nonce: number }>({
    tab: 'overview',
    nonce: 0,
  });
  const select = (id: string | null, tab: 'overview' | 'logs' = 'overview') => {
    setSelectedId(id);
    setOpened((current) => ({ tab, nonce: current.nonce + 1 }));
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<DockerContainerSummary | null>(null);
  const [renaming, setRenaming] = useState<DockerContainerSummary | null>(null);
  const [rootShell, setRootShell] = useState<DockerContainerSummary | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (containers ?? []).filter(
      (item) =>
        (filter === 'all' ||
          (filter === 'running' ? item.state === 'running' : item.state !== 'running')) &&
        (needle === '' ||
          [item.name, item.image, item.shortId, item.composeProject ?? ''].some((value) =>
            value.toLowerCase().includes(needle),
          )),
    );
  }, [containers, query, filter]);

  const act = async (id: string, request: () => Promise<unknown>) => {
    setBusy(id);
    setActionError(null);
    try {
      await request();
    } catch (caught) {
      setActionError(
        caught instanceof ApiError && caught.issues.length > 0
          ? `${caught.message} ${caught.issues[0]!.message}`
          : errorMessage(caught),
      );
    }
    setBusy(null);
    await docker.reload();
  };

  const lifecycle = (item: DockerContainerSummary, action: ContainerLifecycleAction) =>
    act(item.id, () =>
      unwrap(api().docker.lifecycle({ context: context!, containerId: item.id, action })),
    );

  async function openTerminal(
    item: DockerContainerSummary,
    user: string | null = null,
    confirmRoot = false,
  ) {
    setBusy(item.id);
    setActionError(null);
    try {
      await unwrap(
        api().docker.openTerminal({ context: context!, containerId: item.id, user, confirmRoot }),
      );
      setRootShell(null);
      onTerminalOpened();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'DOCKER_CONFIRMATION_REQUIRED') {
        setRootShell(item);
      } else {
        setRootShell(null);
        setActionError(errorMessage(caught));
      }
    }
    setBusy(null);
  }

  const clearSelection = useCallback(() => setSelectedId(null), []);
  const connected = status?.state === 'CONNECTED';
  const effective = contexts?.effective ?? null;
  const remote = contexts?.contexts.find((item) => item.name === effective)?.remote ?? false;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="containers-view">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Boxes className="size-5" aria-hidden="true" />
          Containers
        </h1>
        {contexts && contexts.contexts.length > 0 && (
          <Select
            value={contexts.selected ?? '__docker__'}
            onValueChange={(value) =>
              void docker.selectContext(value === '__docker__' ? null : value)
            }
          >
            <SelectTrigger size="sm" className="w-60 max-w-full" aria-label="Docker context">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__docker__">
                Docker&apos;s current (
                {contexts.contexts.find((item) => item.dockerCurrent)?.name ?? '—'})
              </SelectItem>
              {contexts.contexts.map((item) => (
                <SelectItem key={item.name} value={item.name}>
                  {item.name} ·{' '}
                  {item.remote ? `remote${item.host ? ` (${item.host})` : ''}` : 'local'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {remote && (
          <Badge variant="outline" className="text-warning">
            Remote engine
          </Badge>
        )}
        {status && (
          <Badge
            variant="outline"
            className={connected ? 'text-success' : 'text-warning'}
            data-testid="docker-status"
            title={status.message}
          >
            {CONNECTION_LABELS[status.state]}
          </Badge>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void (connected ? docker.reload() : docker.check())}
          >
            <RefreshCw />
            {connected ? 'Reload' : 'Check again'}
          </Button>
          <Button size="sm" onClick={() => setCreating(true)} disabled={!connected}>
            <Plus />
            New container
          </Button>
        </div>
      </header>
      <nav
        className="flex flex-wrap gap-1.5 border-b px-4 py-2"
        aria-label="Container Manager sections"
      >
        <Button size="xs" variant="secondary" aria-current="page">
          Containers
        </Button>
        {LATER_SECTIONS.map((section) => (
          <Button key={section} size="xs" variant="ghost" disabled title="In a later milestone">
            {section}
          </Button>
        ))}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {status === null && <p className="text-muted-foreground text-sm">Checking Docker…</p>}
        {status !== null && !connected && (
          <Alert data-testid="docker-disconnected">
            <AlertDescription>
              <p className="font-medium">{status.message}</p>
              <p>{CONNECTION_HINTS[status.state]}</p>
              {status.clientVersion && (
                <p className="text-muted-foreground text-xs">
                  Docker CLI {status.clientVersion}
                  {status.context ? ` · context ${status.context}` : ''}
                </p>
              )}
            </AlertDescription>
          </Alert>
        )}
        {connected && (
          <p className="text-muted-foreground text-xs" data-testid="docker-connection">
            {status.platform ?? 'Docker'} · Engine {status.serverVersion} · API {status.apiVersion}
            {status.composeVersion ? ` · Compose ${status.composeVersion}` : ''}
          </p>
        )}
        {(docker.error ?? actionError) && (
          <Alert variant="destructive">
            <AlertDescription>{actionError ?? docker.error}</AlertDescription>
          </Alert>
        )}
        {connected && (
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Input
                  className="h-8 min-w-40 flex-1"
                  placeholder="Search containers"
                  aria-label="Search containers"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <div className="flex gap-1" role="group" aria-label="Containers shown">
                  {(['all', 'running', 'stopped'] as const).map((value) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={filter === value ? 'secondary' : 'ghost'}
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                    >
                      {value === 'all' ? 'All' : value === 'running' ? 'Running' : 'Stopped'}
                    </Button>
                  ))}
                </div>
              </div>
              {containers === null ? (
                <p className="text-muted-foreground text-sm">Loading containers…</p>
              ) : visible.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {containers.length === 0
                    ? 'No containers in this context.'
                    : 'No matching containers.'}
                </p>
              ) : (
                <ul
                  className="flex flex-col divide-y rounded-md border"
                  data-testid="container-list"
                >
                  {visible.map((item) => {
                    const primary: ContainerLifecycleAction | null = item.actions.includes('stop')
                      ? 'stop'
                      : item.actions.includes('start')
                        ? 'start'
                        : item.actions.includes('unpause')
                          ? 'unpause'
                          : null;
                    const PrimaryIcon = primary ? ACTION_ICONS[primary] : null;
                    const health = HEALTH_LABELS[item.health];
                    return (
                      <li
                        key={item.id}
                        className={cn(
                          'flex min-w-0 items-start gap-2 p-3',
                          item.id === selectedId && 'bg-muted/50',
                        )}
                        data-testid="container-row"
                        data-state={item.state}
                      >
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                          aria-pressed={item.id === selectedId}
                          onClick={() => select(item.id === selectedId ? null : item.id)}
                        >
                          <span className="truncate font-medium" title={item.name}>
                            {item.name}
                          </span>
                          <span className="text-muted-foreground truncate text-xs">
                            {item.image}
                            {item.ports.length > 0
                              ? ` · ${item.ports.map(formatPort).join(', ')}`
                              : ''}
                            {item.composeProject ? ` · ${item.composeProject}` : ''}
                          </span>
                        </button>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className="flex gap-1">
                            {health && (
                              <Badge
                                variant="outline"
                                className={
                                  item.health === 'unhealthy' ? 'text-destructive' : undefined
                                }
                              >
                                {health}
                              </Badge>
                            )}
                            <Badge
                              variant="outline"
                              className={containerStateClass(item.state)}
                              data-testid="container-state"
                            >
                              {CONTAINER_STATE_LABELS[item.state]}
                            </Badge>
                          </span>
                          <span className="flex gap-0.5">
                            {primary && PrimaryIcon && (
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={`${ACTION_LABELS[primary]} ${item.name}`}
                                title={ACTION_LABELS[primary]}
                                disabled={busy === item.id}
                                onClick={() => void lifecycle(item, primary)}
                              >
                                <PrimaryIcon />
                              </Button>
                            )}
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label={`Logs of ${item.name}`}
                              title="Logs"
                              onClick={() => select(item.id, 'logs')}
                            >
                              <ScrollText />
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label={`More actions for ${item.name}`}
                                  disabled={busy === item.id}
                                >
                                  <Ellipsis />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {(['restart', 'pause', 'unpause'] as const)
                                  .filter((action) => item.actions.includes(action))
                                  .map((action) => {
                                    const Icon = ACTION_ICONS[action];
                                    return (
                                      <DropdownMenuItem
                                        key={action}
                                        onSelect={() => void lifecycle(item, action)}
                                      >
                                        <Icon />
                                        {ACTION_LABELS[action]}
                                      </DropdownMenuItem>
                                    );
                                  })}
                                {item.actions.includes('terminal') && (
                                  <DropdownMenuItem onSelect={() => void openTerminal(item)}>
                                    <SquareTerminal />
                                    Open shell
                                  </DropdownMenuItem>
                                )}
                                {item.actions.includes('rename') && (
                                  <DropdownMenuItem onSelect={() => setRenaming(item)}>
                                    <Pencil />
                                    Rename
                                  </DropdownMenuItem>
                                )}
                                {item.actions.includes('remove') && (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onSelect={() => setRemoving(item)}
                                    >
                                      <Trash2 />
                                      Remove
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {selectedId !== null && context !== null && (
              <ContainerDetailsPanel
                key={`${context}:${selectedId}:${opened.nonce}`}
                context={context}
                containerId={selectedId}
                initialTab={opened.tab}
                refreshKey={docker.changed.id === selectedId ? docker.changed.nonce : 0}
                onClose={clearSelection}
                onMissing={clearSelection}
              />
            )}
          </div>
        )}
      </div>
      {creating && context !== null && (
        <CreateContainerDialog
          context={context}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            select(created.id);
            void docker.reload();
          }}
        />
      )}
      {removing && (
        <AlertDialog open onOpenChange={(open) => !open && setRemoving(null)}>
          <AlertDialogContent data-testid="container-remove">
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {removing.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The container and its own files are deleted from {context}. Its volumes are kept;
                remove them separately if you no longer need their data.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const target = removing;
                  setRemoving(null);
                  if (target.id === selectedId) setSelectedId(null);
                  void act(target.id, () =>
                    unwrap(api().docker.remove({ context: context!, containerId: target.id })),
                  );
                }}
              >
                Remove container
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {renaming && (
        <RenameDialog
          container={renaming}
          onCancel={() => setRenaming(null)}
          onRename={async (name) => {
            try {
              await unwrap(
                api().docker.rename({ context: context!, containerId: renaming.id, name }),
              );
              setRenaming(null);
              await docker.reload();
              return null;
            } catch (caught) {
              return caught instanceof ApiError && caught.issues.length > 0
                ? caught.issues[0]!.message
                : errorMessage(caught);
            }
          }}
        />
      )}
      {rootShell && (
        <TerminalDialog
          container={rootShell}
          busy={busy === rootShell.id}
          onCancel={() => setRootShell(null)}
          onOpen={(user, confirmRoot) => void openTerminal(rootShell, user, confirmRoot)}
        />
      )}
    </main>
  );
}
