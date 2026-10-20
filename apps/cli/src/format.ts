import type { ProjectDetails } from '@atlas/contracts';

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
