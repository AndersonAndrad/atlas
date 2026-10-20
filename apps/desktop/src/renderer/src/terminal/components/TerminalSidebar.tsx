import {
  UNGROUPED_WORKSPACE,
  isFinalTerminalStatus,
  type TerminalGroup,
  type TerminalSession,
} from '@atlas/contracts';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Info,
  Inbox,
  MoreHorizontal,
  Plus,
} from 'lucide-react';
import { useState, type DragEvent, type ReactNode } from 'react';
import { GitSyncBadges } from '@/components/git/GitBadges';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { ProjectDetails } from '@/types';
import { useProjectGit } from '../hooks/useGitStatus';
import { TerminalStatusDot } from './TerminalStatusDot';

const DRAG_TYPE = 'application/x-atlas-terminal';
/** Position meaning "at the end"; the Engine clamps it to the group size. */
const END_POSITION = 10_000;

export interface TerminalSidebarActions {
  onSelectWorkspace: (key: string) => void;
  onSelectTerminal: (session: TerminalSession) => void;
  onCreateGroup: () => void;
  onRenameGroup: (group: TerminalGroup) => void;
  onDeleteGroup: (group: TerminalGroup) => void;
  onToggleGroup: (group: TerminalGroup) => void;
  onMoveGroup: (group: TerminalGroup, position: number) => void;
  onRenameTerminal: (session: TerminalSession) => void;
  onRestoreName: (session: TerminalSession) => void;
  onMoveTerminal: (session: TerminalSession, groupId: string | null, position: number) => void;
  onAssociate: (session: TerminalSession, projectId: string | null) => void;
  onCloseTerminal: (session: TerminalSession) => void;
  onProjectInfo: (projectId: string) => void;
  onNewTerminalInProject: (projectId: string) => void;
}

interface TerminalSidebarProps extends TerminalSidebarActions {
  groups: TerminalGroup[];
  /** All terminals, any project. */
  sessions: TerminalSession[];
  projects: ProjectDetails[];
  activeWorkspace: string;
}

/** Members of a group (or the ungrouped terminals) in display order. */
export function membersOf(sessions: TerminalSession[], groupId: string | null): TerminalSession[] {
  return sessions
    .filter((session) => session.groupId === groupId)
    .sort((a, b) => a.groupPosition - b.groupPosition || a.createdAt.localeCompare(b.createdAt));
}

/**
 * Terminal groups (collapsible), ungrouped terminals and registered projects.
 * Terminals move by drag and drop or, equivalently, through their menus.
 */
