import { describe, expect, it } from 'vitest';
import { quitWarning } from '../src/main/quit-warning';

const none = { gitOperations: 0, preflightRuns: 0 };

describe('quitWarning', () => {
  it('asks nothing when nothing runs', () => {
    expect(quitWarning(0, none, 'A.T.L.A.S')).toBeNull();
  });

  it('names what stops, with what quitting does to each', () => {
    expect(quitWarning(2, none, 'A.T.L.A.S')).toEqual({
      message: '2 terminals are still running.',
      detail:
        'Quitting A.T.L.A.S stops them. Every terminal process stops, including development servers.',
    });
    expect(quitWarning(0, { gitOperations: 1, preflightRuns: 0 }, 'A.T.L.A.S')).toEqual({
      message: '1 Git operation is still running.',
      detail:
        'Quitting A.T.L.A.S stops them. Running Git operations stop; a commit whose checks are still running is not created.',
    });
    expect(quitWarning(1, { gitOperations: 2, preflightRuns: 1 }, 'A.T.L.A.S')?.message).toBe(
      '1 terminal, 2 Git operations and 1 Preflight run are still running.',
    );
  });

  it('warns about unsaved editor changes (SDD-011)', () => {
    expect(quitWarning(0, none, 'A.T.L.A.S', 1)).toEqual({
      message: '1 file has unsaved changes.',
      detail: 'Quitting A.T.L.A.S discards the changes not saved in the editor.',
    });
    expect(quitWarning(1, none, 'A.T.L.A.S', 3)).toEqual({
      message: '1 terminal is still running. 3 files have unsaved changes.',
      detail:
        'Quitting A.T.L.A.S stops them. Every terminal process stops, including development servers. Changes not saved in the editor are discarded.',
    });
  });
});
