import type { TerminalSession } from '@atlas/contracts';
import { describe, expect, it } from 'vitest';
import {
  latestProjectTerminal,
  moveHighlight,
  projectTerminalReason,
  projectTerminals,
} from '../src/renderer/src/app-bar/state/project-toolbar';
import type { ProjectDetails } from '../src/renderer/src/types';

const project = (status: 'available' | 'missing'): ProjectDetails =>
  ({
    project: { id: 'p', name: 'Atlas' },
    availability: { status, checkedAt: '2026-10-28T00:00:00.000Z' },
    git: { isRepository: false },
    isSelected: true,
  }) as unknown as ProjectDetails;

const session = (
  id: string,
  projectId: string | null,
  createdAt: string,
  status: TerminalSession['status'] = 'RUNNING',
): TerminalSession => ({ id, projectId, createdAt, status }) as unknown as TerminalSession;

describe('upper toolbar project rules (SDD-023 Task A05)', () => {
  it('explains why a terminal cannot open in the selected project', () => {
    expect(projectTerminalReason(null)).toBe('Select a project first.');
    expect(projectTerminalReason(project('missing'))).toBe('The project folder is missing.');
    expect(projectTerminalReason(project('available'))).toBeNull();
  });

  it('lists only the terminals associated with the project', () => {
    const sessions = [
      session('a', 'p', '2026-10-28T10:00:00Z'),
      session('b', 'other', '2026-10-28T11:00:00Z'),
      session('c', null, '2026-10-28T12:00:00Z'),
      session('d', 'p', '2026-10-28T13:00:00Z', 'EXITED'),
    ];
    expect(projectTerminals(sessions, 'p').map((item) => item.id)).toEqual(['a', 'd']);
  });

  it('shows the newest running terminal first, then the newest ended one', () => {
    const running = [
      session('old', 'p', '2026-10-28T10:00:00Z'),
      session('new', 'p', '2026-10-28T11:00:00Z'),
      session('ended', 'p', '2026-10-28T12:00:00Z', 'EXITED'),
    ];
    expect(latestProjectTerminal(running, 'p')?.id).toBe('new');
    const ended = [
      session('a', 'p', '2026-10-28T10:00:00Z', 'EXITED'),
      session('b', 'p', '2026-10-28T11:00:00Z', 'FAILED'),
    ];
    expect(latestProjectTerminal(ended, 'p')?.id).toBe('b');
    expect(latestProjectTerminal(running, 'none')).toBeUndefined();
  });

  it('moves the list highlight with wrap-around', () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(-1, -1, 3)).toBe(2);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(1, 1, 0)).toBe(-1);
  });
});
