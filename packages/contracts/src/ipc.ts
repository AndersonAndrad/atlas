import type { SerializedError } from '@atlas/shared';
import type {
  CreateProjectInput,
  Project,
  ProjectDetails,
  ProjectPathInspection,
  UpdateProjectInput,
} from './project.js';
import type { AppInfo } from './app-info.js';
// Dependency-free: the main process and preload read the display name from this subpath.
export { APP_DISPLAY_NAME } from './app-info.js';
import type {
  ProjectAction,
  ProjectQuickCommandSettings,
  QuickCommand,
  QuickCommandInput,
  QuickCommandMove,
  RunQuickCommandInput,
} from './quick-commands.js';
import type {
  AddSkillSourceInput,
  CreateSkillFromTemplateInput,
  DiscoveredSkill,
  EditSkillInput,
  ImportSkillCollectionInput,
  ImportSkillInput,
  RemoveSkillAssignmentInput,
  ResolveSkillsInput,
  ResolvedSkill,
  Skill,
  SkillAssignmentInput,
  SkillCollectionPreview,
  SkillCollectionResult,
  SkillDetails,
  SkillDiff,
  SkillFileContent,
  SkillImportPreview,
  SkillSource,
  SkillSourceSuggestion,
  SkillSyncBatch,
  SkillSyncPlan,
  SkillSyncResult,
  SkillSyncTargets,
  SkillTemplate,
  UpdateSkillSyncTargets,
} from './skills.js';
import type {
  AddUsageProfileInput,
  TerminalLlmUsage,
  UpdateUsageProfileInput,
  UpdateUsageSettingsInput,
  UsageOverview,
  UsageOverviewQuery,
  UsageProfile,
  UsageSettings,
} from './usage.js';
import type {
  PreflightConfig,
  PreflightDiscovery,
  PreflightEnvironmentStatus,
  PreflightOutputPage,
  PreflightOutputQuery,
  PreflightPlan,
  PreflightRun,
  PreflightRunSummary,
  PreflightRunsQuery,
  PreflightSelection,
  PreflightStartInput,
  PreflightWorkspace,
  PreflightWorkspaceDetails,
} from './preflight.js';
import type { NotificationList, NotificationListQuery } from './notification.js';
import type {
  CheckNoteLinksInput,
  CreateNoteInput,
  NoteLinkStatus,
  NoteList,
  NoteListQuery,
  ProjectNote,
  RevealNoteFileInput,
  UpdateNoteInput,
} from './notes.js';
import type {
  BackgroundJob,
  CreateJobInput,
  JobDetails,
  JobListQuery,
  JobOutputPage,
  JobOutputQuery,
  JobPage,
  JobSettings,
  JobSummary,
  UpdateJobSettingsInput,
} from './jobs.js';
import type {
  ContainerLifecycleInput,
  ContainerRef,
  CreateContainerInput,
  DockerContainerDetails,
  DockerContainerStats,
  DockerContainerSummary,
  DockerContextList,
  DockerContextRef,
  DockerStatus,
  OpenContainerLogsInput,
  OpenContainerTerminalInput,
  ReadContainerLogsInput,
  RenameContainerInput,
  SelectDockerContextInput,
} from './docker.js';
import type {
  CreateHttpCollectionInput,
  CreateHttpFolderInput,
  HttpBodyPage,
  HttpCollection,
  HttpCookie,
  HttpExecutionResult,
  HttpFileRef,
  HttpFolder,
  HttpHistoryPage,
  HttpHistoryQuery,
  HttpSavedRequest,
  HttpSnapshot,
  HttpSnapshotListInput,
  HttpSnapshotSummary,
  ListHttpCollectionsInput,
  MoveHttpItemInput,
  ReadHttpBodyInput,
  RenameHttpItemInput,
  SaveHttpRequestInput,
  SaveHttpSnapshotInput,
  SendHttpRequestInput,
  UpdateHttpCollectionInput,
} from './http.js';
import type {
  CreateEntryInput,
  DirectoryListing,
  EditorLayout,
  EditorPreferences,
  FileContent,
  FileRef,
  FileVersionInfo,
  FileVersionsInput,
  FindFilesInput,
  FoundFiles,
  ListDirectoryInput,
  MoveEntryInput,
  UpdateEditorPreferencesInput,
  WatchFilesInput,
  WriteFileInput,
  WrittenFile,
} from './files.js';
import type {
  ContributionsQuery,
  ExtensionContributions,
  ExtensionDetailsInput,
  ExtensionDiagnostic,
  ExtensionSearchInput,
  ExtensionSearchResult,
  ExtensionUpdateCheck,
  GrammarRef,
  GrammarSource,
  IconRef,
  InstallExtensionInput,
  InstalledExtension,
  LanguageConfigurationRef,
  ListExtensionsInput,
  RegistryExtensionDetails,
  ReportExtensionProblemInput,
  ResolvedColorTheme,
  ResolvedIconTheme,
  ResolvedSnippets,
  SetExtensionEnabledInput,
  SnippetsRef,
} from './extensions.js';

