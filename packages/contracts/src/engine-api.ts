import { z } from 'zod';
import {
  ProjectQuickCommandSettingsSchema,
  QuickCommandIdSchema,
  QuickCommandInputSchema,
  QuickCommandMoveSchema,
  RunQuickCommandSchema,
  type ProjectAction,
  type ProjectQuickCommandSettings,
  type QuickCommand,
} from './quick-commands.js';
import {
  ProjectIdSchema,
  WorkspacePathSchema,
  type Project,
  type ProjectDetails,
  type ProjectPathInspection,
} from './project.js';
import {
  ListTerminalsInputSchema,
  TerminalColumnsSchema,
  TerminalIdSchema,
  TerminalInputDataSchema,
  TerminalRowsSchema,
  TerminalCustomTitleSchema,
  TerminalGroupIdSchema,
  TerminalGroupNameSchema,
  type ShellCatalog,
  type TerminalGroup,
  type TerminalAttachment,
  type TerminalCloseInfo,
  type TerminalPreferences,
  type TerminalSession,
} from './terminal.js';
import { TerminalWorkspaceKeySchema, type TerminalWorkspaceLayout } from './terminal-layout.js';
import {
  GitCommitInputSchema,
  GitCreateBranchInputSchema,
  GitDiffInputSchema,
  GitFetchInputSchema,
  GitCherryPickInputSchema,
  GitMergeInputSchema,
  GitOperationIdSchema,
  GitOperationLogQuerySchema,
  GitPathsInputSchema,
  GitReflogInputSchema,
  GitCommitFilesInputSchema,
  UpdateGitOperationLogSettingsSchema,
  GitPullInputSchema,
  GitPushInputSchema,
  GitRenameBranchInputSchema,
  GitRepositoryRootSchema,
  GitSwitchBranchInputSchema,
  type GitBranchList,
  type GitCommitContext,
  type GitCommitResult,
  type GitCommitSuggestion,
  type GitFileDiff,
  type GitCherryPickPreview,
  type GitMergePreview,
  type GitOperation,
  type GitOperationLogDetails,
  type GitOperationLogPage,
  type GitOperationLogSettings,
  type GitPreferences,
  type GitReflogEntry,
  type GitCommitFiles,
  type GitPullInfo,
  type GitRemote,
  type GitRepositoryEntry,
  type GitStatus,
  type GitWorkingTree,
  type ProjectGitSettings,
  type StoredGitPreferences,
  type StoredProjectGitSettings,
  type TerminalGitContext,
  type TerminalProjectContext,
} from './git.js';
import {
  AI_PROVIDERS,
  AttachTerminalSchema,
  ContextBundleRequestSchema,
  ContextQuerySchema,
  ContextTargetSchema,
  CreateContextEntrySchema,
  CreateContextTaskSchema,
  CreateDecisionSchema,
  CreateHandoffSchema,
  SessionSummarySchema,
  StartAiSessionSchema,
  UpdateContextEntrySchema,
  UpdateContextTaskSchema,
  UpdateProjectAiConfigSchema,
  UpdateContextBudgetSettingsSchema,
  type AiSession,
  type ContextBudgetSettings,
  type ContextBundle,
  type ContextHealthReport,
  type ContextEntry,
  type ContextHandoff,
  type ContextHandoffDraft,
  type ContextOverview,
  type ContextRevision,
  type ContextSnapshot,
  type ContextTask,
  type DecisionRecord,
  type SessionEvidence,
  type ProjectConfigView,
  type StartedAiSession,
} from './context.js';
import {
  AddSkillSourceSchema,
  CreateSkillFromTemplateSchema,
  EditSkillSchema,
  ImportSkillCollectionSchema,
  ImportSkillSchema,
  InspectSkillSchema,
  ReadSkillFileSchema,
  RemoveSkillAssignmentSchema,
  ResolveSkillsSchema,
  SkillAssignmentSchema,
  SkillDiffSchema,
  SkillIdSchema,
  SkillSyncTargetsSchema,
  type DiscoveredSkill,
  type ResolvedSkill,
  type Skill,
  type SkillCollectionPreview,
  type SkillCollectionResult,
  type SkillDetails,
  type SkillDiff,
  type SkillFileContent,
  type SkillImportPreview,
  type SkillSource,
  type SkillSourceSuggestion,
  type SkillSyncBatch,
  type SkillSyncPlan,
  type SkillSyncResult,
  type SkillSyncTargets,
  type SkillTemplate,
} from './skills.js';
import {
  AddUsageProfileSchema,
  UpdateUsageProfileSchema,
  UpdateUsageSettingsSchema,
  UsageOverviewQuerySchema,
  UsageProfileIdSchema,
  type UsageOverview,
  type UsageProfile,
  type TerminalLlmUsage,
  type UsageSettings,
} from './usage.js';
import {
  PreflightConfigSchema,
  PreflightOutputQuerySchema,
  PreflightRunIdSchema,
  PreflightRunsQuerySchema,
  PreflightSelectionSchema,
  PreflightStartSchema,
  PreflightWorkspaceIdSchema,
  type PreflightDiscovery,
  type PreflightEnvironmentStatus,
  type PreflightOutputPage,
  type PreflightPlan,
  type PreflightRun,
  type PreflightRunSummary,
  type PreflightWorkspace,
  type PreflightWorkspaceDetails,
} from './preflight.js';
import {
  NotificationIdSchema,
  NotificationListQuerySchema,
  type BackgroundWork,
  type NotificationList,
} from './notification.js';
import {
  CheckNoteLinksSchema,
  CreateNoteSchema,
  NoteIdSchema,
  NoteListQuerySchema,
  RevealNoteFileSchema,
  UpdateNoteSchema,
  type NoteLinkStatus,
  type NoteList,
  type ProjectNote,
} from './notes.js';
import {
  CreateJobSchema,
  JobIdSchema,
  JobListQuerySchema,
  JobOutputQuerySchema,
  UpdateJobSettingsSchema,
  type BackgroundJob,
  type JobDetails,
  type JobOutputPage,
  type JobPage,
  type JobSettings,
  type JobSummary,
} from './jobs.js';
import {
  ContainerLifecycleSchema,
  ContainerRefSchema,
  CreateContainerSchema,
  DockerContextRefSchema,
  DockerLogSessionIdSchema,
  OpenContainerLogsSchema,
  OpenContainerTerminalSchema,
  ReadContainerLogsSchema,
  RenameContainerSchema,
  SelectDockerContextSchema,
  type DockerContainerDetails,
  type DockerContainerStats,
  type DockerContainerSummary,
  type DockerContextList,
  type DockerStatus,
} from './docker.js';
import {
  ContributionsQuerySchema,
  ExtensionDetailsSchema,
  ExtensionIdSchema,
  ExtensionSearchSchema,
  ExtensionThemeKeySchema,
  GrammarRefSchema,
  IconRefSchema,
  InstallExtensionSchema,
  LanguageConfigurationRefSchema,
  ListExtensionsSchema,
  ReportExtensionProblemSchema,
  SetExtensionEnabledSchema,
  SnippetsRefSchema,
  type ExtensionContributions,
  type ExtensionDiagnostic,
  type ExtensionSearchResult,
  type ExtensionUpdateCheck,
  type GrammarSource,
  type InstalledExtension,
  type RegistryExtensionDetails,
  type ResolvedColorTheme,
  type ResolvedIconTheme,
  type ResolvedSnippets,
} from './extensions.js';
import {
  DebugConfigurationSchema,
  DebugSessionIdSchema,
  type DebugAdapter,
  type DebugSession,
} from './debug.js';
import {
  CreateHttpCollectionSchema,
  CreateHttpFolderSchema,
  HttpCollectionIdSchema,
  HttpExecutionIdSchema,
  HttpFolderIdSchema,
  HttpHistoryQuerySchema,
  HttpRequestIdSchema,
  HttpSnapshotIdSchema,
  HttpSnapshotListSchema,
  ListHttpCollectionsSchema,
  MoveHttpItemSchema,
  PickedFilesSchema,
  ReadHttpBodySchema,
  RenameHttpItemSchema,
  SaveHttpRequestSchema,
  SaveHttpSnapshotSchema,
  SendHttpRequestSchema,
  UpdateHttpCollectionSchema,
  type HttpBodyPage,
  type HttpCollection,
  type HttpCookie,
  type HttpExecutionResult,
  type HttpFolder,
  type HttpHistoryPage,
  type HttpSavedRequest,
  type HttpSnapshot,
  type HttpSnapshotSummary,
} from './http.js';
import {
  CreateEntrySchema,
  EditorLayoutSchema,
  FileRefSchema,
  FileVersionsSchema,
  FindFilesSchema,
  ListDirectorySchema,
  MoveEntrySchema,
  UpdateEditorPreferencesSchema,
  WatchFilesSchema,
  WriteFileSchema,
  type DirectoryListing,
  type EditorLayout,
  type EditorPreferences,
  type FileContent,
  type FileVersionInfo,
  type FoundFiles,
  type WrittenFile,
} from './files.js';
import {
  AtlasSessionIdSchema,
  ListSessionsInputSchema,
  SessionActionSchema,
  SessionTaskIdSchema,
  type AtlasSession,
  type AtlasSessionDetails,
  type AtlasSessionListItem,
  type SessionEvent,
  type SessionSettings,
  type SessionTask,
} from './session.js';

