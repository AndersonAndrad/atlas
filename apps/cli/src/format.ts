import type {
  AtlasSessionDetails,
  AtlasSessionListItem,
  AtlasSessionStatus,
  GitStatus,
  ProjectDetails,
  SessionEvent,
  SessionTask,
  SessionWorkspace,
  TerminalSession,
} from '@atlas/contracts';

const AVAILABILITY_LABELS: Record<ProjectDetails['availability']['status'], string> = {
  available: 'available',
  missing: 'unavailable (missing)',
  'not-a-directory': 'unavailable (not a directory)',
  'permission-denied': 'unavailable (permission denied)',
};

function gitLabel(details: ProjectDetails): string {
  if (!details.git.isRepository) return 'no';
  if (details.git.branch) return `yes (${details.git.branch})`;
  return details.git.detached ? 'yes (detached HEAD)' : 'yes';
}

export function formatProjectList(items: ProjectDetails[]): string {
  if (items.length === 0) {
    return 'No projects registered. Add one with: atlas project add <path>\n';
  }
  const rows = items.map((item) => [
    item.isSelected ? '*' : ' ',
    item.project.id,
    item.project.name,
    AVAILABILITY_LABELS[item.availability.status],
    gitLabel(item),
    item.project.workspacePath,
  ]);
  const header = [' ', 'ID', 'NAME', 'STATUS', 'GIT', 'PATH'];
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]!.length)),
  );
  const render = (row: string[]) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]!)))
      .join('  ');
  return `${[header, ...rows].map(render).join('\n')}\n`;
}

export function formatProjectDetails(details: ProjectDetails): string {
  const { project } = details;
  const lines: [string, string][] = [
    ['ID', project.id],
    ['Name', project.name],
    ['Path', project.workspacePath],
    ['Status', AVAILABILITY_LABELS[details.availability.status]],
    ['Git', gitLabel(details)],
  ];
  if (details.git.repositoryRoot) lines.push(['Git root', details.git.repositoryRoot]);
  if (project.description) lines.push(['Description', project.description]);
  lines.push(['Tags', project.tags.length > 0 ? project.tags.join(', ') : '-']);
  lines.push(['Created', project.createdAt]);
  lines.push(['Updated', project.updatedAt]);
  lines.push(['Last opened', project.lastOpenedAt ?? '-']);
  lines.push(['Selected', details.isSelected ? 'yes' : 'no']);
  const width = Math.max(...lines.map(([label]) => label.length));
  return `${lines.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n')}\n`;
}

const STATUS_LABELS: Record<TerminalSession['status'], string> = {
  CREATED: 'created',
  STARTING: 'starting',
  RUNNING: 'running',
  EXITED: 'exited',
  FAILED: 'failed',
  TERMINATING: 'terminating',
  TERMINATED: 'terminated',
};

function terminalStatus(session: TerminalSession): string {
  const label = STATUS_LABELS[session.status];
  if (session.status === 'EXITED' && session.exitCode !== undefined) {
    return `${label} (${session.exitCode})`;
  }
  if (session.endReason === 'engine-lost') return `${label} (engine stopped)`;
  return label;
}

export function formatTerminalList(sessions: TerminalSession[]): string {
  if (sessions.length === 0) {
    return 'No terminals. Open one with: atlas terminal open [--project <id> | --cwd <path>]\n';
  }
  const rows = sessions.map((session) => [
    session.id,
    session.title,
    terminalStatus(session),
    session.shell.name,
    session.projectId ?? '-',
    session.currentCwd,
  ]);
  const header = ['ID', 'TITLE', 'STATUS', 'SHELL', 'PROJECT', 'DIRECTORY'];
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]!.length)),
  );
  const render = (row: string[]) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]!)))
      .join('  ');
  return `${[header, ...rows].map(render).join('\n')}\n`;
}