import type {
  AiProvider,
  AiSession,
  AttachTerminalInput,
  ContextBudgetSettings,
  ContextBundle,
  ContextBundleRequest,
  ContextEntry,
  ContextHandoff,
  ContextHandoffDraft,
  ContextHealthReport,
  ContextOverview,
  ContextQuery,
  ContextRevision,
  ContextSnapshot,
  ContextTarget,
  ContextTask,
  CreateContextEntryInput,
  CreateContextTaskInput,
  CreateDecisionInput,
  CreateHandoffInput,
  DecisionRecord,
  ProjectConfigView,
  SessionEvidence,
  SessionSummaryInput,
  StartAiSessionInput,
  StartedAiSession,
  UpdateContextBudgetSettings,
  UpdateContextEntryInput,
  UpdateContextTaskInput,
  UpdateProjectAiConfig,
} from './context.js';
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
  GitCherryPickInput,
  GitCherryPickPreview,
  GitMergeInput,
  GitMergePreview,
  GitOperation,
  GitOperationLogDetails,
  GitOperationLogPage,
  GitOperationLogQuery,
  GitOperationLogSettings,
  GitPathsInput,
  GitReflogEntry,
  GitReflogInput,
  GitCommitFiles,
  GitCommitFilesInput,
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
  PendingCommitsPage,
  ProjectGitRefreshResult,
  ProjectGitSettings,
  ProjectGitState,
  StoredGitPreferences,
  StoredProjectGitSettings,
  TerminalGitContext,
  TerminalProjectContext,
  UpdateGitOperationLogSettings,
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
  terminalLlmUsage: 'atlas:terminals:llm-usage',
  registerTerminalProject: 'atlas:terminals:register-project',

  listGroups: 'atlas:groups:list',
  createGroup: 'atlas:groups:create',
  renameGroup: 'atlas:groups:rename',
  setGroupCollapsed: 'atlas:groups:set-collapsed',
  moveGroup: 'atlas:groups:move',
  deleteGroup: 'atlas:groups:delete',

  projectGit: 'atlas:git:project',
  projectGitStates: 'atlas:git:project-states',
  refreshProjectGit: 'atlas:git:refresh-project',
  pendingCommits: 'atlas:git:pending-commits',
  setProjectGitMonitoring: 'atlas:git:set-project-monitoring',
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
  gitOperationLog: 'atlas:git:operation-log',
  gitOperationDetails: 'atlas:git:operation-details',
  gitReflog: 'atlas:git:reflog',
  gitCommitFiles: 'atlas:git:commit-files',
  gitLogSettings: 'atlas:git:log-settings',
  gitSetLogSettings: 'atlas:git:set-log-settings',
  gitGetPreferences: 'atlas:git:get-preferences',
  gitSetPreferences: 'atlas:git:set-preferences',
  gitCommitContext: 'atlas:git:commit-context',
  gitMergePreview: 'atlas:git:merge-preview',
  gitMerge: 'atlas:git:merge',
  gitAbortMerge: 'atlas:git:abort-merge',
  gitCherryPickPreview: 'atlas:git:cherry-pick-preview',
  gitCherryPick: 'atlas:git:cherry-pick',
  gitContinueCherryPick: 'atlas:git:continue-cherry-pick',
  gitSkipCherryPick: 'atlas:git:skip-cherry-pick',
  gitAbortCherryPick: 'atlas:git:abort-cherry-pick',
  gitGetProjectSettings: 'atlas:git:get-project-settings',
  gitSetProjectSettings: 'atlas:git:set-project-settings',
  appInfo: 'atlas:app:info',
  copyText: 'atlas:app:copy-text',
  saveText: 'atlas:app:save-text',
  readText: 'atlas:app:read-text',
  contextOverview: 'atlas:context:overview',
  contextList: 'atlas:context:list',
  contextGlobal: 'atlas:context:global',
  contextRecord: 'atlas:context:record',
  contextUpdate: 'atlas:context:update',
  contextRemove: 'atlas:context:remove',
  contextHistory: 'atlas:context:history',
  contextTasks: 'atlas:context:tasks',
  contextCreateTask: 'atlas:context:create-task',
  contextUpdateTask: 'atlas:context:update-task',
  contextDeleteTask: 'atlas:context:delete-task',
  contextDecisions: 'atlas:context:decisions',
  contextCreateDecision: 'atlas:context:create-decision',
  contextSetDecisionStatus: 'atlas:context:set-decision-status',
  contextBundle: 'atlas:context:bundle',
  contextSnapshot: 'atlas:context:snapshot',
  contextHealth: 'atlas:context:health',
  contextReconcile: 'atlas:context:reconcile',
  contextBudgets: 'atlas:context:budgets',
  contextSetBudgets: 'atlas:context:set-budgets',
  contextPrepareHandoff: 'atlas:context:prepare-handoff',
  contextCreateHandoff: 'atlas:context:create-handoff',
  contextHandoffs: 'atlas:context:handoffs',
  contextHandoff: 'atlas:context:handoff',
  contextSessions: 'atlas:context:sessions',
  contextSessionEvidence: 'atlas:context:session-evidence',
  contextEndSession: 'atlas:context:end-session',
  contextSessionForTerminal: 'atlas:context:session-for-terminal',
  contextProjectConfig: 'atlas:context:project-config',
  contextSetProjectConfig: 'atlas:context:set-project-config',
  skillsList: 'atlas:skills:list',
  skillsDetails: 'atlas:skills:details',
  skillsSuggestions: 'atlas:skills:suggestions',
  skillsSources: 'atlas:skills:sources',
  skillsAddSource: 'atlas:skills:add-source',
  skillsSetSourceEnabled: 'atlas:skills:set-source-enabled',
  skillsRemoveSource: 'atlas:skills:remove-source',
  skillsDiscover: 'atlas:skills:discover',
  skillsInspect: 'atlas:skills:inspect',
  skillsImport: 'atlas:skills:import',
  skillsInspectCollection: 'atlas:skills:inspect-collection',
  skillsImportCollection: 'atlas:skills:import-collection',
  skillsTemplates: 'atlas:skills:templates',
  skillsCreateFromTemplate: 'atlas:skills:create-from-template',
  skillsEdit: 'atlas:skills:edit',
  skillsReadFile: 'atlas:skills:read-file',
  skillsDiff: 'atlas:skills:diff',
  skillsValidate: 'atlas:skills:validate',
  skillsSetEnabled: 'atlas:skills:set-enabled',
  skillsAssign: 'atlas:skills:assign',
  skillsUnassign: 'atlas:skills:unassign',
  skillsRemove: 'atlas:skills:remove',
  skillsResolve: 'atlas:skills:resolve',
  skillsSyncTargets: 'atlas:skills:sync-targets',
  skillsSetSyncTargets: 'atlas:skills:set-sync-targets',
  skillsSyncPreview: 'atlas:skills:sync-preview',
  skillsSyncApply: 'atlas:skills:sync-apply',
  skillsSyncHistory: 'atlas:skills:sync-history',
  skillsSyncRollback: 'atlas:skills:sync-rollback',
  usageOverview: 'atlas:usage:overview',
  usageRefresh: 'atlas:usage:refresh',
  usageAddProfile: 'atlas:usage:add-profile',
  usageUpdateProfile: 'atlas:usage:update-profile',
  usageRemoveProfile: 'atlas:usage:remove-profile',
  usageSetSettings: 'atlas:usage:set-settings',
  preflightWorkspaces: 'atlas:preflight:workspaces',
  preflightOpenProject: 'atlas:preflight:open-project',
  preflightAddFolder: 'atlas:preflight:add-folder',
  preflightRemoveWorkspace: 'atlas:preflight:remove-workspace',
  preflightWorkspace: 'atlas:preflight:workspace',
  preflightSaveConfig: 'atlas:preflight:save-config',
  preflightDiscover: 'atlas:preflight:discover',
  preflightEnvironment: 'atlas:preflight:environment',
  preflightPlan: 'atlas:preflight:plan',
  preflightStart: 'atlas:preflight:start',
  preflightCancel: 'atlas:preflight:cancel',
  preflightRuns: 'atlas:preflight:runs',
  preflightRun: 'atlas:preflight:run',
  preflightOutput: 'atlas:preflight:output',
  preflightReport: 'atlas:preflight:report',
  notificationsList: 'atlas:notifications:list',
  notificationsMarkRead: 'atlas:notifications:mark-read',
  notificationsMarkAllRead: 'atlas:notifications:mark-all-read',
  notificationsRemove: 'atlas:notifications:remove',
  notificationsClear: 'atlas:notifications:clear',
  jobsCreate: 'atlas:jobs:create',
  jobsList: 'atlas:jobs:list',
  jobsGet: 'atlas:jobs:get',
  jobsCancel: 'atlas:jobs:cancel',
  jobsRetry: 'atlas:jobs:retry',
  jobsOutput: 'atlas:jobs:output',
  jobsSummary: 'atlas:jobs:summary',
  jobsGetSettings: 'atlas:jobs:get-settings',
  jobsSetSettings: 'atlas:jobs:set-settings',
  dockerStatus: 'atlas:docker:status',
  dockerContexts: 'atlas:docker:contexts',
  dockerSelectContext: 'atlas:docker:select-context',
  dockerContainers: 'atlas:docker:containers',
  dockerContainer: 'atlas:docker:container',
  dockerLifecycle: 'atlas:docker:lifecycle',
  dockerRename: 'atlas:docker:rename',
  dockerRemove: 'atlas:docker:remove',
  dockerCreate: 'atlas:docker:create',
  dockerStats: 'atlas:docker:stats',
  dockerWatch: 'atlas:docker:watch',
  dockerLogsOpen: 'atlas:docker:logs-open',
  dockerLogsRead: 'atlas:docker:logs-read',
  dockerLogsClose: 'atlas:docker:logs-close',
  dockerOpenTerminal: 'atlas:docker:open-terminal',
  httpCollections: 'atlas:http:collections',
  httpCreateCollection: 'atlas:http:create-collection',
  httpUpdateCollection: 'atlas:http:update-collection',
  httpDuplicateCollection: 'atlas:http:duplicate-collection',
  httpDeleteCollection: 'atlas:http:delete-collection',
  httpCreateFolder: 'atlas:http:create-folder',
  httpRenameFolder: 'atlas:http:rename-folder',
  httpDeleteFolder: 'atlas:http:delete-folder',
  httpRequest: 'atlas:http:request',
  httpSaveRequest: 'atlas:http:save-request',
  httpDuplicateRequest: 'atlas:http:duplicate-request',
  httpDeleteRequest: 'atlas:http:delete-request',
  httpMove: 'atlas:http:move',
  httpSend: 'atlas:http:send',
  httpCancel: 'atlas:http:cancel',
  httpReadBody: 'atlas:http:read-body',
  httpSaveResponse: 'atlas:http:save-response',
  httpRelease: 'atlas:http:release',
  httpChooseFile: 'atlas:http:choose-file',
  httpCookies: 'atlas:http:cookies',
  httpClearCookies: 'atlas:http:clear-cookies',
  httpHistory: 'atlas:http:history',
  httpClearHistory: 'atlas:http:clear-history',
  httpRecentUrls: 'atlas:http:recent-urls',
  httpSaveSnapshot: 'atlas:http:save-snapshot',
  httpSnapshots: 'atlas:http:snapshots',
  httpSnapshot: 'atlas:http:snapshot',
  httpDeleteSnapshot: 'atlas:http:delete-snapshot',
  notesList: 'atlas:notes:list',
  notesGet: 'atlas:notes:get',
  notesCreate: 'atlas:notes:create',
  notesUpdate: 'atlas:notes:update',
  notesRemove: 'atlas:notes:remove',
  notesCheckLinks: 'atlas:notes:check-links',
  notesRevealFile: 'atlas:notes:reveal-file',
  notesOpenExternal: 'atlas:notes:open-external',
  filesList: 'atlas:files:list',
  filesRead: 'atlas:files:read',
  filesWrite: 'atlas:files:write',
  filesCreate: 'atlas:files:create',
  filesMove: 'atlas:files:move',
  filesTrash: 'atlas:files:trash',
  filesReveal: 'atlas:files:reveal',
  filesVersions: 'atlas:files:versions',
  filesFind: 'atlas:files:find',
  filesWatch: 'atlas:files:watch',
  editorGetPreferences: 'atlas:editor:get-preferences',
  editorSetPreferences: 'atlas:editor:set-preferences',
  editorGetLayout: 'atlas:editor:get-layout',
  editorSetLayout: 'atlas:editor:set-layout',
  editorGetLastProject: 'atlas:editor:get-last-project',
  editorSetLastProject: 'atlas:editor:set-last-project',
  extensionsSearch: 'atlas:extensions:search',
  extensionsDetails: 'atlas:extensions:details',
  extensionsList: 'atlas:extensions:list',
  extensionsInstall: 'atlas:extensions:install',
  extensionsUninstall: 'atlas:extensions:uninstall',
  extensionsSetEnabled: 'atlas:extensions:set-enabled',
  extensionsCheckUpdates: 'atlas:extensions:check-updates',
  extensionsContributions: 'atlas:extensions:contributions',
  extensionsGrammar: 'atlas:extensions:grammar',
  extensionsTheme: 'atlas:extensions:theme',
  extensionsSnippets: 'atlas:extensions:snippets',
  extensionsLanguageConfiguration: 'atlas:extensions:language-configuration',
  extensionsIconTheme: 'atlas:extensions:icon-theme',
  extensionsIcon: 'atlas:extensions:icon',
  extensionsDiagnostics: 'atlas:extensions:diagnostics',
  extensionsClearDiagnostics: 'atlas:extensions:clear-diagnostics',
  extensionsReportProblem: 'atlas:extensions:report-problem',
  extensionsOpenLink: 'atlas:extensions:open-link',
  appSetTerminalShortcuts: 'atlas:app:set-terminal-shortcuts',
  appSetUnsavedFiles: 'atlas:app:set-unsaved-files',
  aiStart: 'atlas:ai:start',
  quickCommandsList: 'atlas:quick-commands:list',
  quickCommandsCreate: 'atlas:quick-commands:create',
  quickCommandsUpdate: 'atlas:quick-commands:update',
  quickCommandsRemove: 'atlas:quick-commands:remove',
  quickCommandsMove: 'atlas:quick-commands:move',
  quickCommandsProjectSettings: 'atlas:quick-commands:project-settings',
  quickCommandsSetProjectSettings: 'atlas:quick-commands:set-project-settings',
  quickCommandsRun: 'atlas:quick-commands:run',
  projectsActions: 'atlas:projects:actions',
  aiAttach: 'atlas:ai:attach',

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

