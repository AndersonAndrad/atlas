import {
  CLI_ENGINE_METHODS,
  type AddSkillSourceInput,
  type AiProvider,
  type CreateSkillFromTemplateInput,
  type EditSkillInput,
  type ImportSkillCollectionInput,
  type ImportSkillInput,
  type RemoveSkillAssignmentInput,
  type ResolveSkillsInput,
  type SkillAssignmentInput,
  type AttachTerminalInput,
  type ParsedContextBundleRequest,
  type UpdateContextBudgetSettings,
  type ContextQuery,
  type ContextTarget,
  type CreateContextEntryInput,
  type CreateContextTaskInput,
  type CreateDecisionInput,
  type CreateHandoffInput,
  type SessionSummaryInput,
  type StartAiSessionInput,
  type UpdateContextEntryInput,
  type UpdateContextTaskInput,
  type UpdateProjectAiConfig,
  ENGINE_METHOD_PARAMS,
  UNGROUPED_WORKSPACE,
  parseInput,
  type CreateProjectInput,
  type CreateTerminalInput,
  type EngineMethod,
  type EngineMethodResults,
  type GitCommitInput,
  type GitCreateBranchInput,
  type GitDiffInput,
  type GitFetchInput,
  type GitCherryPickInput,
  type GitMergeInput,
  type GitPathsInput,
  type GitPullInput,
  type GitPushInput,
  type GitReflogInput,
  type GitCommitFilesInput,
  type ProjectQuickCommandSettings,
  type QuickCommandInput,
  type QuickCommandMove,
  type RunQuickCommandInput,
  type UpdateGitOperationLogSettings,
  type GitRenameBranchInput,
  type GitSwitchBranchInput,
  type UpdateProjectInput,
} from '@atlas/contracts';
import { deterministicSuggestionProvider } from '@atlas/conventional-commits';
import type { GitOperationLogFilter } from '@atlas/git';
import { AtlasError } from '@atlas/shared';
import type { ResolvedTarget } from '@atlas/context';
import type { TerminalService } from '@atlas/terminal';
import type { Engine } from '../engine.js';

/** Who is calling: the desktop main process, or a local CLI over the socket. */
export type EngineCallerScope = 'desktop' | 'cli';

export interface EngineDispatcher {
  /** Validates and executes one Engine request. Throws AtlasError on failure. */
  call(method: string, params: unknown, scope: EngineCallerScope): Promise<unknown>;
}

type Handler = (params: never, scope: EngineCallerScope) => Promise<unknown> | unknown;

/**
 * Maps Engine methods to services. Every request is validated here, regardless
 * of the transport it came from, and CLI callers are limited to an allow-list.
 */
