import type {
  AtlasSessionDetails,
  SessionAction,
  SessionEvent,
  SessionTask,
} from '@atlas/contracts';
import { Bot, MoreHorizontal, Plus, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDate } from '@/format';
import { ACTION_LABELS, TASK_STATUS, describeEvent, profileLabel } from '../format';
import { SessionStatusBadge } from './SessionStatusBadge';
import { TaskFormDialog } from './TaskFormDialog';

interface SessionDetailsPanelProps {
  details: AtlasSessionDetails;
  events: SessionEvent[];
  onEdit: () => void;
  /** Opens Preflight for the session's project; absent without a project. */
  onOpenPreflight?: () => void;
  /** Asks for confirmation before destructive actions (cancel). */
  onRequestAction: (action: SessionAction) => void;
  onChanged: () => void;
}

type TaskDialog = { kind: 'add' } | { kind: 'edit'; task: SessionTask } | null;

export function SessionDetailsPanel({
  details,
  events,
  onEdit,
  onOpenPreflight,
  onRequestAction,
  onChanged,
}: SessionDetailsPanelProps) {
  const { session, workspace, tasks } = details;
  const [taskDialog, setTaskDialog] = useState<TaskDialog>(null);
  const [error, setError] = useState<string | null>(null);
  const titles = new Map(tasks.map((task) => [task.id, task.title]));

  const taskAction = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <section
      className="flex min-w-0 flex-col gap-4"
      aria-labelledby="session-title"
      data-testid="session-details"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 id="session-title" className="truncate text-xl font-semibold">
              {session.name}
            </h2>
            <SessionStatusBadge status={session.status} />
            {session.archivedAt !== null && <Badge variant="secondary">Archived</Badge>}
          </div>
          <p className="text-muted-foreground text-xs" data-testid="session-execution-state">
            {details.executing ? 'Executing tasks' : 'Not executing — configuration only'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2" data-testid="session-actions">
          {onOpenPreflight && (
            <Button variant="outline" onClick={onOpenPreflight}>
              <ShieldCheck />
              Preflight
            </Button>
          )}
          {session.status === 'DRAFT' && session.archivedAt === null && (
            <Button variant="outline" onClick={onEdit}>
              Edit
            </Button>
          )}
          {details.availableActions.map((action) => (
            <Button
              key={action}
              variant={
                action === 'cancel' ? 'destructive' : action === 'start' ? 'default' : 'secondary'
              }
              onClick={() => onRequestAction(action)}
            >
              {ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      </header>

      {session.status === 'WAITING_EXECUTOR' && (
        <Alert role="status" className="border-warning/40" data-testid="waiting-executor">
          <TriangleAlert className="text-warning" />
          <AlertDescription>
            The session is prepared and waiting for an executor. No execution adapter is installed
            yet, so no agent is working on it.
          </AlertDescription>
        </Alert>
      )}
      {session.status === 'INTERRUPTED' && (
        <Alert role="status" className="border-destructive/40" data-testid="interrupted">
          <TriangleAlert className="text-destructive" />
          <AlertDescription>
            Work in progress was interrupted when ATLAS stopped. It was not completed and is never
            resumed automatically.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid="session-error">{error}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tasks">Tasks ({tasks.length})</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="approvals">Approvals ({details.pendingApprovals.length})</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-4 pt-2">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">Objective</h3>
            <p className="text-sm break-words whitespace-pre-wrap" data-testid="session-objective">
              {session.objective}
            </p>
          </div>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-sm">
            <dt className="text-muted-foreground">Workspace</dt>
            <dd className="min-w-0 break-all" data-testid="session-workspace-details">
              {workspace.kind === 'none' && <span className="text-muted-foreground">None</span>}
              {workspace.kind === 'project' && (
                <>
                  {workspace.projectName}{' '}
                  <span className="text-muted-foreground font-mono text-xs">{workspace.path}</span>
                </>
              )}
              {workspace.kind === 'directory' && (
                <span className="font-mono text-xs">{workspace.path}</span>
              )}
              {workspace.kind !== 'none' && !workspace.available && (
                <span className="text-warning ml-2 text-xs">Unavailable</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Execution profile</dt>
            <dd data-testid="session-profile-details">{profileLabel(session.executionProfile)}</dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd>{formatDate(session.createdAt)}</dd>
            <dt className="text-muted-foreground">Updated</dt>
            <dd>{formatDate(session.updatedAt)}</dd>
            <dt className="text-muted-foreground">Execution started</dt>
            <dd>{session.startedAt ? formatDate(session.startedAt) : 'Not started'}</dd>
            {session.endedAt && (
              <>
                <dt className="text-muted-foreground">Ended</dt>
                <dd>{formatDate(session.endedAt)}</dd>
              </>
            )}
          </dl>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">Constraints</h3>
            {session.constraints.length > 0 ? (
              <ul className="list-disc pl-5 text-sm">
                {session.constraints.map((constraint, index) => (
                  <li key={index} className="break-words">
                    {constraint}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">None</p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="tasks" className="flex flex-col gap-3 pt-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              Planned work and its dependencies. Tasks are not executed yet.
            </p>
            {details.tasksEditable && (
              <Button size="sm" onClick={() => setTaskDialog({ kind: 'add' })}>
                <Plus />
                Add task
              </Button>
            )}
          </div>
          {tasks.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">No tasks planned.</p>
          ) : (
            <ol className="flex flex-col gap-2" aria-label="Tasks" data-testid="session-tasks">
              {tasks.map((task, index) => {
                const editable =
                  details.tasksEditable &&
                  (task.status === 'PENDING' || task.status === 'INTERRUPTED');
                return (
                  <li
                    key={task.id}
                    className="bg-card flex min-w-0 items-start gap-3 rounded-lg border p-3"
                    data-testid="session-task"
                  >
                    <span className="text-muted-foreground w-6 shrink-0 text-right text-sm tabular-nums">
                      {index + 1}.
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{task.title}</span>
                        <Badge variant="outline">{TASK_STATUS[task.status]}</Badge>
                        {task.status === 'PENDING' && task.blockedBy.length > 0 && (
                          <Badge variant="secondary" data-testid="task-blocked">
                            Blocked
                          </Badge>
                        )}
                      </div>
                      {task.description && (
                        <p className="text-muted-foreground text-sm break-words whitespace-pre-wrap">
                          {task.description}
                        </p>
                      )}
                      {task.dependencies.length > 0 && (
                        <p className="text-muted-foreground text-xs">
                          Depends on:{' '}
                          {task.dependencies.map((id) => titles.get(id) ?? 'unknown').join(', ')}
                        </p>
                      )}
                      {task.validationCriteria.length > 0 && (
                        <ul className="text-muted-foreground list-disc pl-5 text-xs">
                          {task.validationCriteria.map((criterion, criterionIndex) => (
                            <li key={criterionIndex}>{criterion}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {editable && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Task actions: ${task.title}`}
                          >
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setTaskDialog({ kind: 'edit', task })}>
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              void taskAction(() =>
                                unwrap(api().sessions.cancelTask(session.id, task.id)),
                              )
                            }
                          >
                            Cancel task
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() =>
                              void taskAction(() =>
                                unwrap(api().sessions.removeTask(session.id, task.id)),
                              )
                            }
                          >
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </TabsContent>

        <TabsContent value="events" className="pt-2">
          <ol className="flex flex-col" aria-label="Event history" data-testid="session-events">
            {[...events].reverse().map((event) => {
              const { title, details: eventDetails } = describeEvent(
                event,
                (id) => titles.get(id) ?? null,
              );
              return (
                <li
                  key={event.id}
                  className="border-l py-2 pl-4"
                  data-testid="session-event"
                  data-type={event.type}
                >
                  <p className="text-sm font-medium">{title}</p>
                  {eventDetails && (
                    <p className="text-muted-foreground text-xs break-words">{eventDetails}</p>
                  )}
                  <time className="text-muted-foreground text-xs" dateTime={event.occurredAt}>
                    {formatDate(event.occurredAt)}
                  </time>
                </li>
              );
            })}
          </ol>
        </TabsContent>

        <TabsContent value="approvals" className="pt-2">
          {details.pendingApprovals.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 py-6 text-center text-sm">
              <ShieldCheck className="size-6" aria-hidden="true" />
              <p>No pending approvals.</p>
              <p className="max-w-sm text-xs">
                Sensitive operations will ask for your approval here once execution is available.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {details.pendingApprovals.map((approval) => (
                <li key={approval.id} className="rounded-lg border p-3 text-sm">
                  <p>{approval.summary}</p>
                  <p className="text-muted-foreground text-xs">
                    Requested {formatDate(approval.requestedAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="agents" className="pt-2">
          <div
            className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center text-sm"
            data-testid="session-agents"
          >
            <Bot className="size-6" aria-hidden="true" />
            <p>No agents assigned.</p>
            <p className="max-w-sm text-xs">
              Agent terminals and execution results will appear here when Claude and Codex execution
              adapters are added.
            </p>
          </div>
        </TabsContent>
      </Tabs>

      {taskDialog && (
        <TaskFormDialog
          sessionId={session.id}
          tasks={tasks}
          {...(taskDialog.kind === 'edit' ? { task: taskDialog.task } : {})}
          onClose={() => setTaskDialog(null)}
          onSaved={() => {
            setTaskDialog(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}
