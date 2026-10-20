import type { SerializedError } from '@atlas/shared';
import type {
  CreateProjectInput,
  Project,
  ProjectDetails,
  ProjectPathInspection,
  UpdateProjectInput,
} from './project.js';
import type { AppInfo } from './app-info.js';
import type {
  GitBranchList,
  GitCommitContext,
  GitCommitInput,
  GitCommitResult,
  GitCommitSuggestion,
  GitCreateBranchInput,
  GitDiffInput,
  GitFetchInput,
  GitFileDiff,
  GitOperation,
  GitPathsInput,
  GitPreferences,
  GitPullInfo,
  GitPullInput,
  GitPushInput,
  GitRemote,
  GitRenameBranchInput,
  GitRepositoryEntry,
  GitStatus,
  GitSwitchBranchInput,
  GitWorkingTree,
  ProjectGitSettings,
  StoredGitPreferences,
  StoredProjectGitSettings,
  TerminalGitContext,
  TerminalProjectContext,
  UpdateGitPreferences,
} from './git.js';
import type {
  CreateTerminalInput,
  ShellCatalog,
  TerminalGroup,
  TerminalAttachment,
  TerminalCloseInfo,
  TerminalEvent,
  TerminalPreferences,
  TerminalSession,
  UpdateTerminalPreferencesInput,
} from './terminal.js';
import type { TerminalWorkspaceLayout } from './terminal-layout.js';
import type {
  AtlasSession,
  AtlasSessionDetails,
  AtlasSessionListItem,
  CreateSessionInput,
  CreateSessionTaskInput,
  ListSessionsInput,
  SessionAction,
  SessionChangedEvent,
  SessionEvent,
  SessionSettings,
  SessionTask,
  UpdateSessionInput,
  UpdateSessionSettingsInput,
  UpdateSessionTaskInput,
} from './session.js';

export const IPC_CHANNELS = {
  listProjects: 'atlas:projects:list',
  getProject: 'atlas:projects:get',
  createProject: 'atlas:projects:create',
  updateProject: 'atlas:projects:update',
  removeProject: 'atlas:projects:remove',
  selectProject: 'atlas:projects:select',
  getSelectedProject: 'atlas:projects:get-selected',
  chooseDirectory: 'atlas:dialog:choose-directory',

  listTerminals: 'atlas:terminals:list',
  createTerminal: 'atlas:terminals:create',
  renameTerminal: 'atlas:terminals:rename',
  terminateTerminal: 'atlas:terminals:terminate',
  restartTerminal: 'atlas:terminals:restart',
  dismissTerminal: 'atlas:terminals:dismiss',
  terminalCloseInfo: 'atlas:terminals:close-info',
  clearTerminal: 'atlas:terminals:clear',
  attachTerminal: 'atlas:terminals:attach',
  detachTerminal: 'atlas:terminals:detach',
  listShells: 'atlas:terminals:shells',
  getTerminalPreferences: 'atlas:terminals:get-preferences',
  setTerminalPreferences: 'atlas:terminals:set-preferences',
  getTerminalLayout: 'atlas:terminals:get-layout',
  setTerminalLayout: 'atlas:terminals:set-layout',
  associateTerminal: 'atlas:terminals:associate',
  moveTerminal: 'atlas:terminals:move',
  terminalProjectContext: 'atlas:terminals:project-context',
  terminalGit: 'atlas:terminals:git',
  registerTerminalProject: 'atlas:terminals:register-project',

  listGroups: 'atlas:groups:list',
  createGroup: 'atlas:groups:create',
  renameGroup: 'atlas:groups:rename',
  setGroupCollapsed: 'atlas:groups:set-collapsed',
  moveGroup: 'atlas:groups:move',
  deleteGroup: 'atlas:groups:delete',

  projectGit: 'atlas:git:project',
  gitRepositories: 'atlas:git:repositories',
  gitWorkingTree: 'atlas:git:working-tree',
  gitDiff: 'atlas:git:diff',
  gitStage: 'atlas:git:stage',
  gitUnstage: 'atlas:git:unstage',
  gitCommit: 'atlas:git:commit',
  gitPush: 'atlas:git:push',
  gitPull: 'atlas:git:pull',
  gitPullInfo: 'atlas:git:pull-info',
  gitFetch: 'atlas:git:fetch',
  gitBranches: 'atlas:git:branches',
  gitRemotes: 'atlas:git:remotes',
  gitCreateBranch: 'atlas:git:create-branch',
  gitSwitchBranch: 'atlas:git:switch-branch',
  gitRenameBranch: 'atlas:git:rename-branch',
  gitSuggestMessage: 'atlas:git:suggest-message',
  gitOperations: 'atlas:git:operations',
  gitCancelOperation: 'atlas:git:cancel-operation',
  gitGetPreferences: 'atlas:git:get-preferences',
  gitSetPreferences: 'atlas:git:set-preferences',
  gitCommitContext: 'atlas:git:commit-context',
  gitGetProjectSettings: 'atlas:git:get-project-settings',
  gitSetProjectSettings: 'atlas:git:set-project-settings',
  appInfo: 'atlas:app:info',

  listSessions: 'atlas:sessions:list',
  getSession: 'atlas:sessions:get',
  createSession: 'atlas:sessions:create',
  updateSession: 'atlas:sessions:update',
  performSessionAction: 'atlas:sessions:perform',
  sessionEvents: 'atlas:sessions:events',
  addSessionTask: 'atlas:sessions:add-task',
  updateSessionTask: 'atlas:sessions:update-task',
  removeSessionTask: 'atlas:sessions:remove-task',
  cancelSessionTask: 'atlas:sessions:cancel-task',
  getSessionSettings: 'atlas:sessions:get-settings',
  setSessionSettings: 'atlas:sessions:set-settings',
} as const;

