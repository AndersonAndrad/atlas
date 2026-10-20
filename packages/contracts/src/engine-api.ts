import { z } from 'zod';
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
  GitMergeInputSchema,
  GitOperationIdSchema,
  GitPathsInputSchema,
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
  type GitMergePreview,
  type GitOperation,
  type GitPreferences,
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
  'git.getPreferences': z.tuple([]),
  'git.setPreferences': z.tuple([Unknown]),
  'git.commitContext': z.tuple([GitRepositoryRootSchema]),
  'git.mergePreview': z.tuple([GitMergeInputSchema]),
  'git.merge': z.tuple([GitMergeInputSchema]),
  'git.abortMerge': z.tuple([GitRepositoryRootSchema]),
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
  'sessions.getSettings': z.tuple([]),
  'sessions.setSettings': z.tuple([Unknown]),
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
  'git.getPreferences': StoredGitPreferences;
  'git.setPreferences': GitPreferences;
  'git.commitContext': GitCommitContext;
  'git.mergePreview': GitMergePreview;
  'git.merge': GitOperation;
  'git.abortMerge': GitOperation;
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
  'sessions.getSettings': SessionSettings;
  'sessions.setSettings': SessionSettings;
}

export type EngineMethodParams<M extends EngineMethod> = z.input<(typeof ENGINE_METHOD_PARAMS)[M]>;

/** Methods available to local CLI clients over the authenticated socket. */
export const CLI_ENGINE_METHODS: readonly EngineMethod[] = [
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
];