export function formatTerminalDetails(session: TerminalSession): string {
  const lines: [string, string][] = [
    ['ID', session.id],
    ['Title', session.title],
    ['Status', terminalStatus(session)],
    ['Project', session.projectId ?? '- (standalone)'],
    ['Directory', session.cwd],
    [
      'Current dir',
      session.cwdSource === 'detected' ? session.currentCwd : `${session.currentCwd} (initial)`,
    ],
    ['Custom name', session.customTitle ?? '-'],
    ['Group', session.groupId ?? '-'],
    ['Shell', `${session.shell.name} (${session.shell.path})`],
    ['PID', session.pid !== undefined ? String(session.pid) : '-'],
    ['Size', `${session.columns}x${session.rows}`],
    ['Created', session.createdAt],
    ['Started', session.startedAt ?? '-'],
    ['Ended', session.endedAt ?? '-'],
  ];
  if (session.exitCode !== undefined) lines.push(['Exit code', String(session.exitCode)]);
  if (session.signal !== undefined) lines.push(['Signal', String(session.signal)]);
  if (session.failureMessage) lines.push(['Error', session.failureMessage]);
  const width = Math.max(...lines.map(([label]) => label.length));
  return `${lines.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n')}\n`;
}

const UNAVAILABLE_LABELS: Record<Extract<GitStatus, { state: 'unavailable' }>['reason'], string> = {
  'not-installed': 'git is not installed',
  timeout: 'inspection timed out',
  'unsafe-ownership': 'repository owned by another user (not trusted by git)',
  'directory-unavailable': 'directory unavailable',
  error: 'inspection failed',
};

/** Git section appended to `project show`. */
export function formatGitStatus(status: GitStatus): string {
  if (status.state === 'not-repository') return '\nGit: no Git repository\n';
  if (status.state === 'unavailable')
    return `\nGit: unavailable (${UNAVAILABLE_LABELS[status.reason]})\n`;
  const { snapshot } = status;
  const { changes } = snapshot;
  const branch = snapshot.detachedHead
    ? 'detached HEAD'
    : `${snapshot.branch ?? '-'}${snapshot.unbornHead ? ' (no commits yet)' : ''}`;
  const tracking =
    snapshot.upstream === null
      ? 'no upstream'
      : snapshot.upstreamGone
        ? `${snapshot.upstream} (gone)`
        : `${snapshot.upstream}  ↑${snapshot.ahead ?? '?'} ↓${snapshot.behind ?? '?'} (as of last fetch)`;
  const recent =
    snapshot.recentBranches.length === 0
      ? '-'
      : snapshot.recentBranches.map((item) => item.name).join(', ');
  const lines: [string, string][] = [
    ['Repository root', snapshot.repositoryRoot],
    ['Branch', branch],
    ['Upstream', tracking],
    [
      'Identity',
      `${snapshot.identity.name ?? '(not set)'} <${snapshot.identity.email ?? 'not set'}>`,
    ],
    ['Local branches', String(snapshot.localBranchCount)],
    ['Recent branches', `${recent} (by latest commit)`],
    [
      'Changes',
      `${changes.total} files: ${changes.modified} modified, ${changes.staged} staged, ` +
        `${changes.untracked} untracked, ${changes.deleted} deleted, ${changes.renamed} renamed` +
        (changes.conflicted > 0 ? `, ${changes.conflicted} conflicted` : ''),
    ],
    ['Inspected', snapshot.inspectedAt],
  ];
  const width = Math.max(...lines.map(([label]) => label.length));
  return `\nGit\n${lines.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n')}\n`;
}

/** Status labels that never present waiting or interrupted sessions as running or done. */
const SESSION_STATUS_LABELS: Record<AtlasSessionStatus, string> = {
  DRAFT: 'draft',
  READY: 'ready',
  WAITING_EXECUTOR: 'waiting for executor',
  RUNNING: 'running',
  PAUSED: 'paused',
  WAITING_APPROVAL: 'waiting for approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
};

export function sessionStatusLabel(status: AtlasSessionStatus): string {
  return SESSION_STATUS_LABELS[status];
}

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]!.length)),
  );
  const render = (row: string[]) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]!)))
      .join('  ');
  return `${[header, ...rows].map(render).join('\n')}\n`;
}