/** Fire-and-forget channels used for high-frequency terminal traffic. */
export const IPC_SEND_CHANNELS = {
  writeTerminal: 'atlas:terminals:write',
  resizeTerminal: 'atlas:terminals:resize',
  acknowledgeTerminal: 'atlas:terminals:ack',
} as const;

/** Channels the main process uses to push events to the renderer. */
export const IPC_EVENT_CHANNELS = {
  terminalEvent: 'atlas:terminals:event',
  sessionChanged: 'atlas:sessions:changed',
  appCommand: 'atlas:app:command',
  engineRestarted: 'atlas:engine:restarted',
} as const;

export type { SessionChangedEvent } from './session.js';

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError };

export interface DirectoryChoice {
  canceled: boolean;
  inspection?: ProjectPathInspection;
}

/** Commands triggered from the application menu and its keyboard shortcuts. */
export const APP_COMMANDS = [
  'view.projects',
  'view.terminals',
  'view.sessions',
  'view.git',
  'terminal.new',
  'terminal.close',
  'terminal.next',
  'terminal.previous',
  'terminal.splitRight',
  'terminal.splitDown',
  'terminal.focusNextPane',
  'terminal.focusPreviousPane',
  'terminal.search',
  'terminal.clear',
  'terminal.fontIncrease',
  'terminal.fontDecrease',
  'terminal.fontReset',
  'app.about',
  'app.settings',
] as const;

export type AppCommand = (typeof APP_COMMANDS)[number];

export type Unsubscribe = () => void;

export interface TerminalEventMessage {
  event: TerminalEvent;
  viewId?: string;
}

/** Identifies one terminal view inside the renderer. */
export const TERMINAL_VIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The only API exposed to the renderer through the preload bridge.
 * Paths can only originate from the native directory picker; the main process
 * rejects create/update requests for paths it did not hand out. Terminal
 * working directories are always derived from registered projects.
 */