/** Identifies who receives output events of an attached terminal view. */
export const SubscriberIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);

const Unknown = z.unknown();
const Id = ProjectIdSchema;
const TerminalId = TerminalIdSchema;
const GroupId = TerminalGroupIdSchema;
const WorkspaceKey = TerminalWorkspaceKeySchema;
const Position = z.number().int().min(0).max(10_000);
const SessionId = AtlasSessionIdSchema;
const TaskId = SessionTaskIdSchema;
const Target = ContextTargetSchema;
const NullableTarget = ContextTargetSchema.nullable();
const Uuid = z.uuid();

/**
 * Parameter schemas of every Engine method. The Engine validates each request
 * against these schemas, whichever transport it arrived from. Payloads that need
 * deeper validation (project inputs, preferences, layouts) are declared as
 * `unknown` here and parsed by the owning service.
 */
export const ENGINE_METHOD_PARAMS = {
  'engine.status': z.tuple([]),

  'projects.list': z.tuple([]),
  'projects.get': z.tuple([Id]),
  'projects.create': z.tuple([Unknown]),
  'projects.update': z.tuple([Id, Unknown]),
  'projects.remove': z.tuple([Id]),
  'projects.select': z.tuple([Id]),
  'projects.getSelected': z.tuple([]),
  'projects.inspectPath': z.tuple([WorkspacePathSchema]),

  'terminals.list': z.tuple([ListTerminalsInputSchema]),
  'terminals.get': z.tuple([TerminalId]),
  'terminals.create': z.tuple([Unknown]),
  'terminals.write': z.tuple([TerminalId, TerminalInputDataSchema]),
  'terminals.resize': z.tuple([TerminalId, TerminalColumnsSchema, TerminalRowsSchema]),
  'terminals.rename': z.tuple([TerminalId, TerminalCustomTitleSchema]),
  'terminals.associate': z.tuple([TerminalId, Id.nullable()]),
  'terminals.move': z.tuple([TerminalId, GroupId.nullable(), Position]),
  'terminals.projectContext': z.tuple([TerminalId]),
  'terminals.git': z.tuple([TerminalId]),
  'terminals.llmUsage': z.tuple([TerminalId]),
  'terminals.registerProject': z.tuple([TerminalId, Unknown]),
  'terminals.detachProject': z.tuple([Id]),
  'terminals.terminate': z.tuple([TerminalId]),
  'terminals.restart': z.tuple([TerminalId]),
  'terminals.dismiss': z.tuple([TerminalId]),
  'terminals.closeInfo': z.tuple([TerminalId]),
  'terminals.clear': z.tuple([TerminalId]),
  'terminals.attach': z.tuple([
    TerminalId,
    SubscriberIdSchema,
    TerminalColumnsSchema,
    TerminalRowsSchema,
  ]),
  'terminals.detach': z.tuple([TerminalId, SubscriberIdSchema]),
  'terminals.detachSubscriber': z.tuple([SubscriberIdSchema]),
  'terminals.ack': z.tuple([TerminalId, SubscriberIdSchema, z.number().int().min(0).max(1e9)]),
  'terminals.shells': z.tuple([]),
  'terminals.getPreferences': z.tuple([]),
  'terminals.setPreferences': z.tuple([Unknown]),
  'terminals.getLayout': z.tuple([WorkspaceKey]),
  'terminals.setLayout': z.tuple([WorkspaceKey, Unknown]),

  'groups.list': z.tuple([]),
  'groups.create': z.tuple([TerminalGroupNameSchema]),
  'groups.rename': z.tuple([GroupId, TerminalGroupNameSchema]),
  'groups.setCollapsed': z.tuple([GroupId, z.boolean()]),
  'groups.move': z.tuple([GroupId, Position]),
  'groups.delete': z.tuple([GroupId, z.strictObject({ terminateTerminals: z.boolean() })]),

  'git.project': z.tuple([Id]),
  'git.repositories': z.tuple([]),
  'git.workingTree': z.tuple([GitRepositoryRootSchema]),
  'git.diff': z.tuple([GitDiffInputSchema]),
  'git.stage': z.tuple([GitPathsInputSchema]),
  'git.unstage': z.tuple([GitPathsInputSchema]),
  'git.commit': z.tuple([GitCommitInputSchema]),
  'git.push': z.tuple([GitPushInputSchema]),
  'git.pull': z.tuple([GitPullInputSchema]),
  'git.pullInfo': z.tuple([GitRepositoryRootSchema]),
  'git.fetch': z.tuple([GitFetchInputSchema]),
  'git.branches': z.tuple([GitRepositoryRootSchema]),
  'git.remotes': z.tuple([GitRepositoryRootSchema]),
  'git.createBranch': z.tuple([GitCreateBranchInputSchema]),
  'git.switchBranch': z.tuple([GitSwitchBranchInputSchema]),
  'git.renameBranch': z.tuple([GitRenameBranchInputSchema]),
  'git.suggestMessage': z.tuple([GitPathsInputSchema]),
  'git.operations': z.tuple([]),
  'git.cancelOperation': z.tuple([GitOperationIdSchema]),
  'git.operationLog': z.tuple([GitOperationLogQuerySchema]),
  'git.operationDetails': z.tuple([GitOperationIdSchema]),
  'git.reflog': z.tuple([GitReflogInputSchema]),
  'git.commitFiles': z.tuple([GitCommitFilesInputSchema]),
  'git.logSettings': z.tuple([]),
  'git.setLogSettings': z.tuple([UpdateGitOperationLogSettingsSchema]),
  'git.getPreferences': z.tuple([]),
  'git.setPreferences': z.tuple([Unknown]),
  'git.commitContext': z.tuple([GitRepositoryRootSchema]),
  'git.mergePreview': z.tuple([GitMergeInputSchema]),
  'git.merge': z.tuple([GitMergeInputSchema]),
  'git.abortMerge': z.tuple([GitRepositoryRootSchema]),
  // The preview takes a repository and the source branch, like a merge preview.
  'git.cherryPickPreview': z.tuple([GitMergeInputSchema]),
  'git.cherryPick': z.tuple([GitCherryPickInputSchema]),
  'git.continueCherryPick': z.tuple([GitRepositoryRootSchema]),
  'git.skipCherryPick': z.tuple([GitRepositoryRootSchema]),
  'git.abortCherryPick': z.tuple([GitRepositoryRootSchema]),
  'git.getProjectSettings': z.tuple([Id]),
  'git.setProjectSettings': z.tuple([Id, Unknown]),
  'terminals.closeAllInfo': z.tuple([]),

  'sessions.list': z.tuple([ListSessionsInputSchema]),
  'sessions.get': z.tuple([SessionId]),
  'sessions.create': z.tuple([Unknown]),
  'sessions.update': z.tuple([SessionId, Unknown]),
  'sessions.perform': z.tuple([SessionId, SessionActionSchema]),
  'sessions.tasks': z.tuple([SessionId]),
  'sessions.events': z.tuple([SessionId]),
  'sessions.addTask': z.tuple([SessionId, Unknown]),
  'sessions.updateTask': z.tuple([SessionId, TaskId, Unknown]),
  'sessions.removeTask': z.tuple([SessionId, TaskId]),
  'sessions.cancelTask': z.tuple([SessionId, TaskId]),
  'context.overview': z.tuple([Target]),
  'context.list': z.tuple([ContextQuerySchema]),
  'context.global': z.tuple([z.string().trim().max(200)]),
  'context.record': z.tuple([CreateContextEntrySchema]),
  'context.update': z.tuple([NullableTarget, Uuid, UpdateContextEntrySchema]),
  'context.remove': z.tuple([NullableTarget, Uuid]),
  'context.history': z.tuple([NullableTarget, Uuid]),
  'context.tasks': z.tuple([Target]),
  'context.createTask': z.tuple([CreateContextTaskSchema]),
  'context.updateTask': z.tuple([Target, Uuid, UpdateContextTaskSchema]),
  'context.deleteTask': z.tuple([Target, Uuid]),
  'context.decisions': z.tuple([Target]),
  'context.createDecision': z.tuple([CreateDecisionSchema]),
  'context.setDecisionStatus': z.tuple([Target, Uuid, z.enum(['ACTIVE', 'REJECTED'])]),
  'context.bundle': z.tuple([ContextBundleRequestSchema]),
  'context.snapshot': z.tuple([Target, Uuid.nullable()]),
  'context.health': z.tuple([Target]),
  'context.reconcile': z.tuple([Target]),
  'context.budgets': z.tuple([]),
  'context.setBudgets': z.tuple([UpdateContextBudgetSettingsSchema]),
  'context.prepareHandoff': z.tuple([
    Target,
    z.strictObject({ taskId: Uuid.optional(), sourceSessionId: Uuid.optional() }),
  ]),
  'context.createHandoff': z.tuple([CreateHandoffSchema]),
  'context.handoffs': z.tuple([Target]),
  'context.handoff': z.tuple([Target, Uuid]),
  'context.sessions': z.tuple([Target]),
  'context.sessionEvidence': z.tuple([Target, Uuid]),
  'context.endSession': z.tuple([Target, Uuid, SessionSummarySchema]),
  'context.sessionForTerminal': z.tuple([TerminalId]),
  'ai.start': z.tuple([StartAiSessionSchema]),
  'quickCommands.list': z.tuple([]),
  'quickCommands.create': z.tuple([QuickCommandInputSchema]),
  'quickCommands.update': z.tuple([QuickCommandIdSchema, QuickCommandInputSchema]),
  'quickCommands.remove': z.tuple([QuickCommandIdSchema]),
  'quickCommands.move': z.tuple([QuickCommandIdSchema, QuickCommandMoveSchema]),
  'quickCommands.projectSettings': z.tuple([Id]),
  'quickCommands.setProjectSettings': z.tuple([Id, ProjectQuickCommandSettingsSchema]),
  'quickCommands.run': z.tuple([RunQuickCommandSchema]),
  'projects.actions': z.tuple([Id]),
  'ai.attach': z.tuple([AttachTerminalSchema]),
  'context.projectConfig': z.tuple([Id]),
  'context.setProjectConfig': z.tuple([Id, UpdateProjectAiConfigSchema]),
  'sessions.getSettings': z.tuple([]),
  'sessions.setSettings': z.tuple([Unknown]),
  'skills.list': z.tuple([]),
  'skills.details': z.tuple([SkillIdSchema]),
  'skills.suggestions': z.tuple([]),
  'skills.sources': z.tuple([]),
  'skills.addSource': z.tuple([AddSkillSourceSchema, z.boolean()]),
  'skills.setSourceEnabled': z.tuple([SkillIdSchema, z.boolean()]),
  'skills.removeSource': z.tuple([SkillIdSchema]),
  'skills.discover': z.tuple([]),
  'skills.inspect': z.tuple([InspectSkillSchema, z.boolean()]),
  'skills.import': z.tuple([ImportSkillSchema, z.boolean()]),
  'skills.inspectCollection': z.tuple([InspectSkillSchema, z.boolean()]),
  'skills.importCollection': z.tuple([ImportSkillCollectionSchema, z.boolean()]),
  'skills.templates': z.tuple([]),
  'skills.createFromTemplate': z.tuple([CreateSkillFromTemplateSchema]),
  'skills.edit': z.tuple([EditSkillSchema]),
  'skills.readFile': z.tuple([ReadSkillFileSchema]),
  'skills.diff': z.tuple([SkillDiffSchema]),
  'skills.validate': z.tuple([SkillIdSchema]),
  'skills.setEnabled': z.tuple([SkillIdSchema, z.boolean()]),
  'skills.assign': z.tuple([SkillAssignmentSchema]),
  'skills.unassign': z.tuple([RemoveSkillAssignmentSchema]),
  'skills.remove': z.tuple([SkillIdSchema]),
  'skills.resolve': z.tuple([ResolveSkillsSchema]),
  'skills.syncTargets': z.tuple([]),
  'skills.setSyncTargets': z.tuple([SkillSyncTargetsSchema]),
  'skills.syncPreview': z.tuple([z.enum(AI_PROVIDERS)]),
  'skills.syncApply': z.tuple([z.enum(AI_PROVIDERS)]),
  'skills.syncHistory': z.tuple([]),
  'skills.syncRollback': z.tuple([SkillIdSchema]),
  'usage.overview': z.tuple([UsageOverviewQuerySchema]),
  'usage.refresh': z.tuple([UsageProfileIdSchema.nullable()]),
  'usage.addProfile': z.tuple([AddUsageProfileSchema, z.boolean()]),
  'usage.updateProfile': z.tuple([UsageProfileIdSchema, UpdateUsageProfileSchema]),
  'usage.removeProfile': z.tuple([UsageProfileIdSchema]),
  'usage.setSettings': z.tuple([UpdateUsageSettingsSchema]),
  'preflight.workspaces': z.tuple([]),
  'preflight.openProject': z.tuple([Id]),
  'preflight.addFolder': z.tuple([z.string().min(1).max(4096), z.boolean()]),
  'preflight.removeWorkspace': z.tuple([PreflightWorkspaceIdSchema]),
  'preflight.workspace': z.tuple([PreflightWorkspaceIdSchema]),
  'preflight.saveConfig': z.tuple([PreflightWorkspaceIdSchema, PreflightConfigSchema]),
  'preflight.discover': z.tuple([PreflightWorkspaceIdSchema]),
  'preflight.environment': z.tuple([z.boolean()]),
  'preflight.plan': z.tuple([PreflightSelectionSchema]),
  'preflight.start': z.tuple([PreflightStartSchema]),
  'preflight.cancel': z.tuple([PreflightRunIdSchema]),
  'preflight.runs': z.tuple([PreflightRunsQuerySchema]),
  'preflight.run': z.tuple([PreflightRunIdSchema]),
  'preflight.output': z.tuple([PreflightOutputQuerySchema]),
  'preflight.report': z.tuple([PreflightRunIdSchema]),
  'notifications.list': z.tuple([NotificationListQuerySchema]),
  'notifications.markRead': z.tuple([NotificationIdSchema]),
  'notifications.markAllRead': z.tuple([]),
  'notifications.remove': z.tuple([NotificationIdSchema]),
  'notifications.clear': z.tuple([]),
  'engine.backgroundWork': z.tuple([]),
  // Project Hub notes (SDD-010 Milestone A).
  'notes.list': z.tuple([NoteListQuerySchema]),
  'notes.get': z.tuple([NoteIdSchema]),
  'notes.create': z.tuple([CreateNoteSchema]),
  'notes.update': z.tuple([NoteIdSchema, UpdateNoteSchema]),
  'notes.remove': z.tuple([NoteIdSchema]),
  'notes.checkLinks': z.tuple([CheckNoteLinksSchema]),
  /** Absolute path of an `atlas:file/...` link inside the project; for revealing it. */
  'notes.filePath': z.tuple([RevealNoteFileSchema]),
  // Background jobs (SDD-012 Milestone A). Only the desktop creates or changes jobs.
  'jobs.create': z.tuple([CreateJobSchema]),
  'jobs.list': z.tuple([JobListQuerySchema]),
  'jobs.get': z.tuple([JobIdSchema]),
  'jobs.cancel': z.tuple([JobIdSchema]),
  'jobs.retry': z.tuple([JobIdSchema]),
  'jobs.output': z.tuple([JobOutputQuerySchema]),
  'jobs.summary': z.tuple([]),
  'jobs.getSettings': z.tuple([]),
  'jobs.setSettings': z.tuple([UpdateJobSettingsSchema]),
  // Docker (SDD-013 Milestone A): desktop only; every request names its context.
  'docker.status': z.tuple([]),
  'docker.contexts': z.tuple([]),
  'docker.selectContext': z.tuple([SelectDockerContextSchema]),
  'docker.containers': z.tuple([DockerContextRefSchema]),
  'docker.container': z.tuple([ContainerRefSchema]),
  'docker.lifecycle': z.tuple([ContainerLifecycleSchema]),
  'docker.rename': z.tuple([RenameContainerSchema]),
  'docker.remove': z.tuple([ContainerRefSchema]),
  'docker.create': z.tuple([CreateContainerSchema]),
  'docker.stats': z.tuple([ContainerRefSchema]),
  /** The subscriber is the window, set by the main process. */
  'docker.watch': z.tuple([SubscriberIdSchema, z.boolean()]),
  'docker.logsOpen': z.tuple([SubscriberIdSchema, OpenContainerLogsSchema]),
  'docker.logsRead': z.tuple([ReadContainerLogsSchema]),
  'docker.logsClose': z.tuple([DockerLogSessionIdSchema]),
  /** Stops the watch and the log streams of a window that went away. */
  'docker.detach': z.tuple([SubscriberIdSchema]),
  'docker.openTerminal': z.tuple([OpenContainerTerminalSchema]),
  // API Workbench (SDD-014 Milestone A): desktop only. The main process adds the window
  // and the files picked in it; renderer-supplied paths are never trusted alone.
  'http.collections': z.tuple([ListHttpCollectionsSchema]),
  'http.createCollection': z.tuple([CreateHttpCollectionSchema]),
  'http.updateCollection': z.tuple([UpdateHttpCollectionSchema]),
  'http.duplicateCollection': z.tuple([HttpCollectionIdSchema]),
  'http.deleteCollection': z.tuple([HttpCollectionIdSchema]),
  'http.createFolder': z.tuple([CreateHttpFolderSchema]),
  'http.renameFolder': z.tuple([RenameHttpItemSchema]),
  'http.deleteFolder': z.tuple([HttpFolderIdSchema]),
  'http.request': z.tuple([HttpRequestIdSchema]),
  'http.saveRequest': z.tuple([SaveHttpRequestSchema, PickedFilesSchema]),
  'http.duplicateRequest': z.tuple([HttpRequestIdSchema]),
  'http.deleteRequest': z.tuple([HttpRequestIdSchema]),
  'http.move': z.tuple([MoveHttpItemSchema]),
  'http.send': z.tuple([SubscriberIdSchema, SendHttpRequestSchema, PickedFilesSchema]),
  'http.cancel': z.tuple([HttpExecutionIdSchema]),
  'http.readBody': z.tuple([ReadHttpBodySchema]),
  /** The destination comes from the main process's save dialog. */
  'http.saveResponse': z.tuple([HttpExecutionIdSchema, z.string().min(1).max(4096)]),
  'http.release': z.tuple([HttpExecutionIdSchema]),
  'http.detach': z.tuple([SubscriberIdSchema]),
  'http.cookies': z.tuple([HttpCollectionIdSchema]),
  'http.clearCookies': z.tuple([HttpCollectionIdSchema]),
  'http.history': z.tuple([HttpHistoryQuerySchema]),
  'http.clearHistory': z.tuple([]),
  'http.recentUrls': z.tuple([]),
  'http.saveSnapshot': z.tuple([SaveHttpSnapshotSchema]),
  'http.snapshots': z.tuple([HttpSnapshotListSchema]),
  'http.snapshot': z.tuple([HttpSnapshotIdSchema]),
  'http.deleteSnapshot': z.tuple([HttpSnapshotIdSchema]),
  // Project files and the code editor (SDD-011 Milestone A); not offered to the CLI.
  'files.list': z.tuple([ListDirectorySchema]),
  'files.read': z.tuple([FileRefSchema]),
  'files.write': z.tuple([WriteFileSchema]),
  'files.create': z.tuple([CreateEntrySchema]),
  'files.move': z.tuple([MoveEntrySchema]),
  'files.versions': z.tuple([FileVersionsSchema]),
  'files.find': z.tuple([FindFilesSchema]),
  /** Replaces the folders `subscriber` watches; changes arrive as `files` events. */
  'files.watch': z.tuple([SubscriberIdSchema, WatchFilesSchema]),
  /** Absolute path of an existing entry, for the main process (Trash, reveal). */
  'files.absolutePath': z.tuple([FileRefSchema]),
  'editor.getPreferences': z.tuple([]),
  'editor.setPreferences': z.tuple([UpdateEditorPreferencesSchema]),
  'editor.getLayout': z.tuple([Id]),
  'editor.setLayout': z.tuple([Id, EditorLayoutSchema]),
  'editor.getLastProject': z.tuple([]),
  'editor.setLastProject': z.tuple([Id.nullable()]),
  // Extensions Hub and declarative contributions (SDD-015 Milestone A); not offered to the CLI.
  'extensions.search': z.tuple([ExtensionSearchSchema]),
  'extensions.details': z.tuple([ExtensionDetailsSchema]),
  'extensions.list': z.tuple([ListExtensionsSchema]),
  'extensions.install': z.tuple([InstallExtensionSchema]),
  'extensions.uninstall': z.tuple([ExtensionIdSchema]),
  'extensions.setEnabled': z.tuple([SetExtensionEnabledSchema]),
  'extensions.checkUpdates': z.tuple([]),
  'extensions.contributions': z.tuple([ContributionsQuerySchema]),
  'extensions.grammar': z.tuple([GrammarRefSchema]),
  'extensions.theme': z.tuple([ExtensionThemeKeySchema]),
  'extensions.snippets': z.tuple([SnippetsRefSchema]),
  'extensions.languageConfiguration': z.tuple([LanguageConfigurationRefSchema]),
  'extensions.iconTheme': z.tuple([ExtensionThemeKeySchema]),
  'extensions.icon': z.tuple([IconRefSchema]),
  'extensions.diagnostics': z.tuple([ExtensionIdSchema]),
  'extensions.clearDiagnostics': z.tuple([ExtensionIdSchema]),
  'extensions.reportProblem': z.tuple([ReportExtensionProblemSchema]),
  // Debugger foundation (SDD-016 Task 01); desktop only. The subscriber is the owner, set
  // by the main process. A session runs only when `debug.start` is called for it.
  'debug.adapters': z.tuple([]),
  'debug.create': z.tuple([SubscriberIdSchema, DebugConfigurationSchema]),
  'debug.start': z.tuple([SubscriberIdSchema, DebugSessionIdSchema]),
  'debug.stop': z.tuple([SubscriberIdSchema, DebugSessionIdSchema]),
  'debug.session': z.tuple([SubscriberIdSchema, DebugSessionIdSchema]),
  'debug.sessions': z.tuple([SubscriberIdSchema]),
  'debug.detach': z.tuple([SubscriberIdSchema]),
} as const;

