import {
  AtlasSessionIdSchema,
  CreateProjectInputSchema,
  CreateSessionInputSchema,
  ListSessionsInputSchema,
  SessionActionSchema,
  SessionTaskIdSchema,
  UpdateSessionInputSchema,
  CreateTerminalInputSchema,
  GitCommitInputSchema,
  GitCreateBranchInputSchema,
  GitDiffInputSchema,
  GitFetchInputSchema,
  GitCherryPickInputSchema,
  GitMergeInputSchema,
  GitOperationIdSchema,
  GitOperationLogQuerySchema,
  GitReflogInputSchema,
  GitCommitFilesInputSchema,
  UpdateGitOperationLogSettingsSchema,
  GitPathsInputSchema,
  GitPullInputSchema,
  GitPushInputSchema,
  GitRenameBranchInputSchema,
  GitRepositoryRootSchema,
  GitSwitchBranchInputSchema,
  UpdateGitPreferencesSchema,
  ProjectGitSettingsSchema,
  ENGINE_METHOD_PARAMS,
  IPC_CHANNELS,
  IPC_SEND_CHANNELS,
  type EngineMethod,
  TERMINAL_VIEW_ID_PATTERN,
  ProjectIdSchema,
  TerminalColumnsSchema,
  TerminalIdSchema,
  TerminalInputDataSchema,
  TerminalRowsSchema,
  TerminalCustomTitleSchema,
  TerminalGroupIdSchema,
  TerminalGroupNameSchema,
  TerminalWorkspaceKeySchema,
  UpdateTerminalPreferencesSchema,
  UpdateProjectInputSchema,
  parseInput,
  AddSkillSourceSchema,
  ImportSkillCollectionSchema,
  ImportSkillSchema,
  InspectSkillSchema,
  SkillSyncTargetsSchema,
  type AddSkillSourceInput,
  type ImportSkillCollectionInput,
  type ImportSkillInput,
  type AppInfo,
  type DirectoryChoice,
  type IpcResult,
} from '@atlas/contracts';
import { AtlasError, describeError, toSerializedError, type Logger } from '@atlas/shared';
import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from 'electron';
import { z } from 'zod';
import type { EngineCaller } from './engine-client';

export interface IpcDependencies {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeAllListeners'>;
  engine: EngineCaller;
  logger: Logger;
  /** Returns true when the event comes from a trusted ATLAS window and frame. */
  isTrustedSender: (event: IpcMainInvokeEvent | IpcMainEvent) => boolean;
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
  /**
   * Identifies the current renderer document; terminal views subscribe as
   * `<subscriberId>:<viewId>`. It changes when the renderer reloads, so views
   * of a previous document never receive output.
   */
  subscriberId: () => string;
  /** Version and environment details assembled by the main process. */
  appInfo: () => Promise<AppInfo>;
  /** Writes plain text to the system clipboard. */
  writeClipboard: (text: string) => void;
}

const NoArgs = z.tuple([]);
const IdArgs = z.tuple([ProjectIdSchema]);
const PositionSchema = z.number().int().min(0).max(10_000);
const DIRECTORY_PURPOSES = [
  'project',
  'terminal',
  'default-directory',
  'session',
  'skill',
] as const;
type DirectoryPurpose = (typeof DIRECTORY_PURPOSES)[number];
const ChoosePurposeArgs = z.union([z.tuple([]), z.tuple([z.enum(DIRECTORY_PURPOSES)])]);
const DIALOG_TITLES: Record<DirectoryPurpose, string> = {
  project: 'Select project directory',
  terminal: 'Open terminal in folder',
  'default-directory': 'Select default terminal directory',
  session: 'Select session workspace',
  skill: 'Select a skill folder or a folder of skills',
};
const TerminalArgs = z.tuple([TerminalIdSchema]);
const SessionArgs = z.tuple([AtlasSessionIdSchema]);
const SessionTaskArgs = z.tuple([AtlasSessionIdSchema, SessionTaskIdSchema]);
const ViewIdSchema = z.string().regex(TERMINAL_VIEW_ID_PATTERN, 'Invalid view identifier.');