/**
 * System clipboard to use. `selection` is the X11/Wayland primary selection
 * (select to copy, middle-click to paste); it only exists on Linux.
 */
export const CLIPBOARD_TARGETS = ['clipboard', 'selection'] as const;
export type ClipboardTarget = (typeof CLIPBOARD_TARGETS)[number];

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
  files: {
    /** Absolute path of a file dropped into the window ('' when it has none). */
    pathFor(file: File): string;
  };
  dialog: {
    /** `purpose` only changes the dialog title. */
    chooseDirectory(
      purpose?:
        | 'project'
        | 'terminal'
        | 'default-directory'
        | 'session'
        | 'skill'
        | 'usage-profile'
        | 'preflight-workspace',
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
    /** The LLM open in the terminal and its session window; null when none is open. */
    llmUsage(id: string): Promise<IpcResult<TerminalLlmUsage | null>>;
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
    /** Stored Git state of every project; never runs Git (SDD-024). */
    projectStates(): Promise<IpcResult<ProjectGitState[]>>;
    /** Reads a project's Git status now, even when monitoring is off. */
    refreshProject(projectId: string): Promise<IpcResult<ProjectGitRefreshResult>>;
    setProjectMonitoring(projectId: string, enabled: boolean): Promise<IpcResult<ProjectGitState>>;
    /** Reads further pending commits live ("Load more"). */
    pendingCommits(projectId: string, skip: number): Promise<IpcResult<PendingCommitsPage>>;
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
    /** Operations ATLAS ran, kept across restarts (newest first). */
    operationLog(query: GitOperationLogQuery): Promise<IpcResult<GitOperationLogPage>>;
    /** A logged operation with every Git command it ran. */
    operationDetails(id: string): Promise<IpcResult<GitOperationLogDetails>>;
    /** HEAD reflog: changes made by any tool, including `git` typed in a terminal. */
    reflog(input: GitReflogInput): Promise<IpcResult<GitReflogEntry[]>>;
    /** Files a commit changed (compared with its first parent); null if it no longer exists. */
    commitFiles(input: GitCommitFilesInput): Promise<IpcResult<GitCommitFiles | null>>;
    logSettings(): Promise<IpcResult<GitOperationLogSettings>>;
    setLogSettings(
      changes: UpdateGitOperationLogSettings,
    ): Promise<IpcResult<GitOperationLogSettings>>;
    getPreferences(): Promise<IpcResult<StoredGitPreferences>>;
    setPreferences(input: UpdateGitPreferences): Promise<IpcResult<GitPreferences>>;
    mergePreview(input: GitMergeInput): Promise<IpcResult<GitMergePreview>>;
    /** Merges a branch without committing (`--no-commit --no-ff`); the user commits after. */
    merge(input: GitMergeInput): Promise<IpcResult<GitOperation>>;
    /** Restores the state before the merge; conflict resolutions in progress are lost. */
    abortMerge(repositoryRoot: string): Promise<IpcResult<GitOperation>>;
    /** Commits of another branch, oldest first, marked when already applied. */
    cherryPickPreview(input: GitMergeInput): Promise<IpcResult<GitCherryPickPreview>>;
    /** Applies the chosen commits to the current branch, one commit each. */
    cherryPick(input: GitCherryPickInput): Promise<IpcResult<GitOperation>>;
    continueCherryPick(repositoryRoot: string): Promise<IpcResult<GitOperation>>;
    skipCherryPick(repositoryRoot: string): Promise<IpcResult<GitOperation>>;
    abortCherryPick(repositoryRoot: string): Promise<IpcResult<GitOperation>>;
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
  /** Shared context (SDD-005). Targets are authorized by the Engine. */
  context: {
    overview(target: ContextTarget): Promise<IpcResult<ContextOverview>>;
    list(query: ContextQuery): Promise<IpcResult<ContextEntry[]>>;
    global(search: string): Promise<IpcResult<ContextEntry[]>>;
    record(input: CreateContextEntryInput): Promise<IpcResult<ContextEntry>>;
    update(
      target: ContextTarget | null,
      id: string,
      input: UpdateContextEntryInput,
    ): Promise<IpcResult<ContextEntry>>;
    remove(target: ContextTarget | null, id: string): Promise<IpcResult<null>>;
    history(target: ContextTarget | null, id: string): Promise<IpcResult<ContextRevision[]>>;
    tasks(target: ContextTarget): Promise<IpcResult<ContextTask[]>>;
    createTask(input: CreateContextTaskInput): Promise<IpcResult<ContextTask>>;
    updateTask(
      target: ContextTarget,
      id: string,
      input: UpdateContextTaskInput,
    ): Promise<IpcResult<ContextTask>>;
    deleteTask(target: ContextTarget, id: string): Promise<IpcResult<null>>;
    decisions(target: ContextTarget): Promise<IpcResult<DecisionRecord[]>>;
    createDecision(input: CreateDecisionInput): Promise<IpcResult<DecisionRecord>>;
    setDecisionStatus(
      target: ContextTarget,
      id: string,
      status: 'ACTIVE' | 'REJECTED',
    ): Promise<IpcResult<DecisionRecord>>;
    bundle(request: ContextBundleRequest): Promise<IpcResult<ContextBundle>>;
    snapshot(target: ContextTarget, taskId: string | null): Promise<IpcResult<ContextSnapshot>>;
    /** Heuristic consistency signals of the stored context (read-only). */
    health(target: ContextTarget): Promise<IpcResult<ContextHealthReport>>;
    /** Runs the same checks and records the run as the latest reconciliation. */
    reconcile(target: ContextTarget): Promise<IpcResult<ContextHealthReport>>;
    budgets(): Promise<IpcResult<ContextBudgetSettings>>;
    setBudgets(changes: UpdateContextBudgetSettings): Promise<IpcResult<ContextBudgetSettings>>;
    prepareHandoff(
      target: ContextTarget,
      request: { taskId?: string; sourceSessionId?: string },
    ): Promise<IpcResult<ContextHandoffDraft>>;
    createHandoff(input: CreateHandoffInput): Promise<IpcResult<ContextHandoff>>;
    handoffs(target: ContextTarget): Promise<IpcResult<ContextHandoff[]>>;
    handoff(
      target: ContextTarget,
      id: string,
    ): Promise<IpcResult<{ handoff: ContextHandoff; markdown: string }>>;
    sessions(target: ContextTarget): Promise<IpcResult<AiSession[]>>;
    sessionEvidence(target: ContextTarget, id: string): Promise<IpcResult<SessionEvidence>>;
    endSession(
      target: ContextTarget,
      id: string,
      summary: SessionSummaryInput,
    ): Promise<IpcResult<{ session: AiSession; entries: ContextEntry[] }>>;
    sessionForTerminal(terminalId: string): Promise<IpcResult<AiSession | null>>;
    /** The project's AI configuration file in the ATLAS data directory, read by LLMs. */
    projectConfig(projectId: string): Promise<IpcResult<ProjectConfigView>>;
    setProjectConfig(
      projectId: string,
      changes: UpdateProjectAiConfig,
    ): Promise<IpcResult<ProjectConfigView>>;
  };
  /** Skills Hub (SDD-006 Milestone B). */
  skills: {
    list(): Promise<IpcResult<Skill[]>>;
    details(id: string): Promise<IpcResult<SkillDetails>>;
    suggestions(): Promise<IpcResult<SkillSourceSuggestion[]>>;
    sources(): Promise<IpcResult<SkillSource[]>>;
    addSource(input: AddSkillSourceInput): Promise<IpcResult<SkillSource>>;
    setSourceEnabled(id: string, enabled: boolean): Promise<IpcResult<null>>;
    removeSource(id: string): Promise<IpcResult<null>>;
    discover(): Promise<IpcResult<DiscoveredSkill[]>>;
    inspect(path: string): Promise<IpcResult<SkillImportPreview>>;
    import(input: ImportSkillInput): Promise<IpcResult<Skill>>;
    /** Skills in the sub-folders of a chosen folder (e.g. a skills repository). */
    inspectCollection(path: string): Promise<IpcResult<SkillCollectionPreview>>;
    importCollection(input: ImportSkillCollectionInput): Promise<IpcResult<SkillCollectionResult>>;
    templates(): Promise<IpcResult<SkillTemplate[]>>;
    createFromTemplate(input: CreateSkillFromTemplateInput): Promise<IpcResult<Skill>>;
    edit(input: EditSkillInput): Promise<IpcResult<Skill>>;
    readFile(input: {
      skillId: string;
      sequence: number;
      path: string;
    }): Promise<IpcResult<SkillFileContent>>;
    diff(input: { skillId: string; from: number; to: number }): Promise<IpcResult<SkillDiff>>;
    validate(id: string): Promise<IpcResult<Skill>>;
    setEnabled(id: string, enabled: boolean): Promise<IpcResult<Skill>>;
    assign(input: SkillAssignmentInput): Promise<IpcResult<Skill>>;
    unassign(input: RemoveSkillAssignmentInput): Promise<IpcResult<Skill>>;
    remove(id: string): Promise<IpcResult<null>>;
    resolve(input: ResolveSkillsInput): Promise<IpcResult<ResolvedSkill[]>>;
    syncTargets(): Promise<IpcResult<SkillSyncTargets>>;
    setSyncTargets(changes: UpdateSkillSyncTargets): Promise<IpcResult<SkillSyncTargets>>;
    syncPreview(provider: AiProvider): Promise<IpcResult<SkillSyncPlan>>;
    syncApply(provider: AiProvider): Promise<IpcResult<SkillSyncResult>>;
    syncHistory(): Promise<IpcResult<SkillSyncBatch[]>>;
    syncRollback(batchId: string): Promise<IpcResult<{ restored: string[]; skipped: string[] }>>;
  };
  /** Account profiles, provider limits and daily usage (SDD-008 Milestone B). */
  usage: {
    overview(query?: UsageOverviewQuery): Promise<IpcResult<UsageOverview>>;
    /** Collects now; one profile or all. Each profile is collected at most once a minute. */
    refresh(profileId: string | null): Promise<IpcResult<null>>;
    /** `directory` must come from the folder picker (`dialog.chooseDirectory('usage-profile')`). */
    addProfile(input: AddUsageProfileInput): Promise<IpcResult<UsageProfile>>;
    updateProfile(id: string, changes: UpdateUsageProfileInput): Promise<IpcResult<UsageProfile>>;
    removeProfile(id: string): Promise<IpcResult<null>>;
    setSettings(changes: UpdateUsageSettingsInput): Promise<IpcResult<UsageSettings>>;
  };
  /** Local validation of a project or folder (SDD-007 Milestone A). */
  preflight: {
    workspaces(): Promise<IpcResult<PreflightWorkspace[]>>;
    /** The workspace of a registered project, created on first use. */
    openProject(projectId: string): Promise<IpcResult<PreflightWorkspace>>;
    /** `path` must come from the folder picker (`dialog.chooseDirectory('preflight-workspace')`). */
    addFolder(path: string): Promise<IpcResult<PreflightWorkspace>>;
    /** Removes the workspace, its configuration, history and logs. */
    removeWorkspace(id: string): Promise<IpcResult<null>>;
    workspace(id: string): Promise<IpcResult<PreflightWorkspaceDetails>>;
    saveConfig(id: string, config: PreflightConfig): Promise<IpcResult<PreflightWorkspaceDetails>>;
    /** Reads package scripts, build files and workflows; executes nothing. */
    discover(id: string): Promise<IpcResult<PreflightDiscovery>>;
    /** `act` and Docker availability; `refresh` ignores the cached answer. */
    environment(refresh: boolean): Promise<IpcResult<PreflightEnvironmentStatus>>;
    /** What a run would execute and which checks need authorization. */
    plan(selection: PreflightSelection): Promise<IpcResult<PreflightPlan>>;
    start(input: PreflightStartInput): Promise<IpcResult<PreflightRun>>;
    cancel(runId: string): Promise<IpcResult<null>>;
    runs(query: PreflightRunsQuery): Promise<IpcResult<PreflightRunSummary[]>>;
    run(runId: string): Promise<IpcResult<PreflightRun>>;
    output(query: PreflightOutputQuery): Promise<IpcResult<PreflightOutputPage>>;
    /** A Markdown report of the run. */
    report(runId: string): Promise<IpcResult<string>>;
  };
  /** Notification center (SDD-009 Milestone A); changes arrive as `notifications` events. */
  notifications: {
    list(query: NotificationListQuery): Promise<IpcResult<NotificationList>>;
    markRead(id: string): Promise<IpcResult<null>>;
    markAllRead(): Promise<IpcResult<null>>;
    /** Deletes the notification. */
    remove(id: string): Promise<IpcResult<null>>;
    /** Deletes every notification. */
    clear(): Promise<IpcResult<null>>;
  };
  /**
   * Background jobs (SDD-012 Milestone A); changes arrive as `jobs` events. Jobs run in
   * the Engine and stop when ATLAS quits.
   */
  jobs: {
    /** Fails with JOB_CONFIRMATION_REQUIRED for commands that need `confirmDangerous`. */
    create(input: CreateJobInput): Promise<IpcResult<BackgroundJob>>;
    list(query: JobListQuery): Promise<IpcResult<JobPage>>;
    get(id: string): Promise<IpcResult<JobDetails>>;
    cancel(id: string): Promise<IpcResult<BackgroundJob>>;
    retry(id: string): Promise<IpcResult<BackgroundJob>>;
    output(query: JobOutputQuery): Promise<IpcResult<JobOutputPage>>;
    summary(): Promise<IpcResult<JobSummary>>;
    getSettings(): Promise<IpcResult<JobSettings>>;
    setSettings(input: UpdateJobSettingsInput): Promise<IpcResult<JobSettings>>;
  };
  /**
   * Docker (SDD-013 Milestone A). Typed operations only: the renderer never reaches the
   * Docker socket or API. Changes arrive as `docker` events while watching.
   */
  docker: {
    status(): Promise<IpcResult<DockerStatus>>;
    contexts(): Promise<IpcResult<DockerContextList>>;
    /** ATLAS's own choice; Docker's current context is not changed. */
    selectContext(input: SelectDockerContextInput): Promise<IpcResult<DockerContextList>>;
    containers(input: DockerContextRef): Promise<IpcResult<DockerContainerSummary[]>>;
    container(input: ContainerRef): Promise<IpcResult<DockerContainerDetails>>;
    lifecycle(input: ContainerLifecycleInput): Promise<IpcResult<DockerContainerSummary>>;
    rename(input: RenameContainerInput): Promise<IpcResult<DockerContainerSummary>>;
    /** Removes a stopped container; never its volumes. */
    remove(input: ContainerRef): Promise<IpcResult<null>>;
    /** Fails with DOCKER_CONFIRMATION_REQUIRED for risky configurations. */
    create(input: CreateContainerInput): Promise<IpcResult<DockerContainerSummary>>;
    stats(input: ContainerRef): Promise<IpcResult<DockerContainerStats>>;
    /** Container events for this window while the Container Manager is open. */
    watch(enabled: boolean): Promise<IpcResult<null>>;
    logsOpen(input: OpenContainerLogsInput): Promise<IpcResult<string>>;
    logsRead(input: ReadContainerLogsInput): Promise<IpcResult<PreflightOutputPage>>;
    logsClose(sessionId: string): Promise<IpcResult<null>>;
    /** A new ATLAS terminal running a shell in the container. */
    openTerminal(input: OpenContainerTerminalInput): Promise<IpcResult<TerminalSession>>;
  };
  /**
   * API Workbench (SDD-014 Milestone A). Requests run in the Engine, never in the window;
   * files to upload come only from the native picker.
   */
  http: {
    collections(input: ListHttpCollectionsInput): Promise<IpcResult<HttpCollection[]>>;
    createCollection(input: CreateHttpCollectionInput): Promise<IpcResult<HttpCollection>>;
    updateCollection(input: UpdateHttpCollectionInput): Promise<IpcResult<HttpCollection>>;
    duplicateCollection(id: string): Promise<IpcResult<HttpCollection>>;
    deleteCollection(id: string): Promise<IpcResult<null>>;
    createFolder(input: CreateHttpFolderInput): Promise<IpcResult<HttpFolder>>;
    renameFolder(input: RenameHttpItemInput): Promise<IpcResult<null>>;
    /** Removes the folder with its subfolders and requests. */
    deleteFolder(id: string): Promise<IpcResult<null>>;
    request(id: string): Promise<IpcResult<HttpSavedRequest>>;
    /** Secret values are not saved; they come back empty. */
    saveRequest(input: SaveHttpRequestInput): Promise<IpcResult<HttpSavedRequest>>;
    duplicateRequest(id: string): Promise<IpcResult<HttpSavedRequest>>;
    deleteRequest(id: string): Promise<IpcResult<null>>;
    move(input: MoveHttpItemInput): Promise<IpcResult<null>>;
    /** Settles when the response arrived; HTTP error statuses are responses. */
    send(input: SendHttpRequestInput): Promise<IpcResult<HttpExecutionResult>>;
    cancel(executionId: string): Promise<IpcResult<null>>;
    readBody(input: ReadHttpBodyInput): Promise<IpcResult<HttpBodyPage>>;
    /** Asks where to save the response body; false when cancelled. */
    saveResponse(executionId: string): Promise<IpcResult<{ saved: boolean }>>;
    /** The response is no longer shown; its body file is removed. */
    release(executionId: string): Promise<IpcResult<null>>;
    /** A file to upload, chosen in the native picker. */
    chooseFile(): Promise<IpcResult<HttpFileRef | null>>;
    cookies(collectionId: string): Promise<IpcResult<HttpCookie[]>>;
    clearCookies(collectionId: string): Promise<IpcResult<null>>;
    history(query: HttpHistoryQuery): Promise<IpcResult<HttpHistoryPage>>;
    clearHistory(): Promise<IpcResult<null>>;
    recentUrls(): Promise<IpcResult<string[]>>;
    saveSnapshot(input: SaveHttpSnapshotInput): Promise<IpcResult<HttpSnapshotSummary>>;
    snapshots(input: HttpSnapshotListInput): Promise<IpcResult<HttpSnapshotSummary[]>>;
    snapshot(id: string): Promise<IpcResult<HttpSnapshot>>;
    deleteSnapshot(id: string): Promise<IpcResult<null>>;
  };
  /** Project Hub notes (SDD-010 Milestone A); changes arrive as `notes` events. */
  notes: {
    list(query: NoteListQuery): Promise<IpcResult<NoteList>>;
    get(id: string): Promise<IpcResult<ProjectNote>>;
    create(input: CreateNoteInput): Promise<IpcResult<ProjectNote>>;
    /** Fails with NOTE_CONFLICT when the note changed since `expectedRevision`. */
    update(id: string, input: UpdateNoteInput): Promise<IpcResult<ProjectNote>>;
    remove(id: string): Promise<IpcResult<null>>;
    /** Whether `atlas:` links resolve, for marking broken ones (FR-1006). */
    checkLinks(input: CheckNoteLinksInput): Promise<IpcResult<NoteLinkStatus[]>>;
    /** Shows an `atlas:file/...` link of the project in the file manager; opens nothing. */
    revealFile(input: RevealNoteFileInput): Promise<IpcResult<null>>;
    /** Opens an http(s) or mailto link of a note in the system browser or mail client. */
    openExternal(url: string): Promise<IpcResult<null>>;
  };
  /**
   * Files of registered projects (SDD-011 Milestone A). Paths are relative to the project
   * folder; the Engine rejects anything outside it. Changes arrive as `files` events.
   */
  projectFiles: {
    list(input: ListDirectoryInput): Promise<IpcResult<DirectoryListing>>;
    read(ref: FileRef): Promise<IpcResult<FileContent>>;
    /** Fails with FILE_CONFLICT when the file changed since `expectedVersion`. */
    write(input: WriteFileInput): Promise<IpcResult<WrittenFile>>;
    create(input: CreateEntryInput): Promise<IpcResult<null>>;
    move(input: MoveEntryInput): Promise<IpcResult<null>>;
    /** Moves a file or folder to the system Trash (PLAN-033 Q2). */
    trash(ref: FileRef): Promise<IpcResult<null>>;
    /** Shows a file or folder in the system file manager without opening it. */
    reveal(ref: FileRef): Promise<IpcResult<null>>;
    versions(input: FileVersionsInput): Promise<IpcResult<FileVersionInfo[]>>;
    find(input: FindFilesInput): Promise<IpcResult<FoundFiles>>;
    /** Replaces the folders this window watches; an empty list stops watching. */
    watch(input: WatchFilesInput): Promise<IpcResult<null>>;
  };
  /** Code editor preferences and per-project layout (file references only). */
  editor: {
    getPreferences(): Promise<IpcResult<EditorPreferences>>;
    setPreferences(changes: UpdateEditorPreferencesInput): Promise<IpcResult<EditorPreferences>>;
    getLayout(projectId: string): Promise<IpcResult<EditorLayout | null>>;
    setLayout(projectId: string, layout: EditorLayout): Promise<IpcResult<null>>;
    getLastProject(): Promise<IpcResult<string | null>>;
    setLastProject(projectId: string | null): Promise<IpcResult<null>>;
  };
  /**
   * Extensions Hub (SDD-015 Milestone A): Open VSX discovery, installation and the
   * declarative contributions (themes, icon themes, grammars, snippets, language
   * configuration) of enabled extensions. No extension code runs.
   */
  extensions: {
    search(input: ExtensionSearchInput): Promise<IpcResult<ExtensionSearchResult>>;
    details(input: ExtensionDetailsInput): Promise<IpcResult<RegistryExtensionDetails>>;
    list(input: ListExtensionsInput): Promise<IpcResult<InstalledExtension[]>>;
    /** Installs, or updates when another version is installed. */
    install(input: InstallExtensionInput): Promise<IpcResult<InstalledExtension>>;
    uninstall(id: string): Promise<IpcResult<null>>;
    setEnabled(input: SetExtensionEnabledInput): Promise<IpcResult<InstalledExtension>>;
    checkUpdates(): Promise<IpcResult<ExtensionUpdateCheck>>;
    contributions(query: ContributionsQuery): Promise<IpcResult<ExtensionContributions>>;
    grammar(ref: GrammarRef): Promise<IpcResult<GrammarSource>>;
    theme(key: string): Promise<IpcResult<ResolvedColorTheme>>;
    snippets(ref: SnippetsRef): Promise<IpcResult<ResolvedSnippets>>;
    languageConfiguration(
      ref: LanguageConfigurationRef,
    ): Promise<IpcResult<Record<string, unknown>>>;
    iconTheme(key: string): Promise<IpcResult<ResolvedIconTheme>>;
    icon(ref: IconRef): Promise<IpcResult<string>>;
    diagnostics(id: string): Promise<IpcResult<ExtensionDiagnostic[]>>;
    clearDiagnostics(id: string): Promise<IpcResult<null>>;
    reportProblem(input: ReportExtensionProblemInput): Promise<IpcResult<null>>;
    /** Opens an extension's https homepage or repository in the system browser. */
    openLink(url: string): Promise<IpcResult<null>>;
  };
  /** Individual AI CLI sessions started or tracked by ATLAS. */
  /** Named shell commands run in a new project terminal (PLAN-023). */
  quickCommands: {
    list(): Promise<IpcResult<QuickCommand[]>>;
    create(input: QuickCommandInput): Promise<IpcResult<QuickCommand>>;
    update(id: string, input: QuickCommandInput): Promise<IpcResult<QuickCommand>>;
    remove(id: string): Promise<IpcResult<null>>;
    move(id: string, direction: QuickCommandMove): Promise<IpcResult<QuickCommand[]>>;
    projectSettings(projectId: string): Promise<IpcResult<ProjectQuickCommandSettings>>;
    setProjectSettings(
      projectId: string,
      settings: ProjectQuickCommandSettings,
    ): Promise<IpcResult<ProjectQuickCommandSettings>>;
    /** Opens a terminal in the project and runs the command there. */
    run(input: RunQuickCommandInput): Promise<IpcResult<TerminalSession>>;
    /** What the project's action menus offer: open a terminal, then its commands. */
    projectActions(projectId: string): Promise<IpcResult<ProjectAction[]>>;
  };
  ai: {
    /** Opens Claude Code or Codex in a new terminal, with the reviewed context prompt. */
    start(input: StartAiSessionInput): Promise<IpcResult<StartedAiSession>>;
    attach(input: AttachTerminalInput): Promise<IpcResult<AiSession>>;
  };
  app: {
    info(): Promise<IpcResult<AppInfo>>;
    /** Writes plain text to the system clipboard (works without document focus). */
    copyText(text: string, target?: ClipboardTarget): Promise<IpcResult<null>>;
    /** Reads plain text from the system clipboard; non-text content reads as ''. */
    readText(target?: ClipboardTarget): Promise<IpcResult<string>>;
    /**
     * Asks where to save `text` (native save dialog, `suggestedName` as the default file
     * name) and writes it there. `saved` is false when the user cancels.
     */
    saveText(suggestedName: string, text: string): Promise<IpcResult<{ saved: boolean }>>;
    /**
     * Turns the terminal menu shortcuts (Cmd+W, Cmd+F, Cmd+D…) on or off, so they reach
     * the code editor while it is shown (PLAN-033 R1).
     */
    setTerminalShortcuts(enabled: boolean): Promise<IpcResult<null>>;
    /** How many editor tabs have unsaved changes; quitting or closing the window asks first. */
    setUnsavedFiles(count: number): Promise<IpcResult<null>>;
    onCommand(listener: (command: AppCommand) => void): Unsubscribe;
    /** The Engine process restarted; terminal state must be reloaded. */
    onEngineRestarted(listener: () => void): Unsubscribe;
  };
}