export type EngineMethod = keyof typeof ENGINE_METHOD_PARAMS;

export interface EngineStatus {
  engineVersion: string;
  dataDir: string;
  logFile: string;
  schemaVersion: number;
  pid: number;
  activeTerminals: number;
}

/** Result type of each Engine method. */
export interface EngineMethodResults {
  'engine.status': EngineStatus;
  'projects.list': ProjectDetails[];
  'projects.get': ProjectDetails;
  'projects.create': Project;
  'projects.update': Project;
  'projects.remove': null;
  'projects.select': null;
  'projects.getSelected': ProjectDetails | null;
  'projects.inspectPath': ProjectPathInspection;
  'terminals.list': TerminalSession[];
  'terminals.get': TerminalSession;
  'terminals.create': TerminalSession;
  'terminals.write': null;
  'terminals.resize': null;
  'terminals.rename': TerminalSession;
  'terminals.associate': TerminalSession;
  'terminals.move': TerminalSession;
  'terminals.projectContext': TerminalProjectContext;
  'terminals.git': TerminalGitContext;
  'terminals.llmUsage': TerminalLlmUsage | null;
  'terminals.registerProject': { project: Project; session: TerminalSession };
  'terminals.detachProject': null;
  'terminals.terminate': TerminalSession;
  'terminals.restart': TerminalSession;
  'terminals.dismiss': null;
  'terminals.closeInfo': TerminalCloseInfo;
  'terminals.clear': null;
  'terminals.attach': TerminalAttachment;
  'terminals.detach': null;
  'terminals.detachSubscriber': null;
  'terminals.ack': null;
  'terminals.shells': ShellCatalog;
  'terminals.getPreferences': TerminalPreferences;
  'terminals.setPreferences': TerminalPreferences;
  'terminals.getLayout': TerminalWorkspaceLayout | null;
  'terminals.setLayout': null;
  'groups.list': TerminalGroup[];
  'groups.create': TerminalGroup;
  'groups.rename': TerminalGroup;
  'groups.setCollapsed': TerminalGroup;
  'groups.move': TerminalGroup[];
  'groups.delete': null;
  'git.project': GitStatus;
  'git.repositories': GitRepositoryEntry[];
  'git.workingTree': GitWorkingTree;
  'git.diff': GitFileDiff;
  'git.stage': GitOperation;
  'git.unstage': GitOperation;
  'git.commit': GitCommitResult;
  'git.push': GitOperation;
  'git.pull': GitOperation;
  'git.pullInfo': GitPullInfo;
  'git.fetch': GitOperation;
  'git.branches': GitBranchList;
  'git.remotes': GitRemote[];
  'git.createBranch': GitOperation;
  'git.switchBranch': GitOperation;
  'git.renameBranch': GitOperation;
  'git.suggestMessage': GitCommitSuggestion | null;
  'git.operations': GitOperation[];
  'git.cancelOperation': GitOperation;
  'git.operationLog': GitOperationLogPage;
  'git.operationDetails': GitOperationLogDetails;
  'git.reflog': GitReflogEntry[];
  'git.commitFiles': GitCommitFiles | null;
  'git.logSettings': GitOperationLogSettings;
  'git.setLogSettings': GitOperationLogSettings;
  'git.getPreferences': StoredGitPreferences;
  'git.setPreferences': GitPreferences;
  'git.commitContext': GitCommitContext;
  'git.mergePreview': GitMergePreview;
  'git.merge': GitOperation;
  'git.abortMerge': GitOperation;
  'git.cherryPickPreview': GitCherryPickPreview;
  'git.cherryPick': GitOperation;
  'git.continueCherryPick': GitOperation;
  'git.skipCherryPick': GitOperation;
  'git.abortCherryPick': GitOperation;
  'git.getProjectSettings': StoredProjectGitSettings;
  'git.setProjectSettings': ProjectGitSettings;
  'terminals.closeAllInfo': { runningSessions: number; busySessions: number };
  'sessions.list': AtlasSessionListItem[];
  'sessions.get': AtlasSessionDetails;
  'sessions.create': AtlasSession;
  'sessions.update': AtlasSession;
  'sessions.perform': AtlasSession;
  'sessions.tasks': SessionTask[];
  'sessions.events': SessionEvent[];
  'sessions.addTask': SessionTask;
  'sessions.updateTask': SessionTask;
  'sessions.removeTask': null;
  'sessions.cancelTask': SessionTask;
  'context.overview': ContextOverview;
  'context.list': ContextEntry[];
  'context.global': ContextEntry[];
  'context.record': ContextEntry;
  'context.update': ContextEntry;
  'context.remove': null;
  'context.history': ContextRevision[];
  'context.tasks': ContextTask[];
  'context.createTask': ContextTask;
  'context.updateTask': ContextTask;
  'context.deleteTask': null;
  'context.decisions': DecisionRecord[];
  'context.createDecision': DecisionRecord;
  'context.setDecisionStatus': DecisionRecord;
  'context.bundle': ContextBundle;
  'context.snapshot': ContextSnapshot;
  'context.health': ContextHealthReport;
  'context.reconcile': ContextHealthReport;
  'context.budgets': ContextBudgetSettings;
  'context.setBudgets': ContextBudgetSettings;
  'context.prepareHandoff': ContextHandoffDraft;
  'context.createHandoff': ContextHandoff;
  'context.handoffs': ContextHandoff[];
  'context.handoff': { handoff: ContextHandoff; markdown: string };
  'context.sessions': AiSession[];
  'context.sessionEvidence': SessionEvidence;
  'context.endSession': { session: AiSession; entries: ContextEntry[] };
  'context.sessionForTerminal': AiSession | null;
  'ai.start': StartedAiSession;
  'quickCommands.list': QuickCommand[];
  'quickCommands.create': QuickCommand;
  'quickCommands.update': QuickCommand;
  'quickCommands.remove': null;
  'quickCommands.move': QuickCommand[];
  'quickCommands.projectSettings': ProjectQuickCommandSettings;
  'quickCommands.setProjectSettings': ProjectQuickCommandSettings;
  'quickCommands.run': TerminalSession;
  'projects.actions': ProjectAction[];
  'ai.attach': AiSession;
  'context.projectConfig': ProjectConfigView;
  'context.setProjectConfig': ProjectConfigView;
  'sessions.getSettings': SessionSettings;
  'sessions.setSettings': SessionSettings;
  'skills.list': Skill[];
  'skills.details': SkillDetails;
  'skills.suggestions': SkillSourceSuggestion[];
  'skills.sources': SkillSource[];
  'skills.addSource': SkillSource;
  'skills.setSourceEnabled': null;
  'skills.removeSource': null;
  'skills.discover': DiscoveredSkill[];
  'skills.inspect': SkillImportPreview;
  'skills.import': Skill;
  'skills.inspectCollection': SkillCollectionPreview;
  'skills.importCollection': SkillCollectionResult;
  'skills.templates': SkillTemplate[];
  'skills.createFromTemplate': Skill;
  'skills.edit': Skill;
  'skills.readFile': SkillFileContent;
  'skills.diff': SkillDiff;
  'skills.validate': Skill;
  'skills.setEnabled': Skill;
  'skills.assign': Skill;
  'skills.unassign': Skill;
  'skills.remove': null;
  'skills.resolve': ResolvedSkill[];
  'skills.syncTargets': SkillSyncTargets;
  'skills.setSyncTargets': SkillSyncTargets;
  'skills.syncPreview': SkillSyncPlan;
  'skills.syncApply': SkillSyncResult;
  'skills.syncHistory': SkillSyncBatch[];
  'skills.syncRollback': { restored: string[]; skipped: string[] };
  'usage.overview': UsageOverview;
  'usage.refresh': null;
  'usage.addProfile': UsageProfile;
  'usage.updateProfile': UsageProfile;
  'usage.removeProfile': null;
  'usage.setSettings': UsageSettings;
  'preflight.workspaces': PreflightWorkspace[];
  'preflight.openProject': PreflightWorkspace;
  'preflight.addFolder': PreflightWorkspace;
  'preflight.removeWorkspace': null;
  'preflight.workspace': PreflightWorkspaceDetails;
  'preflight.saveConfig': PreflightWorkspaceDetails;
  'preflight.discover': PreflightDiscovery;
  'preflight.environment': PreflightEnvironmentStatus;
  'preflight.plan': PreflightPlan;
  'preflight.start': PreflightRun;
  'preflight.cancel': null;
  'preflight.runs': PreflightRunSummary[];
  'preflight.run': PreflightRun;
  'preflight.output': PreflightOutputPage;
  'preflight.report': string;
  'notifications.list': NotificationList;
  'notifications.markRead': null;
  'notifications.markAllRead': null;
  'notifications.remove': null;
  'notifications.clear': null;
  'engine.backgroundWork': BackgroundWork;
  'notes.list': NoteList;
  'notes.get': ProjectNote;
  'notes.create': ProjectNote;
  'notes.update': ProjectNote;
  'notes.remove': null;
  'notes.checkLinks': NoteLinkStatus[];
  'notes.filePath': string;
  'jobs.create': BackgroundJob;
  'jobs.list': JobPage;
  'jobs.get': JobDetails;
  /** The job as cancellation left it: cancelled, or still running while it stops. */
  'jobs.cancel': BackgroundJob;
  'jobs.retry': BackgroundJob;
  'jobs.output': JobOutputPage;
  'jobs.summary': JobSummary;
  'jobs.getSettings': JobSettings;
  'jobs.setSettings': JobSettings;
  'docker.status': DockerStatus;
  'docker.contexts': DockerContextList;
  'docker.selectContext': DockerContextList;
  'docker.containers': DockerContainerSummary[];
  'docker.container': DockerContainerDetails;
  'docker.lifecycle': DockerContainerSummary;
  'docker.rename': DockerContainerSummary;
  'docker.remove': null;
  'docker.create': DockerContainerSummary;
  'docker.stats': DockerContainerStats;
  'docker.watch': null;
  /** The log session id. */
  'docker.logsOpen': string;
  'docker.logsRead': PreflightOutputPage;
  'docker.logsClose': null;
  'docker.detach': null;
  'docker.openTerminal': TerminalSession;
  'http.collections': HttpCollection[];
  'http.createCollection': HttpCollection;
  'http.updateCollection': HttpCollection;
  'http.duplicateCollection': HttpCollection;
  'http.deleteCollection': null;
  'http.createFolder': HttpFolder;
  'http.renameFolder': null;
  'http.deleteFolder': null;
  'http.request': HttpSavedRequest;
  'http.saveRequest': HttpSavedRequest;
  'http.duplicateRequest': HttpSavedRequest;
  'http.deleteRequest': null;
  'http.move': null;
  'http.send': HttpExecutionResult;
  'http.cancel': null;
  'http.readBody': HttpBodyPage;
  'http.saveResponse': null;
  'http.release': null;
  'http.detach': null;
  'http.cookies': HttpCookie[];
  'http.clearCookies': null;
  'http.history': HttpHistoryPage;
  'http.clearHistory': null;
  'http.recentUrls': string[];
  'http.saveSnapshot': HttpSnapshotSummary;
  'http.snapshots': HttpSnapshotSummary[];
  'http.snapshot': HttpSnapshot;
  'http.deleteSnapshot': null;
  'files.list': DirectoryListing;
  'files.read': FileContent;
  'files.write': WrittenFile;
  'files.create': null;
  'files.move': null;
  'files.versions': FileVersionInfo[];
  'files.find': FoundFiles;
  'files.watch': null;
  'files.absolutePath': string;
  'editor.getPreferences': EditorPreferences;
  'editor.setPreferences': EditorPreferences;
  'editor.getLayout': EditorLayout | null;
  'editor.setLayout': null;
  'editor.getLastProject': string | null;
  'editor.setLastProject': null;
  'extensions.search': ExtensionSearchResult;
  'extensions.details': RegistryExtensionDetails;
  'extensions.list': InstalledExtension[];
  'extensions.install': InstalledExtension;
  'extensions.uninstall': null;
  'extensions.setEnabled': InstalledExtension;
  'extensions.checkUpdates': ExtensionUpdateCheck;
  'extensions.contributions': ExtensionContributions;
  'extensions.grammar': GrammarSource;
  'extensions.theme': ResolvedColorTheme;
  'extensions.snippets': ResolvedSnippets;
  /** The parsed `language-configuration.json`; the editor maps what it supports. */
  'extensions.languageConfiguration': Record<string, unknown>;
  'extensions.iconTheme': ResolvedIconTheme;
  /** A `data:` URI of an SVG or PNG icon. */
  'extensions.icon': string;
  'extensions.diagnostics': ExtensionDiagnostic[];
  'extensions.clearDiagnostics': null;
  'extensions.reportProblem': null;
  'debug.adapters': DebugAdapter[];
  'debug.create': DebugSession;
  /** Settles once the session runs (or failed to start). */
  'debug.start': DebugSession;
  'debug.stop': DebugSession;
  'debug.session': DebugSession;
  'debug.sessions': DebugSession[];
  'debug.detach': null;
}

