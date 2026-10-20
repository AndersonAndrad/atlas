import {
  CreateProjectInputSchema,
  CreateTerminalInputSchema,
  IPC_CHANNELS,
  IPC_SEND_CHANNELS,
  TERMINAL_VIEW_ID_PATTERN,
  ProjectIdSchema,
  TerminalColumnsSchema,
  TerminalIdSchema,
  TerminalInputDataSchema,
  TerminalRowsSchema,
  TerminalTitleSchema,
  UpdateProjectInputSchema,
  parseInput,
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
}

const NoArgs = z.tuple([]);
const IdArgs = z.tuple([ProjectIdSchema]);
const TerminalArgs = z.tuple([TerminalIdSchema]);
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
  handle(IPC_CHANNELS.chooseDirectory, NoArgs, async (): Promise<DirectoryChoice> => {
    const result = await deps.showOpenDialog({
      title: 'Select project directory',
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
  });

  // Terminals (SDD-002). Working directories are never accepted from the renderer.
  handle(
    IPC_CHANNELS.listTerminals,
    z.union([z.tuple([]), z.tuple([ProjectIdSchema.optional()])]),
    ([projectId]) =>
      engine.call(
        'terminals.list',
        projectId === undefined ? {} : { projectId: projectId as string },
      ),
  );
  handle(IPC_CHANNELS.createTerminal, z.tuple([z.unknown()]), ([raw]) =>
    engine.call('terminals.create', parseInput(CreateTerminalInputSchema, raw)),
  );
  handle(
    IPC_CHANNELS.renameTerminal,
    z.tuple([TerminalIdSchema, TerminalTitleSchema]),
    ([id, title]) => engine.call('terminals.rename', id as string, title as string),
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
  handle(IPC_CHANNELS.setTerminalPreferences, z.tuple([z.unknown()]), ([input]) =>
    engine.call('terminals.setPreferences', input),
  );
  handle(IPC_CHANNELS.getTerminalLayout, IdArgs, ([projectId]) =>
    engine.call('terminals.getLayout', projectId as string),
  );
  handle(
    IPC_CHANNELS.setTerminalLayout,
    z.tuple([ProjectIdSchema, z.unknown()]),
    ([projectId, layout]) => engine.call('terminals.setLayout', projectId as string, layout),
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
