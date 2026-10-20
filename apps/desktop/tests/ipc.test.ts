import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPC_CHANNELS, type IpcResult, type DirectoryChoice, type Project } from '@atlas/contracts';
import { createEngine, type Engine } from '@atlas/engine';
import { createTempDir } from '../../../tests/support/temp.js';
import { registerIpcHandlers } from '../src/main/ipc.js';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcResult<unknown>>;

describe('desktop IPC handlers', () => {
  let temp: ReturnType<typeof createTempDir>;
  let engine: Engine;
  let handlers: Map<string, Handler>;
  let trusted: boolean;
  let pickedPath: string | undefined;
  let workspace: string;

  const trustedEvent = {} as IpcMainInvokeEvent;
  const invoke = <T>(channel: string, ...args: unknown[]) =>
    handlers.get(channel)!(trustedEvent, ...args) as Promise<IpcResult<T>>;

  beforeEach(() => {
    temp = createTempDir();
    workspace = path.join(temp.dir, 'workspace');
    mkdirSync(workspace);
    engine = createEngine({ dataDir: path.join(temp.dir, 'data') });
    handlers = new Map();
    trusted = true;
    pickedPath = workspace;
    registerIpcHandlers({
      ipcMain: {
        handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
        removeHandler: (channel: string) => handlers.delete(channel),
      } as never,
      engine,
      isTrustedSender: () => trusted,
      showOpenDialog: async () =>
        pickedPath === undefined
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [pickedPath] },
    });
  });
  afterEach(() => {
    engine.close();
    temp.cleanup();
  });

  it('registers exactly the declared channels', () => {
    expect([...handlers.keys()].sort()).toEqual(Object.values(IPC_CHANNELS).sort());
  });

  it('creates a project from a directory chosen in the native picker', async () => {
    const choice = await invoke<DirectoryChoice>(IPC_CHANNELS.chooseDirectory);
    expect(choice).toMatchObject({ ok: true, data: { canceled: false } });
    const inspection = (choice as { data: DirectoryChoice }).data.inspection!;

    const created = await invoke<Project>(IPC_CHANNELS.createProject, {
      name: 'Workspace',
      workspacePath: inspection.inputPath,
    });
    expect(created).toMatchObject({ ok: true, data: { workspacePath: workspace } });
  });

  it('reports a cancelled picker', async () => {
    pickedPath = undefined;
    await expect(invoke(IPC_CHANNELS.chooseDirectory)).resolves.toEqual({
      ok: true,
      data: { canceled: true },
    });
  });

  it('rejects paths that were not chosen through the picker', async () => {
    const result = await invoke(IPC_CHANNELS.createProject, {
      name: 'Sneaky',
      workspacePath: workspace,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'PROJECT_PATH_INVALID' } });
    expect(await engine.projects.findAll()).toEqual([]);
  });

  it('rejects untrusted senders', async () => {
    trusted = false;
    const result = await invoke(IPC_CHANNELS.listProjects);
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('validates payload shape and extra arguments', async () => {
    expect(await invoke(IPC_CHANNELS.getProject, 42)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(await invoke(IPC_CHANNELS.listProjects, 'extra')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(
      await invoke(IPC_CHANNELS.createProject, { name: 'x', workspacePath: workspace, id: 'mine' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('returns user-safe errors without internal details', async () => {
    const result = await invoke(IPC_CHANNELS.getProject, '00000000-0000-4000-8000-000000000000');
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'The project could not be found. It may have been removed.',
        issues: [],
      },
    });
  });

  it('updates metadata without requiring a new directory', async () => {
    await invoke(IPC_CHANNELS.chooseDirectory);
    const created = (await invoke<Project>(IPC_CHANNELS.createProject, {
      name: 'W',
      workspacePath: workspace,
    })) as { ok: true; data: Project };
    const updated = await invoke(IPC_CHANNELS.updateProject, created.data.id, {
      name: 'Renamed',
      tags: ['a'],
    });
    expect(updated).toMatchObject({ ok: true, data: { name: 'Renamed', tags: ['a'] } });
  });
});