export type EngineMethodParams<M extends EngineMethod> = z.input<(typeof ENGINE_METHOD_PARAMS)[M]>;

/** Methods available to local CLI clients over the authenticated socket. */
export const CLI_ENGINE_METHODS: readonly EngineMethod[] = [
  // Shared context: reading, handoffs and starting AI sessions in the running app.
  'context.overview',
  'context.list',
  'context.tasks',
  'context.decisions',
  'context.bundle',
  'context.health',
  // Git history: operations ATLAS ran and the repository reflog (read-only).
  'git.operationLog',
  'git.operationDetails',
  'git.reflog',
  'git.commitFiles',
  'context.prepareHandoff',
  'context.createHandoff',
  'context.handoffs',
  'context.handoff',
  'context.sessions',
  'ai.start',
  // Skills Hub: the CLI acts on explicit user commands (paths are command arguments).
  'skills.list',
  'skills.details',
  'skills.sources',
  'skills.addSource',
  'skills.removeSource',
  'skills.discover',
  'skills.inspect',
  'skills.import',
  'skills.inspectCollection',
  'skills.importCollection',
  'skills.templates',
  'skills.readFile',
  'skills.diff',
  'skills.validate',
  'skills.setEnabled',
  'skills.assign',
  'skills.unassign',
  'skills.remove',
  'skills.resolve',
  'skills.syncTargets',
  'skills.syncPreview',
  'skills.syncApply',
  'skills.syncHistory',
  'skills.syncRollback',
  // Usage: reading only; changes are made in the app.
  'usage.overview',
  'engine.status',
  'terminals.list',
  'terminals.get',
  'terminals.create',
  'terminals.terminate',
  'terminals.closeInfo',
  'terminals.rename',
  'terminals.detachProject',
  'sessions.list',
  'sessions.get',
  'sessions.create',
  'sessions.perform',
  'sessions.tasks',
  'sessions.events',
  // Background jobs: reading only; jobs are created and changed in the app.
  'jobs.list',
  'jobs.get',
];
