import type { QuickCommand } from '@atlas/contracts';

interface NamedProject {
  project: { id: string; name: string; workspacePath: string };
}

/**
 * Names to show for projects; projects sharing a name also show their folder, so two
 * "api" projects can be told apart (SDD-025 Task 03, FR-008).
 */
export function projectLabels(projects: readonly NamedProject[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const { project } of projects) {
    const key = project.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map(
    projects.map(({ project }) => [
      project.id,
      (counts.get(project.name.toLowerCase()) ?? 0) > 1
        ? `${project.name} (${project.workspacePath})`
        : project.name,
    ]),
  );
}

/** Short description of where a command is available. */
export function scopeSummary(
  command: QuickCommand,
  labels: ReadonlyMap<string, string>,
): { label: string; detail: string | null; unassigned: boolean } {
  if (command.scope === 'ALL') return { label: 'All projects', detail: null, unassigned: false };
  if (command.projectIds.length === 0) {
    return {
      label: 'No project',
      detail: 'Its projects were removed. Choose projects, or clear them to use it everywhere.',
      unassigned: true,
    };
  }
  const names = command.projectIds.map((id) => labels.get(id) ?? 'Unknown project');
  return {
    label: `${names.length} project${names.length === 1 ? '' : 's'}`,
    detail: names.join(', '),
    unassigned: false,
  };
}
