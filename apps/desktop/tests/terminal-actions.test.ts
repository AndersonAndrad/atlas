import { describe, expect, it } from 'vitest';
import {
  ACTION_REASONS,
  terminalActionAvailability,
  type TerminalActionContext,
} from '../src/renderer/src/terminal/state/terminal-actions';

const context = (overrides: Partial<TerminalActionContext> = {}): TerminalActionContext => ({
  running: true,
  repository: true,
  gitBusy: false,
  fetching: false,
  projectId: 'p',
  projectAvailable: true,
  canSplit: true,
  manageable: true,
  ...overrides,
});

describe('terminalActionAvailability (SDD-023 Task A04)', () => {
  it('enables everything for a running terminal of a Git project, except Restart', () => {
    const actions = terminalActionAvailability(context());
    const disabled = Object.entries(actions).filter(([, reason]) => reason !== null);
    expect(disabled).toEqual([['restart', ACTION_REASONS.restartRunning]]);
  });

  it('disables Git actions outside a repository, and all of them in an ended terminal', () => {
    const noGit = terminalActionAvailability(context({ repository: false }));
    expect([noGit.branch, noGit.push, noGit.status, noGit.fetch]).toEqual(
      Array(4).fill(ACTION_REASONS.noRepository),
    );
    expect(noGit.editor).toBeNull();
    const ended = terminalActionAvailability(context({ running: false }));
    expect(ended.pull).toBe(ACTION_REASONS.ended);
    expect(ended.restart).toBeNull();
  });

  it('blocks changes while another Git operation runs, and fetch while fetching', () => {
    const busy = terminalActionAvailability(context({ gitBusy: true }));
    expect([busy.branch, busy.pull, busy.push, busy.commit]).toEqual(
      Array(4).fill(ACTION_REASONS.gitBusy),
    );
    expect(busy.fetch).toBeNull();
    expect(busy.status).toBeNull();
    expect(terminalActionAvailability(context({ fetching: true })).fetch).toBe(
      ACTION_REASONS.fetching,
    );
  });

  it('explains project actions without a project or with a missing folder', () => {
    const none = terminalActionAvailability(context({ projectId: null }));
    expect([none.editor, none.tasks, none.refresh]).toEqual(
      Array(3).fill(ACTION_REASONS.noProject),
    );
    expect(none['project-details']).toBeNull();
    const missing = terminalActionAvailability(context({ projectAvailable: false }));
    expect(missing.editor).toBe(ACTION_REASONS.projectMissing);
    expect(missing.tasks).toBeNull();
  });

  it('disables splitting when the workspace is full', () => {
    const full = terminalActionAvailability(context({ canSplit: false }));
    expect(full['split-right']).toBe(ACTION_REASONS.noRoom);
    expect(full.duplicate).toBeNull();
  });

  it('leaves tab and pane actions to the Terminals view in the editor panel', () => {
    const editor = terminalActionAvailability(context({ manageable: false }));
    expect([editor.rename, editor['split-right'], editor.duplicate]).toEqual(
      Array(3).fill(ACTION_REASONS.terminalsView),
    );
    expect(editor.close).toBeNull();
  });
});