/**
 * Registers the narrowly scoped IPC surface used by the renderer.
 * Every payload is validated here, independently of renderer-side validation,
 * and again by the Engine.
 */
export function registerIpcHandlers(deps: IpcDependencies): () => void {
  const { engine, logger } = deps;
  // Output subscribers are scoped to the current renderer document and one view.
  const viewSubscriber = (viewId: string) => `${deps.subscriberId()}:${viewId}`;
  // Paths the user picked through the native dialog. Renderer-supplied paths
  // are accepted only if they came from this set (SDD-001 FR-002).
  const pickedPaths = new Set<string>();

  const assertPicked = (workspacePath: string | undefined) => {
    if (workspacePath !== undefined && !pickedPaths.has(workspacePath)) {
      throw new AtlasError('PROJECT_PATH_INVALID', 'Path was not selected through the picker.', {
        details: { reason: 'path-not-picked' },
      });
    }
  };

  const handle = <T>(
    channel: string,
    argsSchema: z.ZodType<unknown[]>,
    run: (args: unknown[]) => Promise<T>,
  ) => {
    deps.ipcMain.handle(channel, async (event, ...rawArgs): Promise<IpcResult<T>> => {
      try {
        if (!deps.isTrustedSender(event)) {
          logger.warn('Rejected IPC call from untrusted sender', { channel });
          throw new AtlasError('INTERNAL_ERROR', 'Untrusted IPC sender.');
        }
        const args = parseInput(argsSchema, rawArgs);
        return { ok: true, data: await run(args) };
      } catch (error) {
        const serialized = toSerializedError(error);
        const level =
          serialized.code === 'INTERNAL_ERROR' || serialized.code === 'PROJECT_PERSISTENCE_ERROR'
            ? 'error'
            : 'info';
        logger[level]('IPC request failed', { channel, error: describeError(error) });
        return { ok: false, error: serialized };
      }
    });
  };

  /** Fire-and-forget channel: failures are logged, never echoed to the renderer. */
  const on = (
    channel: string,
    argsSchema: z.ZodType<unknown[]>,
    run: (args: unknown[]) => Promise<unknown>,
  ) => {
    deps.ipcMain.on(channel, (event, ...rawArgs) => {
      if (!deps.isTrustedSender(event)) {
        logger.warn('Rejected IPC message from untrusted sender', { channel });
        return;
      }
      const parsed = argsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        logger.warn('Rejected invalid IPC message', { channel });
        return;
      }
      run(parsed.data).catch((error: unknown) => {
        const code = toSerializedError(error).code;
        // Input racing with a process exit is expected and not worth an error.
        const level =
          code === 'TERMINAL_NOT_RUNNING' || code === 'TERMINAL_NOT_FOUND' ? 'debug' : 'warn';
        logger[level]('IPC message failed', { channel, error: describeError(error) });
      });
    });
  };

  // Projects (SDD-001)
  handle(IPC_CHANNELS.listProjects, NoArgs, () => engine.call('projects.list'));
  handle(IPC_CHANNELS.getProject, IdArgs, ([id]) => engine.call('projects.get', id as string));
  handle(IPC_CHANNELS.createProject, z.tuple([z.unknown()]), async ([rawInput]) => {
    const input = parseInput(CreateProjectInputSchema, rawInput);
    assertPicked(input.workspacePath);
    return engine.call('projects.create', input);
  });
  handle(IPC_CHANNELS.updateProject, z.tuple([ProjectIdSchema, z.unknown()]), async ([id, raw]) => {
    const input = parseInput(UpdateProjectInputSchema, raw);
    assertPicked(input.workspacePath);
    return engine.call('projects.update', id as string, input);
  });
  handle(IPC_CHANNELS.removeProject, IdArgs, ([id]) =>
    engine.call('projects.remove', id as string),
  );
  handle(IPC_CHANNELS.selectProject, IdArgs, ([id]) =>
    engine.call('projects.select', id as string),
  );
  handle(IPC_CHANNELS.getSelectedProject, NoArgs, () => engine.call('projects.getSelected'));
  handle(
    IPC_CHANNELS.chooseDirectory,
    ChoosePurposeArgs,
    async ([purpose]): Promise<DirectoryChoice> => {
      const result = await deps.showOpenDialog({
        title: DIALOG_TITLES[(purpose as DirectoryPurpose | undefined) ?? 'project'],
        buttonLabel: 'Select',
        properties: ['openDirectory', 'createDirectory'],
      });
      const selected = result.filePaths[0];
      if (result.canceled || selected === undefined) {
        return { canceled: true };
      }
      const inspection = await engine.call('projects.inspectPath', selected);
      pickedPaths.add(inspection.inputPath);
      if (inspection.resolvedPath !== undefined) pickedPaths.add(inspection.resolvedPath);
      return { canceled: false, inspection };
    },
  );

  // Terminals. Directories from the renderer must have been chosen in the native picker.
  handle(
    IPC_CHANNELS.listTerminals,
    z.union([z.tuple([]), z.tuple([ProjectIdSchema.optional()])]),
    ([projectId]) =>
      engine.call(
        'terminals.list',
        projectId === undefined ? {} : { projectId: projectId as string },
      ),
  );
  handle(IPC_CHANNELS.createTerminal, z.tuple([z.unknown()]), async ([raw]) => {
    const input = parseInput(CreateTerminalInputSchema, raw);
    assertPicked(input.cwd);
    return engine.call('terminals.create', input);
  });
  handle(
    IPC_CHANNELS.renameTerminal,
    z.tuple([TerminalIdSchema, TerminalCustomTitleSchema]),
    ([id, title]) => engine.call('terminals.rename', id as string, title as string | null),
  );
  handle(
    IPC_CHANNELS.associateTerminal,
    z.tuple([TerminalIdSchema, ProjectIdSchema.nullable()]),
    ([id, projectId]) =>
      engine.call('terminals.associate', id as string, projectId as string | null),
  );
  handle(
    IPC_CHANNELS.moveTerminal,
    z.tuple([TerminalIdSchema, TerminalGroupIdSchema.nullable(), PositionSchema]),
    ([id, groupId, position]) =>
      engine.call('terminals.move', id as string, groupId as string | null, position as number),
  );
  handle(IPC_CHANNELS.terminalProjectContext, TerminalArgs, ([id]) =>
    engine.call('terminals.projectContext', id as string),
  );
  handle(IPC_CHANNELS.terminalGit, TerminalArgs, ([id]) =>
    engine.call('terminals.git', id as string),
  );
  handle(
    IPC_CHANNELS.registerTerminalProject,
    z.tuple([TerminalIdSchema, z.unknown()]),
    ([id, input]) => engine.call('terminals.registerProject', id as string, input),
  );
  handle(IPC_CHANNELS.terminateTerminal, TerminalArgs, ([id]) =>
    engine.call('terminals.terminate', id as string),
  );
  handle(IPC_CHANNELS.restartTerminal, TerminalArgs, ([id]) =>
    engine.call('terminals.restart', id as string),
  );
  handle(IPC_CHANNELS.dismissTerminal, TerminalArgs, ([id]) =>
    engine.call('terminals.dismiss', id as string),
  );
  handle(IPC_CHANNELS.terminalCloseInfo, TerminalArgs, ([id]) =>
    engine.call('terminals.closeInfo', id as string),
  );
  handle(IPC_CHANNELS.clearTerminal, TerminalArgs, ([id]) =>
    engine.call('terminals.clear', id as string),
  );
  handle(
    IPC_CHANNELS.attachTerminal,
    z.tuple([TerminalIdSchema, ViewIdSchema, TerminalColumnsSchema, TerminalRowsSchema]),
    ([id, viewId, columns, rows]) =>
      engine.call(
        'terminals.attach',
        id as string,
        viewSubscriber(viewId as string),
        columns as number,
        rows as number,
      ),
  );
  handle(IPC_CHANNELS.detachTerminal, z.tuple([TerminalIdSchema, ViewIdSchema]), ([id, viewId]) =>
    engine.call('terminals.detach', id as string, viewSubscriber(viewId as string)),
  );
  handle(IPC_CHANNELS.listShells, NoArgs, () => engine.call('terminals.shells'));
  handle(IPC_CHANNELS.getTerminalPreferences, NoArgs, () =>
    engine.call('terminals.getPreferences'),
  );
  handle(IPC_CHANNELS.setTerminalPreferences, z.tuple([z.unknown()]), async ([raw]) => {
    const input = parseInput(UpdateTerminalPreferencesSchema, raw);
    assertPicked(input.defaultWorkingDirectory ?? undefined);
    return engine.call('terminals.setPreferences', input);
  });
  handle(IPC_CHANNELS.getTerminalLayout, z.tuple([TerminalWorkspaceKeySchema]), ([workspace]) =>
    engine.call('terminals.getLayout', workspace as string),
  );
  handle(
    IPC_CHANNELS.setTerminalLayout,
    z.tuple([TerminalWorkspaceKeySchema, z.unknown()]),
    ([workspace, layout]) => engine.call('terminals.setLayout', workspace as string, layout),
  );

  // Terminal groups
  handle(IPC_CHANNELS.listGroups, NoArgs, () => engine.call('groups.list'));
  handle(IPC_CHANNELS.createGroup, z.tuple([TerminalGroupNameSchema]), ([name]) =>
    engine.call('groups.create', name as string),
  );
  handle(
    IPC_CHANNELS.renameGroup,
    z.tuple([TerminalGroupIdSchema, TerminalGroupNameSchema]),
    ([id, name]) => engine.call('groups.rename', id as string, name as string),
  );
  handle(
    IPC_CHANNELS.setGroupCollapsed,
    z.tuple([TerminalGroupIdSchema, z.boolean()]),
    ([id, collapsed]) => engine.call('groups.setCollapsed', id as string, collapsed as boolean),
  );
  handle(
    IPC_CHANNELS.moveGroup,
    z.tuple([TerminalGroupIdSchema, PositionSchema]),
    ([id, position]) => engine.call('groups.move', id as string, position as number),
  );
  handle(
    IPC_CHANNELS.deleteGroup,
    z.tuple([TerminalGroupIdSchema, z.strictObject({ terminateTerminals: z.boolean() })]),
    ([id, options]) =>
      engine.call('groups.delete', id as string, options as { terminateTerminals: boolean }),
  );

  // Git and application information
  handle(IPC_CHANNELS.projectGit, IdArgs, ([projectId]) =>
    engine.call('git.project', projectId as string),
  );
  handle(IPC_CHANNELS.appInfo, NoArgs, () => deps.appInfo());
  // Shared context and AI sessions (SDD-005): IPC arguments are the Engine method's
  // parameters, validated here with the same schemas and again by the Engine.
  const contextChannels: [string, EngineMethod][] = [
    [IPC_CHANNELS.contextOverview, 'context.overview'],
    [IPC_CHANNELS.contextList, 'context.list'],
    [IPC_CHANNELS.contextGlobal, 'context.global'],
    [IPC_CHANNELS.contextRecord, 'context.record'],
    [IPC_CHANNELS.contextUpdate, 'context.update'],
    [IPC_CHANNELS.contextRemove, 'context.remove'],
    [IPC_CHANNELS.contextHistory, 'context.history'],
    [IPC_CHANNELS.contextTasks, 'context.tasks'],
    [IPC_CHANNELS.contextCreateTask, 'context.createTask'],
    [IPC_CHANNELS.contextUpdateTask, 'context.updateTask'],
    [IPC_CHANNELS.contextDeleteTask, 'context.deleteTask'],
    [IPC_CHANNELS.contextDecisions, 'context.decisions'],
    [IPC_CHANNELS.contextCreateDecision, 'context.createDecision'],
    [IPC_CHANNELS.contextSetDecisionStatus, 'context.setDecisionStatus'],
    [IPC_CHANNELS.contextBundle, 'context.bundle'],
    [IPC_CHANNELS.contextSnapshot, 'context.snapshot'],
    [IPC_CHANNELS.contextHealth, 'context.health'],
    [IPC_CHANNELS.contextReconcile, 'context.reconcile'],
    [IPC_CHANNELS.contextBudgets, 'context.budgets'],
    [IPC_CHANNELS.contextSetBudgets, 'context.setBudgets'],
    [IPC_CHANNELS.contextPrepareHandoff, 'context.prepareHandoff'],
    [IPC_CHANNELS.contextCreateHandoff, 'context.createHandoff'],
    [IPC_CHANNELS.contextHandoffs, 'context.handoffs'],
    [IPC_CHANNELS.contextHandoff, 'context.handoff'],
    [IPC_CHANNELS.contextSessions, 'context.sessions'],
    [IPC_CHANNELS.contextSessionEvidence, 'context.sessionEvidence'],
    [IPC_CHANNELS.contextEndSession, 'context.endSession'],
    [IPC_CHANNELS.contextSessionForTerminal, 'context.sessionForTerminal'],
    [IPC_CHANNELS.contextProjectConfig, 'context.projectConfig'],
    [IPC_CHANNELS.contextSetProjectConfig, 'context.setProjectConfig'],
    [IPC_CHANNELS.aiStart, 'ai.start'],
    [IPC_CHANNELS.aiAttach, 'ai.attach'],
  ];
  for (const [channel, method] of contextChannels) {
    handle(channel, ENGINE_METHOD_PARAMS[method] as unknown as z.ZodType<unknown[]>, (args) =>
      (engine.call as (name: string, ...params: unknown[]) => Promise<unknown>)(method, ...args),
    );
  }

  // Skills Hub (SDD-006 Milestone B): arguments are the Engine method's parameters.
  const skillChannels: [string, EngineMethod][] = [
    [IPC_CHANNELS.skillsList, 'skills.list'],
    [IPC_CHANNELS.skillsDetails, 'skills.details'],
    [IPC_CHANNELS.skillsSuggestions, 'skills.suggestions'],
    [IPC_CHANNELS.skillsSources, 'skills.sources'],
    [IPC_CHANNELS.skillsSetSourceEnabled, 'skills.setSourceEnabled'],
    [IPC_CHANNELS.skillsRemoveSource, 'skills.removeSource'],
    [IPC_CHANNELS.skillsDiscover, 'skills.discover'],
    [IPC_CHANNELS.skillsTemplates, 'skills.templates'],
    [IPC_CHANNELS.skillsCreateFromTemplate, 'skills.createFromTemplate'],
    [IPC_CHANNELS.skillsEdit, 'skills.edit'],
    [IPC_CHANNELS.skillsReadFile, 'skills.readFile'],
    [IPC_CHANNELS.skillsDiff, 'skills.diff'],
    [IPC_CHANNELS.skillsValidate, 'skills.validate'],
    [IPC_CHANNELS.skillsSetEnabled, 'skills.setEnabled'],
    [IPC_CHANNELS.skillsAssign, 'skills.assign'],
    [IPC_CHANNELS.skillsUnassign, 'skills.unassign'],
    [IPC_CHANNELS.skillsRemove, 'skills.remove'],
    [IPC_CHANNELS.skillsResolve, 'skills.resolve'],
    [IPC_CHANNELS.skillsSyncTargets, 'skills.syncTargets'],
    [IPC_CHANNELS.skillsSyncPreview, 'skills.syncPreview'],
    [IPC_CHANNELS.skillsSyncApply, 'skills.syncApply'],
    [IPC_CHANNELS.skillsSyncHistory, 'skills.syncHistory'],
    [IPC_CHANNELS.skillsSyncRollback, 'skills.syncRollback'],
  ];
  for (const [channel, method] of skillChannels) {
    handle(channel, ENGINE_METHOD_PARAMS[method] as unknown as z.ZodType<unknown[]>, (args) =>
      (engine.call as (name: string, ...params: unknown[]) => Promise<unknown>)(method, ...args),
    );
  }
  // Folders are read only when chosen in the native picker (`explicit`) or when they are
  // inside a skill source the user added; the renderer cannot claim either.
  const picked = (folder: string) => pickedPaths.has(folder);
  handle(IPC_CHANNELS.skillsAddSource, z.tuple([AddSkillSourceSchema]), ([input]) => {
    const value = input as AddSkillSourceInput;
    return engine.call('skills.addSource', value, picked(value.path));
  });
  handle(IPC_CHANNELS.skillsInspect, z.tuple([InspectSkillSchema.shape.path]), ([folder]) =>
    engine.call('skills.inspect', { path: folder as string }, picked(folder as string)),
  );
  // Sync writes into these folders: only picked or Engine-suggested folders are accepted.
  handle(IPC_CHANNELS.skillsSetSyncTargets, z.tuple([SkillSyncTargetsSchema]), async ([input]) => {
    const changes = input as Record<string, string | null | undefined>;
    const suggested = new Set((await engine.call('skills.suggestions')).map((item) => item.path));
    for (const folder of Object.values(changes)) {
      if (typeof folder === 'string' && !picked(folder) && !suggested.has(folder)) {
        throw new AtlasError('SKILL_SOURCE_UNAUTHORIZED');
      }
    }
    return engine.call('skills.setSyncTargets', changes);
  });
  handle(
    IPC_CHANNELS.skillsInspectCollection,
    z.tuple([InspectSkillSchema.shape.path]),
    ([folder]) =>
      engine.call('skills.inspectCollection', { path: folder as string }, picked(folder as string)),
  );
  handle(IPC_CHANNELS.skillsImportCollection, z.tuple([ImportSkillCollectionSchema]), ([input]) => {
    const value = input as ImportSkillCollectionInput;
    return engine.call('skills.importCollection', value, picked(value.path));
  });
  handle(IPC_CHANNELS.skillsImport, z.tuple([ImportSkillSchema]), ([input]) => {
    const value = input as ImportSkillInput;
    return engine.call('skills.import', value, picked(value.path));
  });

  handle(IPC_CHANNELS.copyText, z.tuple([z.string().max(1_000_000)]), async ([text]) => {
    deps.writeClipboard(text as string);
    return null;
  });

  // Git workflow (SDD-004). The Engine only accepts repository roots it resolved
  // from registered projects or open terminals.
  const RootArgs = z.tuple([GitRepositoryRootSchema]);
  const gitCall = (
    channel: string,
    schema: z.ZodType<unknown[]>,
    method: Parameters<EngineCaller['call']>[0],
  ) =>
    handle(channel, schema, (args) =>
      (engine.call as (method: string, ...params: unknown[]) => Promise<unknown>)(method, ...args),
    );
  gitCall(IPC_CHANNELS.gitRepositories, NoArgs, 'git.repositories');
  gitCall(IPC_CHANNELS.gitWorkingTree, RootArgs, 'git.workingTree');
  gitCall(IPC_CHANNELS.gitDiff, z.tuple([GitDiffInputSchema]), 'git.diff');
  gitCall(IPC_CHANNELS.gitStage, z.tuple([GitPathsInputSchema]), 'git.stage');
  gitCall(IPC_CHANNELS.gitUnstage, z.tuple([GitPathsInputSchema]), 'git.unstage');
  gitCall(IPC_CHANNELS.gitCommit, z.tuple([GitCommitInputSchema]), 'git.commit');
  gitCall(IPC_CHANNELS.gitPush, z.tuple([GitPushInputSchema]), 'git.push');
  gitCall(IPC_CHANNELS.gitPull, z.tuple([GitPullInputSchema]), 'git.pull');
  gitCall(IPC_CHANNELS.gitPullInfo, RootArgs, 'git.pullInfo');
  gitCall(IPC_CHANNELS.gitFetch, z.tuple([GitFetchInputSchema]), 'git.fetch');
  gitCall(IPC_CHANNELS.gitBranches, RootArgs, 'git.branches');
  gitCall(IPC_CHANNELS.gitRemotes, RootArgs, 'git.remotes');
  gitCall(IPC_CHANNELS.gitCreateBranch, z.tuple([GitCreateBranchInputSchema]), 'git.createBranch');
  gitCall(IPC_CHANNELS.gitSwitchBranch, z.tuple([GitSwitchBranchInputSchema]), 'git.switchBranch');
  gitCall(IPC_CHANNELS.gitRenameBranch, z.tuple([GitRenameBranchInputSchema]), 'git.renameBranch');
  gitCall(IPC_CHANNELS.gitSuggestMessage, z.tuple([GitPathsInputSchema]), 'git.suggestMessage');
  gitCall(IPC_CHANNELS.gitOperations, NoArgs, 'git.operations');
  gitCall(IPC_CHANNELS.gitCommitContext, RootArgs, 'git.commitContext');
  gitCall(IPC_CHANNELS.gitMergePreview, z.tuple([GitMergeInputSchema]), 'git.mergePreview');
  gitCall(IPC_CHANNELS.gitMerge, z.tuple([GitMergeInputSchema]), 'git.merge');
  gitCall(IPC_CHANNELS.gitAbortMerge, RootArgs, 'git.abortMerge');
  gitCall(
    IPC_CHANNELS.gitCherryPickPreview,
    z.tuple([GitMergeInputSchema]),
    'git.cherryPickPreview',
  );
  gitCall(IPC_CHANNELS.gitCherryPick, z.tuple([GitCherryPickInputSchema]), 'git.cherryPick');
  gitCall(IPC_CHANNELS.gitContinueCherryPick, RootArgs, 'git.continueCherryPick');
  gitCall(IPC_CHANNELS.gitSkipCherryPick, RootArgs, 'git.skipCherryPick');
  gitCall(IPC_CHANNELS.gitAbortCherryPick, RootArgs, 'git.abortCherryPick');
  gitCall(IPC_CHANNELS.gitGetProjectSettings, IdArgs, 'git.getProjectSettings');
  gitCall(
    IPC_CHANNELS.gitSetProjectSettings,
    z.tuple([ProjectIdSchema, ProjectGitSettingsSchema]),
    'git.setProjectSettings',
  );
  gitCall(IPC_CHANNELS.gitCancelOperation, z.tuple([GitOperationIdSchema]), 'git.cancelOperation');
  gitCall(IPC_CHANNELS.gitOperationLog, z.tuple([GitOperationLogQuerySchema]), 'git.operationLog');
  gitCall(
    IPC_CHANNELS.gitOperationDetails,
    z.tuple([GitOperationIdSchema]),
    'git.operationDetails',
  );
  gitCall(IPC_CHANNELS.gitReflog, z.tuple([GitReflogInputSchema]), 'git.reflog');
  gitCall(IPC_CHANNELS.gitCommitFiles, z.tuple([GitCommitFilesInputSchema]), 'git.commitFiles');
  gitCall(IPC_CHANNELS.gitLogSettings, NoArgs, 'git.logSettings');
  gitCall(
    IPC_CHANNELS.gitSetLogSettings,
    z.tuple([UpdateGitOperationLogSettingsSchema]),
    'git.setLogSettings',
  );
  gitCall(IPC_CHANNELS.gitGetPreferences, NoArgs, 'git.getPreferences');
  gitCall(
    IPC_CHANNELS.gitSetPreferences,
    z.tuple([UpdateGitPreferencesSchema]),
    'git.setPreferences',
  );

  // ATLAS Sessions (SDD-003 Milestone B). Workspace directories must come from the picker.
  handle(
    IPC_CHANNELS.listSessions,
    z.union([z.tuple([]), z.tuple([ListSessionsInputSchema])]),
    ([filter]) => engine.call('sessions.list', (filter ?? {}) as { includeArchived?: boolean }),
  );
  handle(IPC_CHANNELS.getSession, SessionArgs, ([id]) => engine.call('sessions.get', id as string));
  handle(IPC_CHANNELS.createSession, z.tuple([z.unknown()]), async ([raw]) => {
    const input = parseInput(CreateSessionInputSchema, raw);
    assertPicked(input.workspacePath);
    return engine.call('sessions.create', input);
  });
  handle(
    IPC_CHANNELS.updateSession,
    z.tuple([AtlasSessionIdSchema, z.unknown()]),
    async ([id, raw]) => {
      const input = parseInput(UpdateSessionInputSchema, raw);
      assertPicked(input.workspacePath ?? undefined);
      return engine.call('sessions.update', id as string, input);
    },
  );
  handle(
    IPC_CHANNELS.performSessionAction,
    z.tuple([AtlasSessionIdSchema, SessionActionSchema]),
    ([id, action]) =>
      engine.call('sessions.perform', id as string, action as z.infer<typeof SessionActionSchema>),
  );
  handle(IPC_CHANNELS.sessionEvents, SessionArgs, ([id]) =>
    engine.call('sessions.events', id as string),
  );
  handle(IPC_CHANNELS.addSessionTask, z.tuple([AtlasSessionIdSchema, z.unknown()]), ([id, input]) =>
    engine.call('sessions.addTask', id as string, input),
  );
  handle(
    IPC_CHANNELS.updateSessionTask,
    z.tuple([AtlasSessionIdSchema, SessionTaskIdSchema, z.unknown()]),
    ([id, taskId, input]) =>
      engine.call('sessions.updateTask', id as string, taskId as string, input),
  );
  handle(IPC_CHANNELS.removeSessionTask, SessionTaskArgs, ([id, taskId]) =>
    engine.call('sessions.removeTask', id as string, taskId as string),
  );
  handle(IPC_CHANNELS.cancelSessionTask, SessionTaskArgs, ([id, taskId]) =>
    engine.call('sessions.cancelTask', id as string, taskId as string),
  );
  handle(IPC_CHANNELS.getSessionSettings, NoArgs, () => engine.call('sessions.getSettings'));
  handle(IPC_CHANNELS.setSessionSettings, z.tuple([z.unknown()]), ([input]) =>
    engine.call('sessions.setSettings', input),
  );

  on(
    IPC_SEND_CHANNELS.writeTerminal,
    z.tuple([TerminalIdSchema, TerminalInputDataSchema]),
    ([id, data]) => engine.call('terminals.write', id as string, data as string),
  );
  on(
    IPC_SEND_CHANNELS.resizeTerminal,
    z.tuple([TerminalIdSchema, TerminalColumnsSchema, TerminalRowsSchema]),
    ([id, columns, rows]) =>
      engine.call('terminals.resize', id as string, columns as number, rows as number),
  );
  on(
    IPC_SEND_CHANNELS.acknowledgeTerminal,
    z.tuple([TerminalIdSchema, ViewIdSchema, z.number().int().min(0).max(1e9)]),
    ([id, viewId, characters]) =>
      engine.call(
        'terminals.ack',
        id as string,
        viewSubscriber(viewId as string),
        characters as number,
      ),
  );

  return () => {
    for (const channel of Object.values(IPC_CHANNELS)) deps.ipcMain.removeHandler(channel);
    for (const channel of Object.values(IPC_SEND_CHANNELS))
      deps.ipcMain.removeAllListeners(channel);
  };
}