export interface AtlasApi {
  projects: {
    list(): Promise<IpcResult<ProjectDetails[]>>;
    get(id: string): Promise<IpcResult<ProjectDetails>>;
    create(input: CreateProjectInput): Promise<IpcResult<Project>>;
    update(id: string, input: UpdateProjectInput): Promise<IpcResult<Project>>;
    remove(id: string): Promise<IpcResult<null>>;
    select(id: string): Promise<IpcResult<null>>;
    getSelected(): Promise<IpcResult<ProjectDetails | null>>;
  };
  dialog: {
    /** `purpose` only changes the dialog title. */
    chooseDirectory(
      purpose?: 'project' | 'terminal' | 'default-directory' | 'session',
    ): Promise<IpcResult<DirectoryChoice>>;
  };
  terminals: {
    list(projectId?: string): Promise<IpcResult<TerminalSession[]>>;
    create(input: CreateTerminalInput): Promise<IpcResult<TerminalSession>>;
    /** `null` restores the automatic name. */
    rename(id: string, title: string | null): Promise<IpcResult<TerminalSession>>;
    associate(id: string, projectId: string | null): Promise<IpcResult<TerminalSession>>;
    /** Moves into a group (`null`: ungrouped) at a position; never restarts the process. */
    move(id: string, groupId: string | null, position: number): Promise<IpcResult<TerminalSession>>;
    projectContext(id: string): Promise<IpcResult<TerminalProjectContext>>;
    git(id: string): Promise<IpcResult<TerminalGitContext>>;
    /** Registers the terminal's current directory (known by the Engine) as a project. */
    registerProject(
      id: string,
      input: { name: string; description?: string; tags?: string[] },
    ): Promise<IpcResult<{ project: Project; session: TerminalSession }>>;
    terminate(id: string): Promise<IpcResult<TerminalSession>>;
    restart(id: string): Promise<IpcResult<TerminalSession>>;
    /** Terminates the process if needed and closes the tab. */
    dismiss(id: string): Promise<IpcResult<null>>;
    closeInfo(id: string): Promise<IpcResult<TerminalCloseInfo>>;
    clear(id: string): Promise<IpcResult<null>>;
    /** `viewId` identifies the terminal view (pane) that will receive the output. */
    attach(
      id: string,
      viewId: string,
      columns: number,
      rows: number,
    ): Promise<IpcResult<TerminalAttachment>>;
    detach(id: string, viewId: string): Promise<IpcResult<null>>;
    shells(): Promise<IpcResult<ShellCatalog>>;
    getPreferences(): Promise<IpcResult<TerminalPreferences>>;
    setPreferences(input: UpdateTerminalPreferencesInput): Promise<IpcResult<TerminalPreferences>>;
    /** `workspace` is a group id or `ungrouped`. */
    getLayout(workspace: string): Promise<IpcResult<TerminalWorkspaceLayout | null>>;
    setLayout(workspace: string, layout: TerminalWorkspaceLayout): Promise<IpcResult<null>>;
    write(id: string, data: string): void;
    resize(id: string, columns: number, rows: number): void;
    /** Reports how many output characters the view has rendered (flow control). */
    acknowledge(id: string, viewId: string, characters: number): void;
    /** Output events carry the id of the view they are addressed to. */
    onEvent(listener: (message: TerminalEventMessage) => void): Unsubscribe;
  };
  groups: {
    list(): Promise<IpcResult<TerminalGroup[]>>;
    create(name: string): Promise<IpcResult<TerminalGroup>>;
    rename(id: string, name: string): Promise<IpcResult<TerminalGroup>>;
    setCollapsed(id: string, collapsed: boolean): Promise<IpcResult<TerminalGroup>>;
    move(id: string, position: number): Promise<IpcResult<TerminalGroup[]>>;
    /** Terminals become ungrouped unless `terminateTerminals` is confirmed. */
    delete(id: string, options: { terminateTerminals: boolean }): Promise<IpcResult<null>>;
  };
  git: {
    project(projectId: string): Promise<IpcResult<GitStatus>>;
    /** Repositories of registered projects and open terminals. */
    repositories(): Promise<IpcResult<GitRepositoryEntry[]>>;
    workingTree(repositoryRoot: string): Promise<IpcResult<GitWorkingTree>>;
    diff(input: GitDiffInput): Promise<IpcResult<GitFileDiff>>;
    stage(input: GitPathsInput): Promise<IpcResult<GitOperation>>;
    unstage(input: GitPathsInput): Promise<IpcResult<GitOperation>>;
    /** Commits the staged content after applying the explicit selection; never bypasses hooks. */
    commit(input: GitCommitInput): Promise<IpcResult<GitCommitResult>>;
    push(input: GitPushInput): Promise<IpcResult<GitOperation>>;
    pull(input: GitPullInput): Promise<IpcResult<GitOperation>>;
    pullInfo(repositoryRoot: string): Promise<IpcResult<GitPullInfo>>;
    fetch(input: GitFetchInput): Promise<IpcResult<GitOperation>>;
    branches(repositoryRoot: string): Promise<IpcResult<GitBranchList>>;
    remotes(repositoryRoot: string): Promise<IpcResult<GitRemote[]>>;
    createBranch(input: GitCreateBranchInput): Promise<IpcResult<GitOperation>>;
    switchBranch(input: GitSwitchBranchInput): Promise<IpcResult<GitOperation>>;
    renameBranch(input: GitRenameBranchInput): Promise<IpcResult<GitOperation>>;
    suggestMessage(input: GitPathsInput): Promise<IpcResult<GitCommitSuggestion | null>>;
    operations(): Promise<IpcResult<GitOperation[]>>;
    cancelOperation(id: string): Promise<IpcResult<GitOperation>>;
    getPreferences(): Promise<IpcResult<StoredGitPreferences>>;
    setPreferences(input: UpdateGitPreferences): Promise<IpcResult<GitPreferences>>;
    /** Projects of a repository and the commit settings each applies. */
    commitContext(repositoryRoot: string): Promise<IpcResult<GitCommitContext>>;
    getProjectSettings(projectId: string): Promise<IpcResult<StoredProjectGitSettings>>;
    /** Pre-commit steps are commands run by the Engine before each commit from ATLAS. */
    setProjectSettings(
      projectId: string,
      settings: ProjectGitSettings,
    ): Promise<IpcResult<ProjectGitSettings>>;
  };
  sessions: {
    list(filter?: ListSessionsInput): Promise<IpcResult<AtlasSessionListItem[]>>;
    get(id: string): Promise<IpcResult<AtlasSessionDetails>>;
    /** `workspacePath` must come from the directory picker. */
    create(input: CreateSessionInput): Promise<IpcResult<AtlasSession>>;
    update(id: string, input: UpdateSessionInput): Promise<IpcResult<AtlasSession>>;
    perform(id: string, action: SessionAction): Promise<IpcResult<AtlasSession>>;
    events(id: string): Promise<IpcResult<SessionEvent[]>>;
    addTask(id: string, input: CreateSessionTaskInput): Promise<IpcResult<SessionTask>>;
    updateTask(
      id: string,
      taskId: string,
      input: UpdateSessionTaskInput,
    ): Promise<IpcResult<SessionTask>>;
    removeTask(id: string, taskId: string): Promise<IpcResult<null>>;
    cancelTask(id: string, taskId: string): Promise<IpcResult<SessionTask>>;
    getSettings(): Promise<IpcResult<SessionSettings>>;
    setSettings(input: UpdateSessionSettingsInput): Promise<IpcResult<SessionSettings>>;
    /** A session, its tasks or its history changed (in any client). */
    onChanged(listener: (event: SessionChangedEvent) => void): Unsubscribe;
  };
  app: {
    info(): Promise<IpcResult<AppInfo>>;
    onCommand(listener: (command: AppCommand) => void): Unsubscribe;
    /** The Engine process restarted; terminal state must be reloaded. */
    onEngineRestarted(listener: () => void): Unsubscribe;
  };
}
