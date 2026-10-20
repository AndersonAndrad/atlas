import {
  CreateProjectInputSchema,
  IPC_CHANNELS,
  ProjectIdSchema,
  UpdateProjectInputSchema,
  parseInput,
  type DirectoryChoice,
  type IpcResult,
} from '@atlas/contracts';
import type { Engine } from '@atlas/engine';
import { AtlasError, describeError, toSerializedError } from '@atlas/shared';
import type {
  IpcMain,
  IpcMainInvokeEvent,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from 'electron';
import { z } from 'zod';

export interface IpcDependencies {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  engine: Engine;
  /** Returns true when the event comes from a trusted ATLAS window and frame. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
}

const NoArgs = z.tuple([]);
const IdArgs = z.tuple([ProjectIdSchema]);

/**
 * Registers the narrowly scoped IPC surface used by the renderer.
 * Every payload is validated here, independently of renderer-side validation.
 */
export function registerIpcHandlers(deps: IpcDependencies): () => void {
  const { engine } = deps;
  const { projects } = engine;
  // Paths the user picked through the native dialog. Renderer-supplied paths
  // are accepted only if they came from this set (FR-002).
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
          engine.logger.warn('Rejected IPC call from untrusted sender', { channel });
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
        engine.logger[level]('IPC request failed', { channel, error: describeError(error) });
        return { ok: false, error: serialized };
      }
    });
  };

  handle(IPC_CHANNELS.listProjects, NoArgs, () => projects.listDetails());

  handle(IPC_CHANNELS.getProject, IdArgs, ([id]) => projects.getDetails(id as string));

  handle(IPC_CHANNELS.createProject, z.tuple([z.unknown()]), async ([rawInput]) => {
    const input = parseInput(CreateProjectInputSchema, rawInput);
    assertPicked(input.workspacePath);
    return projects.create(input);
  });

  handle(IPC_CHANNELS.updateProject, z.tuple([ProjectIdSchema, z.unknown()]), async ([id, raw]) => {
    const input = parseInput(UpdateProjectInputSchema, raw);
    assertPicked(input.workspacePath);
    return projects.update(id as string, input);
  });

  handle(IPC_CHANNELS.removeProject, IdArgs, async ([id]) => {
    await projects.remove(id as string);
    return null;
  });

  handle(IPC_CHANNELS.selectProject, IdArgs, async ([id]) => {
    await projects.selectProject(id as string);
    return null;
  });

  handle(IPC_CHANNELS.getSelectedProject, NoArgs, async () => {
    const selected = await projects.getSelectedProject();
    return selected === null ? null : projects.getDetails(selected.id);
  });

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
    const inspection = await projects.inspectPath(selected);
    pickedPaths.add(inspection.inputPath);
    if (inspection.resolvedPath !== undefined) pickedPaths.add(inspection.resolvedPath);
    return { canceled: false, inspection };
  });

  return () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      deps.ipcMain.removeHandler(channel);
    }
  };
}
