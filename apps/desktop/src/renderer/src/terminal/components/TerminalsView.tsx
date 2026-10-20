import {
  TERMINAL_GROUP_NAME_MAX_LENGTH,
  TERMINAL_TITLE_MAX_LENGTH,
  UNGROUPED_WORKSPACE,
  isFinalTerminalStatus,
  type ShellCatalog,
  type TerminalGroup,
  type TerminalSession,
} from '@atlas/contracts';
import type { AppCommand } from '@atlas/contracts/ipc';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { useProjects } from '@/hooks/useProjects';
import type { useTerminalGroups } from '../hooks/useTerminalGroups';
import type { useTerminalPreferences } from '../hooks/useTerminalPreferences';
import type { TerminalSessionsState } from '../hooks/useTerminalSessions';
import { CloseTerminalDialog } from './CloseTerminalDialog';
import { DeleteGroupDialog } from './DeleteGroupDialog';
import { NameDialog } from './NameDialog';
import { ProjectSheet, type ProjectSheetRequest } from './ProjectSheet';
import { TerminalSidebar, membersOf } from './TerminalSidebar';
import { TerminalWorkspace } from './TerminalWorkspace';

interface TerminalsViewProps {
  projects: ReturnType<typeof useProjects>;
  terminals: TerminalSessionsState;
  groups: ReturnType<typeof useTerminalGroups>;
  preferences: ReturnType<typeof useTerminalPreferences>;
  /** Open a terminal in this project once the view is shown (from the Projects view). */
  openRequest: { projectId: string; nonce: number } | null;
  /** Called once the request was taken, so it is not replayed when the view mounts again. */
  onOpenRequestHandled: () => void;
  subscribeCommands: (handler: (command: AppCommand) => void) => () => void;
  /** Opens the Git view on a terminal's repository. */
  onOpenGit: (terminalId: string) => void;
}

type NameDialogState =
  | { kind: 'create-group' }
  | { kind: 'rename-group'; group: TerminalGroup }
  | { kind: 'rename-terminal'; session: TerminalSession };

interface PendingClose {
  session: TerminalSession;
  processName?: string;
}

/**
 * Multi-workspace terminal environment: terminal groups (and ungrouped terminals)
 * with their own tabs and splits. Terminals of any project, or none, run side by side.
 */
