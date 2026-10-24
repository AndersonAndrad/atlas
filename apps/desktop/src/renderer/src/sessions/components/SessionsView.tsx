import type { AtlasSession, SessionAction } from '@atlas/contracts';
import { Info, ListChecks, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
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
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { formatDate } from '@/format';
import type { useProjects } from '@/hooks/useProjects';
import { cn } from '@/lib/utils';
import { profileLabel } from '../format';
import { useSessionDetails, useSessions } from '../hooks/useSessions';
import { SessionDetailsPanel } from './SessionDetailsPanel';
import { SessionFormDialog } from './SessionFormDialog';
import { SessionStatusBadge } from './SessionStatusBadge';

type Dialog =
  | { kind: 'create'; projectId: string | null }
  | { kind: 'edit'; session: AtlasSession }
  | { kind: 'cancel'; session: AtlasSession }
  | null;

interface SessionsViewProps {
  projects: ReturnType<typeof useProjects>;
  /** Opens the creation dialog for a project (e.g. from the Projects view), once per nonce. */
  createRequest: { projectId: string | null; nonce: number } | null;
  /** Called once the request was taken, so it is not replayed when the view mounts again. */
  onCreateRequestHandled: () => void;
  /** Opens Preflight for a session's project. */
  onOpenPreflight?: (projectId: string) => void;
}

/** ATLAS Sessions: persistent orchestration records. Nothing here executes AI work. */
export function SessionsView({
  projects,
  createRequest,
  onCreateRequestHandled,
  onOpenPreflight,
}: SessionsViewProps) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const { items, error: listError, reload } = useSessions(includeArchived);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The selected session, or the first listed one when nothing (or a hidden one) is selected.
  const shownId =
    items?.some((item) => item.session.id === selectedId) === true
      ? selectedId
      : (items?.[0]?.session.id ?? null);
  const {
    details,
    events,
    error: detailsError,
    reload: reloadDetails,
  } = useSessionDetails(shownId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // A request from the Projects view ("New session"): opened once, then cleared in the app
  // so it is not replayed when this view mounts again.
  const [handledRequest, setHandledRequest] = useState<number | null>(null);
  if (createRequest !== null && createRequest.nonce !== handledRequest) {
    setHandledRequest(createRequest.nonce);
    setDialog({ kind: 'create', projectId: createRequest.projectId });
  }
  useEffect(() => {
    if (createRequest !== null) onCreateRequestHandled();
  }, [createRequest, onCreateRequestHandled]);

  async function perform(sessionId: string, action: SessionAction) {
    setActionError(null);
    try {
      await unwrap(api().sessions.perform(sessionId, action));
      await Promise.all([reload(), reloadDetails()]);
    } catch (caught) {
      setActionError(errorMessage(caught));
    }
  }

  const requestAction = (action: SessionAction) => {
    if (details === null) return;
    if (action === 'cancel') setDialog({ kind: 'cancel', session: details.session });
    else void perform(details.session.id, action);
  };

  const error = actionError ?? listError ?? detailsError;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="sessions-show-archived"
              checked={includeArchived}
              onCheckedChange={(checked) => setIncludeArchived(checked === true)}
            />
            <Label htmlFor="sessions-show-archived" className="font-normal">
              Show archived
            </Label>
          </div>
          <Button onClick={() => setDialog({ kind: 'create', projectId: null })}>
            <Plus />
            New session
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Alert className="mb-4" data-testid="no-executor-banner">
          <Info />
          <AlertDescription>
            No execution adapter is installed. Sessions can be planned, prepared and started, but
            nothing runs until Claude and Codex execution arrive.
          </AlertDescription>
        </Alert>

        {error && (
          <Alert variant="destructive" className="mb-4" role="alert">
            <AlertDescription className="flex items-center justify-between gap-2">
              <span data-testid="sessions-error">{error}</span>
              {actionError && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Dismiss"
                  onClick={() => setActionError(null)}
                >
                  <X />
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {items === null && !listError && (
          <p className="text-muted-foreground" role="status">
            Loading sessions…
          </p>
        )}

        {items && items.length === 0 && (
          <div
            className="flex flex-col items-center gap-3 py-12 text-center"
            data-testid="sessions-empty"
          >
            <ListChecks className="text-muted-foreground size-10" aria-hidden="true" />
            <h2 className="text-lg font-semibold">No sessions yet</h2>
            <p className="text-muted-foreground max-w-sm">
              A session records an objective, its workspace, an execution profile and a plan of
              tasks for future agents.
            </p>
            <Button onClick={() => setDialog({ kind: 'create', projectId: null })}>
              New session
            </Button>
          </div>
        )}

        {items && items.length > 0 && (
          <div className="grid gap-6 lg:grid-cols-[minmax(260px,360px)_minmax(0,1fr)]">
            <ul className="flex flex-col gap-2" aria-label="Sessions">
              {items.map(({ session, projectName, taskCounts }) => {
                const selected = session.id === shownId;
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      className={cn(
                        'bg-card hover:bg-accent/60 focus-visible:ring-ring/50 flex w-full min-w-0 flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors outline-none focus-visible:ring-[3px]',
                        selected && 'border-sidebar-primary bg-accent/60',
                      )}
                      aria-pressed={selected}
                      onClick={() => setSelectedId(session.id)}
                      data-testid="session-card"
                      data-session-id={session.id}
                    >
                      <span className="flex min-w-0 items-center justify-between gap-2">
                        <span className="truncate font-medium">{session.name}</span>
                        <SessionStatusBadge status={session.status} />
                      </span>
                      <span className="text-muted-foreground truncate text-xs">
                        {projectName ?? session.workspacePath ?? 'No workspace'}
                      </span>
                      <span className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        <span>{profileLabel(session.executionProfile)}</span>
                        <span>
                          Tasks {taskCounts.completed}/{taskCounts.total}
                        </span>
                        <span>Updated {formatDate(session.updatedAt)}</span>
                        {session.archivedAt !== null && <span>Archived</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="min-w-0">
              {details ? (
                <SessionDetailsPanel
                  details={details}
                  events={events}
                  onEdit={() => setDialog({ kind: 'edit', session: details.session })}
                  {...(onOpenPreflight && details.session.projectId !== null
                    ? { onOpenPreflight: () => onOpenPreflight(details.session.projectId!) }
                    : {})}
                  onRequestAction={requestAction}
                  onChanged={() => void Promise.all([reload(), reloadDetails()])}
                />
              ) : (
                shownId !== null &&
                !detailsError && (
                  <p className="text-muted-foreground py-8 text-center" role="status">
                    Loading session…
                  </p>
                )
              )}
            </div>
          </div>
        )}
      </div>

      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
        <SessionFormDialog
          projects={projects.items ?? []}
          {...(dialog.kind === 'edit'
            ? { session: dialog.session }
            : { initialProjectId: dialog.projectId })}
          onClose={() => setDialog(null)}
          onSaved={(session) => {
            setDialog(null);
            setSelectedId(session.id);
            void Promise.all([reload(), reloadDetails()]);
          }}
        />
      )}
      {dialog?.kind === 'cancel' && (
        <AlertDialog open onOpenChange={(open) => !open && setDialog(null)}>
          <AlertDialogContent data-testid="cancel-session-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel session</AlertDialogTitle>
              <AlertDialogDescription>
                Cancel <strong className="text-foreground">{dialog.session.name}</strong>? Its
                unfinished tasks are cancelled too. A cancelled session cannot be restarted.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep session</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => void perform(dialog.session.id, 'cancel')}
              >
                Cancel session
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </main>
  );
}
