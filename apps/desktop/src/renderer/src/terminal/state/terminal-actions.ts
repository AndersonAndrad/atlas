// Availability of the terminal Actions menu (SDD-023 Task A04). Pure, so every state is
// testable: an action is enabled (null) or disabled with the reason shown under it.

export const TERMINAL_ACTIONS = [
  'branch',
  'status',
  'fetch',
  'pull',
  'push',
  'commit',
  'operations',
  'project-details',
  'editor',
  'tasks',
  'refresh',
  'rename',
  'split-right',
  'split-down',
  'duplicate',
  'clear',
  'restart',
  'close',
] as const;
export type TerminalActionId = (typeof TERMINAL_ACTIONS)[number];

export interface TerminalActionContext {
  /** The terminal's process is running. */
  running: boolean;
  /** The terminal's directory is in a Git repository (known only while it runs). */
  repository: boolean;
  /** A push, pull, commit or other change runs in that repository. */
  gitBusy: boolean;
  fetching: boolean;
  projectId: string | null;
  /** The project's folder can be reached. */
  projectAvailable: boolean;
  /** The workspace has room for another pane. */
  canSplit: boolean;
  /**
   * Shown in the Terminals view, which manages tabs and panes; false in the editor's
   * terminal panel.
   */
  manageable: boolean;
}

export const ACTION_REASONS = {
  ended: 'The terminal ended. Restart it to use Git here.',
  noRepository: 'Not a Git repository.',
  gitBusy: 'Another Git operation is running in this repository.',
  fetching: 'Fetching…',
  noProject: 'This terminal is not in a registered project.',
  projectMissing: 'The project folder is missing.',
  noRoom: 'There is no room for another pane.',
  restartRunning: 'Restart is available after the process ends.',
  terminalsView: 'Available in the Terminals view.',
} as const;

export function terminalActionAvailability(
  context: TerminalActionContext,
): Record<TerminalActionId, string | null> {
  const git = !context.running
    ? ACTION_REASONS.ended
    : !context.repository
      ? ACTION_REASONS.noRepository
      : null;
  const changing = git ?? (context.gitBusy ? ACTION_REASONS.gitBusy : null);
  const project = context.projectId === null ? ACTION_REASONS.noProject : null;
  const projectFolder =
    project ?? (context.projectAvailable ? null : ACTION_REASONS.projectMissing);
  return {
    branch: changing,
    status: git,
    fetch: git ?? (context.fetching ? ACTION_REASONS.fetching : null),
    pull: changing,
    push: changing,
    commit: changing,
    operations: git,
    // Without a project it offers to register the folder: always available.
    'project-details': null,
    editor: projectFolder,
    tasks: project,
    refresh: projectFolder,
    rename: context.manageable ? null : ACTION_REASONS.terminalsView,
    'split-right': !context.manageable
      ? ACTION_REASONS.terminalsView
      : context.canSplit
        ? null
        : ACTION_REASONS.noRoom,
    'split-down': !context.manageable
      ? ACTION_REASONS.terminalsView
      : context.canSplit
        ? null
        : ACTION_REASONS.noRoom,
    duplicate: context.manageable ? null : ACTION_REASONS.terminalsView,
    clear: null,
    restart: context.running ? ACTION_REASONS.restartRunning : null,
    close: null,
  };
}