export function TerminalsView({
  projects,
  terminals,
  groups,
  preferences,
  openRequest,
  onOpenRequestHandled,
  subscribeCommands,
  onOpenGit,
}: TerminalsViewProps) {
  const [workspace, setWorkspace] = useState<string>(UNGROUPED_WORKSPACE);
  const [focusRequest, setFocusRequest] = useState<{ sessionId: string; nonce: number } | null>(
    null,
  );
  const [shells, setShells] = useState<ShellCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<TerminalGroup | null>(null);
  const [sheet, setSheet] = useState<ProjectSheetRequest | null>(null);
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);

  const sessions = useMemo(() => terminals.sessions ?? [], [terminals.sessions]);
  const groupList = groups.groups ?? [];
  const projectList = projects.items ?? [];
  const activeGroup = groupList.find((group) => group.id === workspace);
  const workspaceKey = activeGroup ? activeGroup.id : UNGROUPED_WORKSPACE;

  useEffect(() => {
    unwrap(api().terminals.shells()).then(setShells, () => setShells(null));
  }, [preferences.preferences?.defaultShellId]);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(errorMessage(caught));
      return undefined;
    }
  }, []);

  /** A workspace chosen directly drops any pending "show this terminal" request. */
  const selectWorkspace = useCallback((key: string) => {
    setFocusRequest(null);
    setWorkspace(key);
  }, []);

  const showTerminal = useCallback((session: TerminalSession) => {
    setWorkspace(session.groupId ?? UNGROUPED_WORKSPACE);
    setFocusRequest({ sessionId: session.id, nonce: Date.now() });
  }, []);

  const openInProject = useCallback(
    async (projectId: string) => {
      const session = await run(() =>
        unwrap(
          api().terminals.create({
            projectId,
            ...(activeGroup ? { groupId: activeGroup.id } : {}),
          }),
        ),
      );
      if (!session) return;
      terminals.upsert(session);
      showTerminal(session);
    },
    [activeGroup, run, showTerminal, terminals],
  );

  // A request from the Projects view ("Open terminal").
  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (openRequest === null || openRequest.nonce === handledRequest.current) return;
    handledRequest.current = openRequest.nonce;
    onOpenRequestHandled();
    void openInProject(openRequest.projectId);
  }, [onOpenRequestHandled, openInProject, openRequest]);

  /** Closing terminates the process; asks first when a program is running. */
  const requestClose = useCallback(
    async (sessionId: string) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return;
      const info = await run(() => unwrap(api().terminals.closeInfo(sessionId)));
      if (!info) return;
      if (info.requiresConfirmation) {
        setPendingClose({
          session,
          ...(info.processName !== undefined ? { processName: info.processName } : {}),
        });
      } else {
        await run(() => unwrap(api().terminals.dismiss(sessionId)));
      }
    },
    [run, sessions],
  );

  const submitName = async (value: string): Promise<string | null> => {
    if (!nameDialog) return null;
    try {
      if (nameDialog.kind === 'create-group') {
        const group = await unwrap(api().groups.create(value));
        setWorkspace(group.id);
      } else if (nameDialog.kind === 'rename-group') {
        await unwrap(api().groups.rename(nameDialog.group.id, value));
      } else {
        terminals.upsert(await unwrap(api().terminals.rename(nameDialog.session.id, value)));
      }
      return null;
    } catch (caught) {
      return errorMessage(caught);
    }
  };

  const updateSession = (action: () => Promise<TerminalSession>) =>
    void run(async () => terminals.upsert(await action()));

  const workspaceSessions = membersOf(sessions, activeGroup ? activeGroup.id : null);

  return (
    <main className="flex min-h-0 min-w-0 flex-1">
      <aside
        className="hidden w-72 shrink-0 flex-col border-r md:flex"
        aria-label="Terminal navigation"
      >
        <TerminalSidebar
          groups={groupList}
          sessions={sessions}
          projects={projectList}
          activeWorkspace={workspaceKey}
          onSelectWorkspace={selectWorkspace}
          onSelectTerminal={showTerminal}
          onCreateGroup={() => setNameDialog({ kind: 'create-group' })}
          onRenameGroup={(group) => setNameDialog({ kind: 'rename-group', group })}
          onDeleteGroup={setDeleteGroup}
          onToggleGroup={(group) =>
            void run(() => unwrap(api().groups.setCollapsed(group.id, !group.collapsed)))
          }
          onMoveGroup={(group, position) =>
            void run(() => unwrap(api().groups.move(group.id, position)))
          }
          onRenameTerminal={(session) => setNameDialog({ kind: 'rename-terminal', session })}
          onRestoreName={(session) =>
            updateSession(() => unwrap(api().terminals.rename(session.id, null)))
          }
          onMoveTerminal={(session, groupId, position) =>
            updateSession(() =>
              unwrap(api().terminals.move(session.id, groupId, Math.max(0, position))),
            )
          }
          onAssociate={(session, projectId) =>
            updateSession(() => unwrap(api().terminals.associate(session.id, projectId)))
          }
          onCloseTerminal={(session) => void requestClose(session.id)}
          onProjectInfo={(projectId) => setSheet({ kind: 'project', projectId })}
          onNewTerminalInProject={(projectId) => void openInProject(projectId)}
        />
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Compact workspace switcher for narrow windows. */}
        <div className="border-b p-2 md:hidden">
          <Select value={workspaceKey} onValueChange={selectWorkspace}>
            <SelectTrigger className="w-full" aria-label="Terminal group">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {groupList.map((group) => (
                <SelectItem key={group.id} value={group.id}>
                  {group.name}
                </SelectItem>
              ))}
              <SelectItem value={UNGROUPED_WORKSPACE}>Ungrouped</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {(error ?? terminals.error ?? groups.error) && (
          <Alert
            variant="destructive"
            className="m-2 w-auto"
            role="alert"
            data-testid="terminals-error"
          >
            <AlertDescription>{error ?? terminals.error ?? groups.error}</AlertDescription>
          </Alert>
        )}

        {terminals.sessions !== null &&
          groups.groups !== null &&
          preferences.preferences !== null && (
            <TerminalWorkspace
              // Remount per workspace and after an Engine restart: views reattach from Engine state.
              key={`${workspaceKey}:${terminals.epoch}`}
              workspace={{
                key: workspaceKey,
                name: activeGroup?.name ?? 'Ungrouped',
                groupId: activeGroup?.id ?? null,
              }}
              sessions={workspaceSessions}
              projects={projectList}
              preferences={preferences.preferences}
              shells={shells}
              focusRequest={focusRequest}
              onSessionChanged={terminals.upsert}
              onRequestClose={(sessionId) => void requestClose(sessionId)}
              onProjectInfo={(sessionId) => setSheet({ kind: 'terminal', sessionId })}
              onOpenGit={onOpenGit}
              onFontSize={preferences.changeFontSize}
              onPreferences={(changes) => void preferences.update(changes)}
              subscribeCommands={subscribeCommands}
            />
          )}
      </div>

      {nameDialog && (
        <NameDialog
          title={
            nameDialog.kind === 'create-group'
              ? 'New terminal group'
              : nameDialog.kind === 'rename-group'
                ? 'Rename group'
                : 'Rename terminal'
          }
          {...(nameDialog.kind === 'rename-terminal'
            ? {
                description:
                  'A custom name is kept when the directory or program changes. Restore the automatic name from the terminal menu.',
              }
            : {})}
          label="Name"
          initialValue={
            nameDialog.kind === 'create-group'
              ? ''
              : nameDialog.kind === 'rename-group'
                ? nameDialog.group.name
                : nameDialog.session.title
          }
          submitLabel={nameDialog.kind === 'create-group' ? 'Create group' : 'Rename'}
          maxLength={
            nameDialog.kind === 'rename-terminal'
              ? TERMINAL_TITLE_MAX_LENGTH
              : TERMINAL_GROUP_NAME_MAX_LENGTH
          }
          onSubmit={submitName}
          onClose={() => setNameDialog(null)}
        />
      )}

      {deleteGroup && (
        <DeleteGroupDialog
          group={deleteGroup}
          terminalCount={membersOf(sessions, deleteGroup.id).length}
          runningCount={
            membersOf(sessions, deleteGroup.id).filter((s) => !isFinalTerminalStatus(s.status))
              .length
          }
          onConfirm={async (terminateTerminals) => {
            await run(() => unwrap(api().groups.delete(deleteGroup.id, { terminateTerminals })));
            if (workspace === deleteGroup.id) setWorkspace(UNGROUPED_WORKSPACE);
            setDeleteGroup(null);
          }}
          onClose={() => setDeleteGroup(null)}
        />
      )}

      {sheet && (
        <ProjectSheet
          request={sheet}
          projects={projectList}
          onOpenTerminal={(projectId) => {
            setSheet(null);
            void openInProject(projectId);
          }}
          onChanged={() => {
            void projects.reload();
            void terminals.reload();
          }}
          onClose={() => setSheet(null)}
        />
      )}

      {pendingClose && (
        <CloseTerminalDialog
          session={pendingClose.session}
          {...(pendingClose.processName !== undefined
            ? { processName: pendingClose.processName }
            : {})}
          onCancel={() => setPendingClose(null)}
          onConfirm={() => {
            const { session } = pendingClose;
            setPendingClose(null);
            void run(() => unwrap(api().terminals.dismiss(session.id)));
          }}
        />
      )}
    </main>
  );
}