function workspaceLabel(workspace: SessionWorkspace): string {
  switch (workspace.kind) {
    case 'none':
      return '-';
    case 'project':
      return `${workspace.projectName} (${workspace.path})${workspace.available ? '' : ' — unavailable'}`;
    case 'directory':
      return `${workspace.path}${workspace.available ? '' : ' — unavailable'}`;
  }
}

export function formatSessionList(items: AtlasSessionListItem[]): string {
  if (items.length === 0) {
    return (
      'No sessions. Create one with: atlas session create --name <name> --objective <text>\n' +
      'Archived sessions are listed with --all.\n'
    );
  }
  const rows = items.map(({ session, projectName, taskCounts }) => [
    session.id,
    session.name,
    sessionStatusLabel(session.status) + (session.archivedAt !== null ? ' (archived)' : ''),
    session.executionProfile.toLowerCase(),
    `${taskCounts.completed}/${taskCounts.total}`,
    projectName ?? session.workspacePath ?? '-',
  ]);
  return renderTable(['ID', 'NAME', 'STATUS', 'PROFILE', 'TASKS', 'WORKSPACE'], rows);
}

export function formatSessionDetails(details: AtlasSessionDetails, events: SessionEvent[]): string {
  const { session } = details;
  const lines: [string, string][] = [
    ['ID', session.id],
    ['Name', session.name],
    ['Status', sessionStatusLabel(session.status)],
    ['Executing', details.executing ? 'yes' : 'no'],
    ['Profile', session.executionProfile.toLowerCase()],
    ['Workspace', workspaceLabel(details.workspace)],
    ['Tasks', String(details.tasks.length)],
    ['Pending approvals', String(details.pendingApprovals.length)],
    ['Created', session.createdAt],
    ['Updated', session.updatedAt],
  ];
  if (session.startedAt !== null) lines.push(['Started', session.startedAt]);
  if (session.completedAt !== null) lines.push(['Completed', session.completedAt]);
  if (session.endedAt !== null) lines.push(['Ended', session.endedAt]);
  if (session.archivedAt !== null) lines.push(['Archived', session.archivedAt]);
  lines.push([
    'Actions',
    details.availableActions.length > 0 ? details.availableActions.join(', ') : '-',
  ]);
  const width = Math.max(...lines.map(([label]) => label.length));
  let text = `${lines.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n')}\n`;
  text += `\nObjective\n${indent(session.objective)}\n`;
  if (session.constraints.length > 0) {
    text += `\nConstraints\n${session.constraints.map((item) => `  - ${item}`).join('\n')}\n`;
  }
  if (!details.executorAvailable) {
    text += '\nNo execution adapter is installed: nothing runs for this session yet.\n';
  }
  const recent = events.slice(-10);
  if (recent.length > 0) {
    text += `\nRecent events\n${recent.map((event) => `  ${formatEvent(event)}`).join('\n')}\n`;
  }
  return text;
}

export function formatSessionTasks(tasks: SessionTask[]): string {
  if (tasks.length === 0) return 'No tasks.\n';
  const position = new Map(tasks.map((task, index) => [task.id, String(index + 1)]));
  const rows = tasks.map((task, index) => [
    String(index + 1),
    task.status.toLowerCase().replace('_', ' '),
    task.dependencies.map((id) => `#${position.get(id) ?? '?'}`).join(',') || '-',
    task.blockedBy.length > 0 && task.status === 'PENDING' ? 'blocked' : '',
    task.title,
  ]);
  return renderTable(['#', 'STATUS', 'DEPENDS ON', 'STATE', 'TITLE'], rows);
}

function formatEvent(event: SessionEvent): string {
  const { from, to, reason } = event.metadata;
  const transition =
    from !== undefined && to !== undefined
      ? ` ${sessionStatusLabel(from)} → ${sessionStatusLabel(to)}`
      : '';
  return `${event.occurredAt}  ${event.type}${transition}${reason ? ` (${reason})` : ''}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
