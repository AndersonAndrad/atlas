import { isFinalTerminalStatus, type TerminalSession } from '@atlas/contracts';
import type { ProjectDetails } from '../../types';

/**
 * Why a terminal cannot be opened in the selected project, or null when it can
 * (SDD-023 Task A05). Shown under the disabled actions of the upper toolbar.
 */
export function projectTerminalReason(project: ProjectDetails | null): string | null {
  if (project === null) return 'Select a project first.';
  if (project.availability.status !== 'available') return 'The project folder is missing.';
  return null;
}

/** Terminals associated with a project, any status. */
export function projectTerminals(
  sessions: readonly TerminalSession[],
  projectId: string,
): TerminalSession[] {
  return sessions.filter((session) => session.projectId === projectId);
}

/**
 * The terminal "Show terminals" brings forward: the newest one still running, otherwise the
 * newest one. Undefined when the project has no open terminal.
 */
export function latestProjectTerminal(
  sessions: readonly TerminalSession[],
  projectId: string,
): TerminalSession | undefined {
  const newestFirst = projectTerminals(sessions, projectId).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return newestFirst.find((session) => !isFinalTerminalStatus(session.status)) ?? newestFirst[0];
}

/** Moves a list highlight by `delta`, wrapping around; -1 when the list is empty. */
export function moveHighlight(index: number, delta: number, length: number): number {
  if (length === 0) return -1;
  if (index < 0) return delta < 0 ? length - 1 : 0;
  return (((index + delta) % length) + length) % length;
}
