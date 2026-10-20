import type { ProjectDetails, TerminalSession } from '@atlas/contracts';

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
    return 'No terminals. Open one with: atlas terminal open --project <project-id>\n';
  }
  const rows = sessions.map((session) => [
    session.id,
    session.title,
    terminalStatus(session),
    session.shell.name,
    session.projectId,
  ]);
  const header = ['ID', 'TITLE', 'STATUS', 'SHELL', 'PROJECT'];
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
    ['Project', session.projectId],
    ['Directory', session.cwd],
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