export function createEngineDispatcher(engine: Engine): EngineDispatcher {
  const terminals = (): TerminalService => {
    if (engine.terminals === undefined) {
      throw new AtlasError('ENGINE_UNAVAILABLE', 'Terminal runtime is not enabled.');
    }
    return engine.terminals;
  };
  const groups = () => {
    if (engine.terminalGroups === undefined) {
      throw new AtlasError('ENGINE_UNAVAILABLE', 'Terminal runtime is not enabled.');
    }
    return engine.terminalGroups;
  };
  const { projects, gitWorkspace: gitService } = engine;
  const { context } = engine;
  /** Context requests are always scoped to a target the Engine authorized (FR-507). */
  const target = (value: ContextTarget) => engine.resolveContextTarget(value);
  const maybeTarget = async (value: ContextTarget | null) =>
    value === null ? null : engine.resolveContextTarget(value);
  /** Keeps project context files current after a change; never delays or fails the call. */
  const changed = <T>(resolved: ResolvedTarget | null, result: T): T => {
    void engine.contextChanged(resolved);
    return result;
  };
  /** Git workflow requests only reach repositories the Engine resolved itself. */
  const repo = (repositoryRoot: string) => engine.requireGitRepository(repositoryRoot);
  const { skills } = engine;

  const handlers: {
    [M in EngineMethod]: (
      params: never,
      scope: EngineCallerScope,
    ) => Promise<EngineMethodResults[M]> | EngineMethodResults[M];
  } = {
    'engine.status': () => ({
      engineVersion: engine.engineVersion,
      dataDir: engine.dataDir,
      logFile: engine.logFile,
      schemaVersion: engine.schemaVersion(),
      pid: process.pid,
      activeTerminals: engine.terminals?.activeCount() ?? 0,
    }),

    'projects.list': () => projects.listDetails(),
    'projects.get': ([id]: [string]) => projects.getDetails(id),
    'projects.create': ([input]: [CreateProjectInput]) => projects.create(input),
    'projects.update': ([id, input]: [string, UpdateProjectInput]) => projects.update(id, input),
    'projects.remove': async ([id]: [string]) => {
      await engine.removeProject(id);
      return null;
    },
    'projects.select': async ([id]: [string]) => {
      await projects.selectProject(id);
      return null;
    },
    'projects.getSelected': async () => {
      const selected = await projects.getSelectedProject();
      return selected === null ? null : projects.getDetails(selected.id);
    },
    'projects.inspectPath': ([inputPath]: [string]) => projects.inspectPath(inputPath),

    'terminals.list': ([filter]: [{ projectId?: string }]) => terminals().list(filter.projectId),
    'terminals.get': ([id]: [string]) => terminals().getById(id),
    'terminals.create': ([input]: [CreateTerminalInput]) => terminals().create(input),
    'terminals.write': ([id, data]: [string, string]) => {
      terminals().write(id, data);
      return null;
    },
    'terminals.resize': ([id, columns, rows]: [string, number, number]) => {
      terminals().resize(id, columns, rows);
      return null;
    },
    'terminals.rename': ([id, title]: [string, string | null]) => terminals().rename(id, title),
    'terminals.associate': ([id, projectId]: [string, string | null]) =>
      terminals().associate(id, projectId),
    'terminals.move': ([id, groupId, position]: [string, string | null, number]) =>
      terminals().move(id, groupId, position),
    'terminals.projectContext': ([id]: [string]) => engine.terminalProjectContext(id),
    'terminals.git': ([id]: [string]) => engine.terminalGit(id),
    'terminals.registerProject': ([id, input]: [string, unknown]) =>
      engine.registerProjectFromTerminal(id, input),
    'terminals.detachProject': async ([projectId]: [string]) => {
      await terminals().detachProject(projectId);
      return null;
    },
    'terminals.terminate': ([id]: [string]) => terminals().terminate(id),
    'terminals.restart': ([id]: [string]) => terminals().restart(id),
    'terminals.dismiss': async ([id]: [string]) => {
      await terminals().dismiss(id);
      return null;
    },
    'terminals.closeInfo': ([id]: [string]) => terminals().closeInfo(id),
    'terminals.clear': ([id]: [string]) => {
      terminals().clear(id);
      return null;
    },
    'terminals.attach': ([id, subscriberId, columns, rows]: [string, string, number, number]) =>
      terminals().attach(id, subscriberId, columns, rows),
    'terminals.detach': ([id, subscriberId]: [string, string]) => {
      terminals().detach(id, subscriberId);
      return null;
    },
    'terminals.detachSubscriber': ([subscriberId]: [string]) => {
      terminals().detachSubscriber(subscriberId);
      return null;
    },
    'terminals.ack': ([id, subscriberId, characters]: [string, string, number]) => {
      terminals().acknowledge(id, subscriberId, characters);
      return null;
    },
    'terminals.shells': () => terminals().shellCatalog(),
    'terminals.getPreferences': () => engine.terminalSettings.getPreferences(),
    'terminals.setPreferences': ([input]: [unknown]) => engine.updateTerminalPreferences(input),
    'terminals.getLayout': ([workspace]: [string]) => engine.terminalSettings.getLayout(workspace),
    'terminals.setLayout': async ([workspace, layout]: [string, unknown]) => {
      if (workspace !== UNGROUPED_WORKSPACE && !(await groups().exists(workspace))) {
        throw new AtlasError('VALIDATION_FAILED', 'The terminal group does not exist.');
      }
      await engine.terminalSettings.setLayout(workspace, layout);
      return null;
    },
    'terminals.closeAllInfo': () => terminals().closeAllInfo(),

    'groups.list': () => groups().list(),
    'groups.create': ([name]: [string]) => groups().create(name),
    'groups.rename': ([id, name]: [string, string]) => groups().rename(id, name),
    'groups.setCollapsed': ([id, collapsed]: [string, boolean]) =>
      groups().setCollapsed(id, collapsed),
    'groups.move': ([id, position]: [string, number]) => groups().move(id, position),
    'groups.delete': async ([id, options]: [string, { terminateTerminals: boolean }]) => {
      await groups().delete(id, options);
      return null;
    },

    'git.project': ([projectId]: [string]) => engine.projectGit(projectId),
    'git.repositories': () => engine.gitRepositories(),
    'git.workingTree': async ([root]: [string]) => gitService.workingTree(await repo(root)),
    'git.diff': async ([{ repositoryRoot, ...input }]: [GitDiffInput]) =>
      gitService.diff(await repo(repositoryRoot), input),
    'git.stage': async ([input]: [GitPathsInput]) =>
      gitService.stage(await repo(input.repositoryRoot), input.paths),
    'git.unstage': async ([input]: [GitPathsInput]) =>
      gitService.unstage(await repo(input.repositoryRoot), input.paths),
    'git.commit': async ([input]: [GitCommitInput]) => {
      const root = await repo(input.repositoryRoot);
      // Steps and enforcement come from stored settings, never from the request.
      const checks = await engine.gitCommitChecks(root, input.projectId);
      return gitService.commit(input, await engine.gitPreferences.commitRules(), checks);
    },
    'git.push': async ([input]: [GitPushInput]) =>
      gitService.push(await repo(input.repositoryRoot), input.setUpstream),
    'git.pull': async ([input]: [GitPullInput]) =>
      gitService.pull(await repo(input.repositoryRoot), input.mode),
    'git.pullInfo': async ([root]: [string]) => gitService.pullInfo(await repo(root)),
    'git.fetch': async ([input]: [GitFetchInput]) =>
      gitService.fetch(await repo(input.repositoryRoot), input.remote),
    'git.branches': async ([root]: [string]) => gitService.branches(await repo(root)),
    'git.remotes': async ([root]: [string]) => gitService.remotes(await repo(root)),
    'git.createBranch': async ([{ repositoryRoot, ...input }]: [GitCreateBranchInput]) =>
      gitService.createBranch(await repo(repositoryRoot), input),
    'git.switchBranch': async ([{ repositoryRoot, ...input }]: [GitSwitchBranchInput]) =>
      gitService.switchBranch(await repo(repositoryRoot), input),
    'git.renameBranch': async ([{ repositoryRoot, ...input }]: [GitRenameBranchInput]) =>
      gitService.renameBranch(await repo(repositoryRoot), input),
    'git.suggestMessage': async ([input]: [GitPathsInput]) => {
      const root = await repo(input.repositoryRoot);
      if ((await engine.gitPreferences.get()).suggestions === 'off') return null;
      return deterministicSuggestionProvider.suggest(
        await gitService.suggestionInput(root, input.paths),
      );
    },
    'git.operations': () => engine.gitOperations.list(),
    'git.cancelOperation': ([id]: [string]) => engine.gitOperations.cancel(id),
    'git.operationLog': ([query]: [GitOperationLogFilter]) => engine.gitOperationLog.list(query),
    'git.operationDetails': ([id]: [string]) => engine.gitOperationLog.details(id),
    'git.reflog': async ([input]: [Required<GitReflogInput>]) => {
      const root = await repo(input.repositoryRoot);
      return engine.gitOperationLog.attribute(
        root,
        await gitService.reflog(root, input.limit, input.query),
      );
    },
    'git.commitFiles': async ([input]: [GitCommitFilesInput]) =>
      gitService.commitFiles(await repo(input.repositoryRoot), input.hash),
    'git.logSettings': () => engine.gitOperationLog.settings(),
    'git.setLogSettings': ([changes]: [UpdateGitOperationLogSettings]) =>
      engine.gitOperationLog.updateSettings(changes),
    'git.mergePreview': async ([input]: [GitMergeInput]) =>
      gitService.mergePreview(await repo(input.repositoryRoot), input.branch),
    'git.merge': async ([input]: [GitMergeInput]) =>
      gitService.merge(await repo(input.repositoryRoot), input.branch),
    'git.abortMerge': async ([root]: [string]) => gitService.abortMerge(await repo(root)),
    'git.cherryPickPreview': async ([input]: [GitMergeInput]) =>
      gitService.cherryPickPreview(await repo(input.repositoryRoot), input.branch),
    'git.cherryPick': async ([input]: [GitCherryPickInput]) =>
      gitService.cherryPick({ ...input, repositoryRoot: await repo(input.repositoryRoot) }),
    'git.continueCherryPick': async ([root]: [string]) =>
      gitService.continueCherryPick(await repo(root)),
    'git.skipCherryPick': async ([root]: [string]) => gitService.skipCherryPick(await repo(root)),
    'git.abortCherryPick': async ([root]: [string]) => gitService.abortCherryPick(await repo(root)),
    'git.commitContext': async ([root]: [string]) => engine.gitCommitContext(await repo(root)),
    'git.getProjectSettings': async ([projectId]: [string]) => {
      await projects.getDetails(projectId);
      const { settings, invalid } = await engine.projectGitSettings.read(projectId);
      return invalid ? { ...settings, settingsInvalid: true } : settings;
    },
    'git.setProjectSettings': async ([projectId, input]: [string, unknown]) => {
      await projects.getDetails(projectId);
      return engine.projectGitSettings.set(projectId, input);
    },
    'git.getPreferences': async () => {
      const { preferences, invalid } = await engine.gitPreferences.read();
      return invalid ? { ...preferences, invalid: true } : preferences;
    },
    'git.setPreferences': ([input]: [unknown]) => engine.gitPreferences.update(input),

    'sessions.list': ([filter]: [unknown]) => engine.sessions.list(filter),
    'sessions.get': ([id]: [string]) => engine.sessions.getDetails(id),
    'sessions.create': ([input]: [unknown]) => engine.sessions.create(input),
    'sessions.update': ([id, input]: [string, unknown]) => engine.sessions.update(id, input),
    'sessions.perform': ([id, action]: [string, string]) => engine.sessions.perform(id, action),
    'sessions.tasks': ([id]: [string]) => engine.sessions.tasks(id),
    'sessions.events': ([id]: [string]) => engine.sessions.events(id),
    'sessions.addTask': ([id, input]: [string, unknown]) => engine.sessions.addTask(id, input),
    'sessions.updateTask': ([id, taskId, input]: [string, string, unknown]) =>
      engine.sessions.updateTask(id, taskId, input),
    'sessions.removeTask': async ([id, taskId]: [string, string]) => {
      await engine.sessions.removeTask(id, taskId);
      return null;
    },
    'sessions.cancelTask': ([id, taskId]: [string, string]) =>
      engine.sessions.cancelTask(id, taskId),
    'context.overview': async ([value]: [ContextTarget]) => context.overview(await target(value)),
    'context.list': async ([{ target: value, ...query }]: [ContextQuery]) =>
      context.list(await target(value), query),
    'context.global': ([search]: [string]) => context.listGlobal(search || undefined),
    'context.record': async ([input]: [CreateContextEntryInput], scope) => {
      const resolved = await maybeTarget(input.target);
      return changed(resolved, await context.record(resolved, input, scope));
    },
    'context.update': async (
      [value, id, input]: [ContextTarget | null, string, UpdateContextEntryInput],
      scope,
    ) => {
      const resolved = await maybeTarget(value);
      return changed(resolved, await context.update(resolved, id, input, scope));
    },
    'context.remove': async ([value, id]: [ContextTarget | null, string]) => {
      const resolved = await maybeTarget(value);
      await context.remove(resolved, id);
      return changed(resolved, null);
    },
    'context.history': async ([value, id]: [ContextTarget | null, string]) =>
      context.history(await maybeTarget(value), id),
    'context.tasks': async ([value]: [ContextTarget]) => context.listTasks(await target(value)),
    'context.createTask': async ([input]: [CreateContextTaskInput]) => {
      const resolved = await target(input.target);
      return changed(resolved, await context.createTask(resolved, input));
    },
    'context.updateTask': async ([value, id, input]: [
      ContextTarget,
      string,
      UpdateContextTaskInput,
    ]) => {
      const resolved = await target(value);
      return changed(resolved, await context.updateTask(resolved, id, input));
    },
    'context.deleteTask': async ([value, id]: [ContextTarget, string]) => {
      const resolved = await target(value);
      await context.deleteTask(resolved, id);
      return changed(resolved, null);
    },
    'context.decisions': async ([value]: [ContextTarget]) =>
      context.listDecisions(await target(value)),
    'context.createDecision': async ([input]: [Required<CreateDecisionInput>], scope) => {
      const resolved = await target(input.target);
      return changed(resolved, await context.createDecision(resolved, input, scope));
    },
    'context.setDecisionStatus': async ([value, id, status]: [
      ContextTarget,
      string,
      'ACTIVE' | 'REJECTED',
    ]) => {
      const resolved = await target(value);
      return changed(resolved, await context.setDecisionStatus(resolved, id, status));
    },
    'context.bundle': async ([{ target: value, ...request }]: [ParsedContextBundleRequest]) =>
      context.bundle(await target(value), request),
    'context.snapshot': async ([value, taskId]: [ContextTarget, string | null]) =>
      context.snapshot(await target(value), taskId ?? undefined),
    'context.health': async ([value]: [ContextTarget]) => context.health(await target(value)),
    'context.reconcile': async ([value]: [ContextTarget]) => context.reconcile(await target(value)),
    'context.budgets': () => context.budgets.get(),
    'context.setBudgets': ([changes]: [UpdateContextBudgetSettings]) =>
      context.budgets.update(changes),
    'context.prepareHandoff': async ([value, request]: [
      ContextTarget,
      { taskId?: string; sourceSessionId?: string },
    ]) => context.prepareHandoff(await target(value), request),
    'context.createHandoff': async ([input]: [Required<CreateHandoffInput>]) =>
      context.createHandoff(await target(input.target), input),
    'context.handoffs': async ([value]: [ContextTarget]) =>
      context.listHandoffs(await target(value)),
    'context.handoff': async ([value, id]: [ContextTarget, string]) => {
      const resolved = await target(value);
      const handoff = await context.getHandoff(resolved, id);
      return { handoff, markdown: context.renderHandoff(resolved, handoff) };
    },
    'context.sessions': async ([value]: [ContextTarget]) =>
      context.listSessions(await target(value)),
    'context.sessionEvidence': async ([value, id]: [ContextTarget, string]) =>
      context.sessionEvidence(await target(value), id),
    'context.endSession': async (
      [value, id, summary]: [ContextTarget, string, Required<SessionSummaryInput>],
      scope,
    ) => {
      const resolved = await target(value);
      return changed(resolved, await context.endSession(resolved, id, summary, scope));
    },
    'context.sessionForTerminal': ([terminalId]: [string]) =>
      context.sessionForTerminal(terminalId),
    'ai.start': ([input]: [StartAiSessionInput]) => engine.startAiSession(input),
    'quickCommands.list': () => engine.quickCommands.list(),
    'quickCommands.create': ([input]: [QuickCommandInput]) => engine.quickCommands.create(input),
    'quickCommands.update': ([id, input]: [string, QuickCommandInput]) =>
      engine.quickCommands.update(id, input),
    'quickCommands.remove': ([id]: [string]) => engine.quickCommands.remove(id),
    'quickCommands.move': ([id, direction]: [string, QuickCommandMove]) =>
      engine.quickCommands.move(id, direction),
    'quickCommands.projectSettings': async ([projectId]: [string]) => {
      await projects.getDetails(projectId);
      return engine.quickCommands.projectSettings(projectId);
    },
    'quickCommands.setProjectSettings': async ([projectId, settings]: [
      string,
      ProjectQuickCommandSettings,
    ]) => {
      await projects.getDetails(projectId);
      return engine.quickCommands.setProjectSettings(projectId, settings);
    },
    'quickCommands.run': ([input]: [RunQuickCommandInput]) => engine.runQuickCommand(input),
    'projects.actions': async ([projectId]: [string]) => {
      await projects.getDetails(projectId);
      return engine.quickCommands.projectActions(projectId);
    },
    'ai.attach': ([input]: [AttachTerminalInput]) => engine.attachTerminalSession(input),
    'context.projectConfig': ([projectId]: [string]) => engine.projectConfigView(projectId),
    'context.setProjectConfig': ([projectId, changes]: [string, UpdateProjectAiConfig]) =>
      engine.setProjectConfig(projectId, changes),
    // Skills Hub. `explicit`: the user chose this exact folder (native picker, set by the
    // desktop main process, or a CLI argument).
    'skills.list': () => skills.listSkills(),
    'skills.details': ([id]: [string]) => skills.details(id),
    'skills.suggestions': () => skills.suggestions(),
    'skills.sources': () => skills.listSources(),
    'skills.addSource': ([input, explicit]: [AddSkillSourceInput, boolean], scope) =>
      skills.addSource(input, scope === 'cli' || explicit),
    'skills.setSourceEnabled': async ([id, enabled]: [string, boolean]) => {
      await skills.setSourceEnabled(id, enabled);
      return null;
    },
    'skills.removeSource': async ([id]: [string]) => {
      await skills.removeSource(id);
      return null;
    },
    'skills.discover': () => skills.discover(),
    'skills.inspect': ([input, explicit]: [{ path: string }, boolean], scope) =>
      skills.inspect(input.path, scope === 'cli' || explicit),
    'skills.import': ([input, explicit]: [ImportSkillInput, boolean], scope) =>
      skills.import(input, scope === 'cli' || explicit),
    'skills.inspectCollection': ([input, explicit]: [{ path: string }, boolean], scope) =>
      skills.inspectCollection(input.path, scope === 'cli' || explicit),
    'skills.importCollection': ([input, explicit]: [ImportSkillCollectionInput, boolean], scope) =>
      skills.importCollection(input, scope === 'cli' || explicit),
    'skills.templates': () => skills.templates(),
    'skills.createFromTemplate': ([input]: [CreateSkillFromTemplateInput]) =>
      skills.createFromTemplate(input),
    'skills.edit': ([input]: [EditSkillInput]) => skills.edit(input),
    'skills.readFile': ([input]: [{ skillId: string; sequence: number; path: string }]) =>
      skills.readFile(input.skillId, input.sequence, input.path),
    'skills.diff': ([input]: [{ skillId: string; from: number; to: number }]) =>
      skills.diff(input.skillId, input.from, input.to),
    'skills.validate': ([id]: [string]) => skills.validate(id),
    'skills.setEnabled': ([id, enabled]: [string, boolean]) => skills.setEnabled(id, enabled),
    'skills.assign': ([input]: [SkillAssignmentInput]) => skills.assign(input),
    'skills.unassign': ([input]: [RemoveSkillAssignmentInput]) => skills.unassign(input),
    'skills.remove': async ([id]: [string]) => {
      await skills.remove(id);
      return null;
    },
    'skills.resolve': ([input]: [ResolveSkillsInput]) => skills.resolve(input),
    'skills.syncTargets': () => skills.syncTargets(),
    'skills.setSyncTargets': ([changes]: [unknown]) => skills.setSyncTargets(changes),
    'skills.syncPreview': ([provider]: [AiProvider]) => skills.syncPreview(provider),
    'skills.syncApply': ([provider]: [AiProvider]) => skills.syncApply(provider),
    'skills.syncHistory': () => skills.syncHistory(),
    'skills.syncRollback': ([batchId]: [string]) => skills.syncRollback(batchId),
    // Usage (SDD-008 Milestone B). `explicit`: the folder was chosen in the native picker.
    'usage.overview': ([query]: [unknown]) => engine.usage.overview(query),
    'usage.refresh': async ([profileId]: [string | null]) => {
      await engine.usage.refresh(profileId);
      return null;
    },
    'usage.addProfile': ([input, explicit]: [unknown, boolean], scope) =>
      engine.usage.addProfile(input, scope === 'cli' || explicit),
    'usage.updateProfile': ([id, changes]: [string, unknown]) =>
      engine.usage.updateProfile(id, changes),
    'usage.removeProfile': async ([id]: [string]) => {
      await engine.usage.removeProfile(id);
      return null;
    },
    'usage.setSettings': ([changes]: [unknown]) => engine.usage.updateSettings(changes),
    // Preflight (SDD-007 Milestone A). `explicit`: the folder was chosen in the native picker.
    'preflight.workspaces': () => engine.preflight.listWorkspaces(),
    'preflight.openProject': ([projectId]: [string]) => engine.preflight.openProject(projectId),
    'preflight.addFolder': ([folder, explicit]: [string, boolean]) =>
      engine.preflight.addFolder(folder, explicit),
    'preflight.removeWorkspace': async ([id]: [string]) => {
      await engine.preflight.removeWorkspace(id);
      return null;
    },
    'preflight.workspace': ([id]: [string]) => engine.preflight.workspace(id),
    'preflight.saveConfig': ([id, config]: [string, unknown]) =>
      engine.preflight.saveConfig(id, config),
    'preflight.discover': ([id]: [string]) => engine.preflight.discover(id),
    'preflight.environment': ([refresh]: [boolean]) => engine.preflight.environment(refresh),
    'preflight.plan': ([selection]: [unknown]) => engine.preflight.plan(selection),
    'preflight.start': ([input]: [unknown]) => engine.preflight.start(input),
    'preflight.cancel': async ([runId]: [string]) => {
      await engine.preflight.cancel(runId);
      return null;
    },
    'preflight.runs': ([query]: [unknown]) => engine.preflight.runs(query),
    'preflight.run': ([runId]: [string]) => engine.preflight.run(runId),
    'preflight.output': ([query]: [unknown]) => engine.preflight.output(query),
    'preflight.report': ([runId]: [string]) => engine.preflight.report(runId),
    'sessions.getSettings': () => engine.sessionSettings.get(),
    'sessions.setSettings': ([input]: [unknown]) => engine.sessionSettings.update(input),
  };

  return {
    async call(method, params, scope) {
      if (!Object.hasOwn(ENGINE_METHOD_PARAMS, method)) {
        throw new AtlasError('VALIDATION_FAILED', 'Unknown Engine method.', {
          details: { method },
        });
      }
      const name = method as EngineMethod;
      if (scope === 'cli' && !CLI_ENGINE_METHODS.includes(name)) {
        throw new AtlasError('VALIDATION_FAILED', 'Method not available to this client.', {
          details: { method: name, scope },
        });
      }
      const args = parseInput(ENGINE_METHOD_PARAMS[name], params);
      const handler = handlers[name] as Handler;
      return handler(args as never, scope);
    },
  };
}
