import {
  CLI_ENGINE_METHODS,
  ENGINE_METHOD_PARAMS,
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
  const { projects } = engine;

  const handlers: {
    [M in EngineMethod]: (
      params: never,
    ) => Promise<EngineMethodResults[M]> | EngineMethodResults[M];
  } = {
    'engine.status': () => ({
      dataDir: engine.dataDir,
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
    'terminals.rename': ([id, title]: [string, string]) => terminals().rename(id, title),
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
    'terminals.setPreferences': ([input]: [unknown]) =>
      engine.terminalSettings.updatePreferences(input),
    'terminals.getLayout': ([projectId]: [string]) => engine.terminalSettings.getLayout(projectId),
    'terminals.setLayout': async ([projectId, layout]: [string, unknown]) => {
      await projects.getDetails(projectId);
      await engine.terminalSettings.setLayout(projectId, layout);
      return null;
    },
    'terminals.closeAllInfo': () => terminals().closeAllInfo(),
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
