import {
  CLI_ENGINE_METHODS,
  ENGINE_METHOD_PARAMS,
  UNGROUPED_WORKSPACE,
  parseInput,
  type CreateProjectInput,
  type CreateTerminalInput,
  type EngineMethod,
  type EngineMethodResults,
  type UpdateProjectInput,
} from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import type { TerminalService } from '@atlas/terminal';
import type { Engine } from '../engine.js';

/** Who is calling: the desktop main process, or a local CLI over the socket. */
export type EngineCallerScope = 'desktop' | 'cli';

export interface EngineDispatcher {
  /** Validates and executes one Engine request. Throws AtlasError on failure. */
  call(method: string, params: unknown, scope: EngineCallerScope): Promise<unknown>;
}

type Handler = (params: never) => Promise<unknown> | unknown;

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
  const { projects } = engine;

  const handlers: {
    [M in EngineMethod]: (
      params: never,
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
      return handler(args as never);
    },
  };
}