export function TerminalSidebar(props: TerminalSidebarProps) {
  const { groups, sessions, projects, activeWorkspace } = props;
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const ungrouped = membersOf(sessions, null);

  const dropHandlers = (target: string, groupId: string | null, position: () => number) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDropTarget(target);
    },
    onDragLeave: () => setDropTarget((current) => (current === target ? null : current)),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDropTarget(null);
      const session = sessions.find((item) => item.id === event.dataTransfer.getData(DRAG_TYPE));
      if (session) props.onMoveTerminal(session, groupId, position());
    },
  });

  const terminalRows = (members: TerminalSession[], groupId: string | null) => (
    <ul className="flex flex-col" aria-label="Terminals">
      {members.map((session, index) => (
        <TerminalRow
          key={session.id}
          session={session}
          index={index}
          count={members.length}
          groupId={groupId}
          groups={groups}
          projects={projects}
          dropActive={dropTarget === `terminal:${session.id}`}
          dropHandlers={dropHandlers(`terminal:${session.id}`, groupId, () => index)}
          actions={props}
        />
      ))}
    </ul>
  );

  return (
    <nav
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      aria-label="Terminal groups and projects"
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <h2 className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
          Terminal groups
        </h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New group"
          title="New group"
          onClick={props.onCreateGroup}
        >
          <FolderPlus />
        </Button>
      </div>

      <ul className="flex flex-col gap-0.5 px-1.5">
        {groups.map((group, index) => {
          const members = membersOf(sessions, group.id);
          const running = members.filter((s) => !isFinalTerminalStatus(s.status)).length;
          return (
            <li key={group.id} data-testid="terminal-group" data-group-id={group.id}>
              <WorkspaceHeader
                active={activeWorkspace === group.id}
                dropActive={dropTarget === `group:${group.id}`}
                {...dropHandlers(`group:${group.id}`, group.id, () => members.length)}
                expanded={!group.collapsed}
                onToggle={() => props.onToggleGroup(group)}
                onSelect={() => props.onSelectWorkspace(group.id)}
                icon={<Folder className="size-3.5 shrink-0" aria-hidden="true" />}
                label={group.name}
                count={running}
                menu={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Actions for group ${group.name}`}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => props.onRenameGroup(group)}>
                        Rename…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === 0}
                        onSelect={() => props.onMoveGroup(group, index - 1)}
                      >
                        Move up
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === groups.length - 1}
                        onSelect={() => props.onMoveGroup(group, index + 1)}
                      >
                        Move down
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => props.onDeleteGroup(group)}
                      >
                        Delete group…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              />
              {!group.collapsed &&
                (members.length > 0 ? (
                  terminalRows(members, group.id)
                ) : (
                  <p className="text-muted-foreground py-1 pl-9 text-xs">Drop terminals here</p>
                ))}
            </li>
          );
        })}

        <li data-testid="terminal-group-ungrouped">
          <WorkspaceHeader
            active={activeWorkspace === UNGROUPED_WORKSPACE}
            dropActive={dropTarget === 'ungrouped'}
            {...dropHandlers('ungrouped', null, () => ungrouped.length)}
            onSelect={() => props.onSelectWorkspace(UNGROUPED_WORKSPACE)}
            icon={<Inbox className="size-3.5 shrink-0" aria-hidden="true" />}
            label="Ungrouped"
            count={ungrouped.filter((s) => !isFinalTerminalStatus(s.status)).length}
          />
          {terminalRows(ungrouped, null)}
        </li>
      </ul>

      <div className="mt-3 border-t px-3 pt-3 pb-1">
        <h2 className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
          Projects
        </h2>
      </div>
      <ul className="flex flex-col gap-0.5 px-1.5 pb-3" aria-label="Projects">
        {projects.length === 0 && (
          <li className="text-muted-foreground px-2 text-xs">No projects registered.</li>
        )}
        {projects.map((item) => (
          <SidebarProjectRow
            key={item.project.id}
            item={item}
            onProjectInfo={props.onProjectInfo}
            onNewTerminalInProject={props.onNewTerminalInProject}
          />
        ))}
      </ul>
    </nav>
  );
}

interface SidebarProjectRowProps {
  item: ProjectDetails;
  onProjectInfo: (projectId: string) => void;
  onNewTerminalInProject: (projectId: string) => void;
}

/** A registered project with its commits to push and to pull, when it tracks an upstream. */
function SidebarProjectRow({
  item,
  onProjectInfo,
  onNewTerminalInProject,
}: SidebarProjectRowProps) {
  const { status } = useProjectGit(item.project.id);
  const snapshot = status?.state === 'repository' ? status.snapshot : null;
  const tracksUpstream = snapshot !== null && snapshot.ahead !== null && snapshot.behind !== null;
  return (
    <li
      className="group/project flex items-center rounded-md hover:bg-accent/50"
      data-testid="sidebar-project"
    >
      <button
        type="button"
        className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={() => onProjectInfo(item.project.id)}
        title="Project details"
      >
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            item.availability.status === 'available' ? 'bg-success' : 'bg-warning',
          )}
          aria-hidden="true"
        />
        <span className="truncate">{item.project.name}</span>
      </button>
      {tracksUpstream && (
        <span className="flex shrink-0 items-center gap-1" data-testid="sidebar-project-sync">
          <GitSyncBadges snapshot={snapshot} />
        </span>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="mr-1"
        aria-label={`New terminal in ${item.project.name}`}
        title="New terminal in this project"
        disabled={item.availability.status !== 'available'}
        onClick={() => onNewTerminalInProject(item.project.id)}
      >
        <Plus />
      </Button>
    </li>
  );
}

interface WorkspaceHeaderProps {
  active: boolean;
  dropActive: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onSelect: () => void;
  icon: ReactNode;
  label: string;
  count: number;
  menu?: ReactNode;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent) => void;
}

function WorkspaceHeader(props: WorkspaceHeaderProps) {
  return (
    <div
      className={cn(
        'flex h-8 items-center gap-0.5 rounded-md pr-1',
        props.active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
        props.dropActive && 'ring-sidebar-primary ring-2',
      )}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
    >
      {props.onToggle ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={props.expanded ? `Collapse ${props.label}` : `Expand ${props.label}`}
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          {props.expanded ? <ChevronDown /> : <ChevronRight />}
        </Button>
      ) : (
        <span className="w-6" aria-hidden="true" />
      )}
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-current={props.active ? 'true' : undefined}
        onClick={props.onSelect}
        data-testid="workspace-button"
      >
        {props.icon}
        <span className="truncate">{props.label}</span>
        {props.count > 0 && (
          <span
            className="text-muted-foreground ml-auto text-xs tabular-nums"
            aria-label={`${props.count} running`}
          >
            {props.count}
          </span>
        )}
      </button>
      {props.menu}
    </div>
  );
}

interface TerminalRowProps {
  session: TerminalSession;
  index: number;
  count: number;
  groupId: string | null;
  groups: TerminalGroup[];
  projects: ProjectDetails[];
  dropActive: boolean;
  dropHandlers: Pick<WorkspaceHeaderProps, 'onDragOver' | 'onDragLeave' | 'onDrop'>;
  actions: TerminalSidebarActions;
}

function TerminalRow({
  session,
  index,
  count,
  groupId,
  groups,
  projects,
  dropActive,
  dropHandlers,
  actions,
}: TerminalRowProps) {
  const associated = projects.find((item) => item.project.id === session.projectId)?.project.name;
  // Shown next to the name unless it would repeat it.
  const projectName = associated !== session.title ? associated : undefined;
  return (
    <li
      className={cn(
        'group/terminal flex h-7 items-center rounded-md pl-6 hover:bg-accent/50',
        dropActive && 'ring-sidebar-primary ring-2',
      )}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, session.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      {...dropHandlers}
      data-testid="sidebar-terminal"
      data-session-id={session.id}
    >
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-2 px-1.5 text-left text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={() => actions.onSelectTerminal(session)}
        title={projectName ? `${session.title} · ${projectName}` : session.title}
      >
        <TerminalStatusDot status={session.status} />
        <span className="truncate">{session.title}</span>
        {projectName && (
          <span className="text-muted-foreground hidden truncate xl:inline">{projectName}</span>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="mr-1 opacity-60 group-hover/terminal:opacity-100 focus-visible:opacity-100"
            aria-label={`Actions for ${session.title}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56" data-testid="terminal-actions">
          <DropdownMenuItem onSelect={() => actions.onRenameTerminal(session)}>
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={session.customTitle === null}
            onSelect={() => actions.onRestoreName(session)}
          >
            Restore automatic name
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to group</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {groups.map((group) => (
                <DropdownMenuItem
                  key={group.id}
                  disabled={group.id === groupId}
                  onSelect={() => actions.onMoveTerminal(session, group.id, END_POSITION)}
                >
                  {group.name}
                </DropdownMenuItem>
              ))}
              {groups.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                disabled={groupId === null}
                onSelect={() => actions.onMoveTerminal(session, null, END_POSITION)}
              >
                Ungrouped
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            disabled={index === 0}
            onSelect={() => actions.onMoveTerminal(session, groupId, index - 1)}
          >
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={index === count - 1}
            onSelect={() => actions.onMoveTerminal(session, groupId, index + 1)}
          >
            Move down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Project</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
              <DropdownMenuLabel>Associate with</DropdownMenuLabel>
              {projects.map((item) => (
                <DropdownMenuItem
                  key={item.project.id}
                  disabled={item.project.id === session.projectId}
                  onSelect={() => actions.onAssociate(session, item.project.id)}
                >
                  {item.project.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={session.projectId === null}
                onSelect={() => actions.onAssociate(session, null)}
              >
                No project (standalone)
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {session.projectId && (
            <DropdownMenuItem onSelect={() => actions.onProjectInfo(session.projectId!)}>
              <Info />
              Project details
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => actions.onCloseTerminal(session)}>
            {isFinalTerminalStatus(session.status) ? 'Close' : 'Terminate…'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
