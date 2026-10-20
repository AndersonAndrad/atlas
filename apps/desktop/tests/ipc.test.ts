import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IPC_CHANNELS,
  IPC_SEND_CHANNELS,
  type AtlasSession,
  type AtlasSessionDetails,
  type DirectoryChoice,
  type GitOperation,
  type GitRepositoryEntry,
  type GitWorkingTree,
  type IpcResult,
  type Project,
  type TerminalAttachment,
  type TerminalEvent,
  type TerminalSession,
} from '@atlas/contracts';
import { createEngine, createEngineDispatcher, type Engine } from '@atlas/engine';
import { noopLogger } from '@atlas/shared';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createTempDir } from '../../../tests/support/temp.js';
import type { EngineCaller } from '../src/main/engine-client.js';
import { registerIpcHandlers } from '../src/main/ipc.js';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcResult<unknown>>;
type Listener = (event: IpcMainEvent, ...args: unknown[]) => void;

describe('desktop IPC handlers', () => {
  let temp: ReturnType<typeof createTempDir>;
  let engine: Engine;
  let handlers: Map<string, Handler>;
  let listeners: Map<string, Listener>;
  let spawner: FakePtySpawner;
  let events: { event: TerminalEvent; subscriberId: string | undefined }[];
  let trusted: boolean;
  let pickedPath: string | undefined;
  let workspace: string;

  const trustedEvent = {} as IpcMainInvokeEvent;
  const invoke = <T>(channel: string, ...args: unknown[]) =>
    handlers.get(channel)!(trustedEvent, ...args) as Promise<IpcResult<T>>;
  const send = (channel: string, ...args: unknown[]) =>
    listeners.get(channel)!({} as IpcMainEvent, ...args);
  const registerProject = async () => {
    await invoke(IPC_CHANNELS.chooseDirectory);
    const created = await invoke<Project>(IPC_CHANNELS.createProject, {
      name: 'W',
      workspacePath: workspace,
    });
    return (created as { ok: true; data: Project }).data;
  };

  beforeEach(async () => {
    temp = createTempDir();
    workspace = path.join(temp.dir, 'workspace');
    mkdirSync(workspace);
    spawner = new FakePtySpawner();
    engine = createEngine({
      dataDir: path.join(temp.dir, 'data'),
      terminals: {
        spawner,
        mirrors: new FakeMirrorFactory(),
        shells: new FakeShellProvider(),
      },
    });
    await engine.initialize();
    events = [];
    engine.terminals!.onEvent((event, subscriberId) => events.push({ event, subscriberId }));
    const dispatcher = createEngineDispatcher(engine);
    const caller: EngineCaller = {
      call: (method, ...params) => dispatcher.call(method, params, 'desktop') as never,
    };
    handlers = new Map();
    listeners = new Map();
    trusted = true;
    pickedPath = workspace;
    registerIpcHandlers({
      ipcMain: {
        handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
        removeHandler: (channel: string) => handlers.delete(channel),
        on: (channel: string, listener: Listener) => listeners.set(channel, listener),
        removeAllListeners: (channel: string) => listeners.delete(channel),
      } as never,
      engine: caller,
      logger: noopLogger,
      subscriberId: () => 'desktop-1-0',
      appInfo: async () => ({ desktopVersion: '0.4.0' }) as never,
      isTrustedSender: () => trusted,
      showOpenDialog: async () =>
        pickedPath === undefined
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [pickedPath] },
    });
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('registers exactly the declared channels', () => {
    expect([...handlers.keys()].sort()).toEqual(Object.values(IPC_CHANNELS).sort());
    expect([...listeners.keys()].sort()).toEqual(Object.values(IPC_SEND_CHANNELS).sort());
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

  describe('terminals', () => {
    it('starts terminals only in registered project directories', async () => {
      const project = await registerProject();
      const created = await invoke<TerminalSession>(IPC_CHANNELS.createTerminal, {
        projectId: project.id,
      });
      expect(created).toMatchObject({
        ok: true,
        data: { projectId: project.id, cwd: project.workspacePath, status: 'RUNNING' },
      });

      expect(
        await invoke(IPC_CHANNELS.createTerminal, { projectId: project.id, cwd: '/etc' }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(
        await invoke(IPC_CHANNELS.createTerminal, {
          projectId: '00000000-0000-4000-8000-000000000000',
        }),
      ).toMatchObject({ ok: false, error: { code: 'PROJECT_NOT_FOUND' } });
      expect(spawner.spawned).toHaveLength(1);
    });

    it('routes input to the PTY and output to the attached view only', async () => {
      const project = await registerProject();
      const created = (await invoke<TerminalSession>(IPC_CHANNELS.createTerminal, {
        projectId: project.id,
      })) as { ok: true; data: TerminalSession };
      const id = created.data.id;

      const attached = await invoke<TerminalAttachment>(
        IPC_CHANNELS.attachTerminal,
        id,
        'v1',
        90,
        20,
      );
      expect(attached).toMatchObject({ ok: true, data: { seq: 0 } });
      expect(spawner.last().resizes).toEqual([[90, 20]]);

      send(IPC_SEND_CHANNELS.writeTerminal, id, 'pwd\r');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(spawner.last().written).toEqual(['pwd\r']);

      spawner.last().emit('output');
      await new Promise((resolve) => setTimeout(resolve, 30));
      const output = events.filter((entry) => entry.event.type === 'output');
      expect(output.map((entry) => entry.subscriberId)).toEqual(['desktop-1-0:v1']);
    });

    it('ignores invalid or untrusted fire-and-forget messages', async () => {
      const project = await registerProject();
      const created = (await invoke<TerminalSession>(IPC_CHANNELS.createTerminal, {
        projectId: project.id,
      })) as { ok: true; data: TerminalSession };
      send(IPC_SEND_CHANNELS.writeTerminal, 'not-an-id', 'x');
      send(IPC_SEND_CHANNELS.resizeTerminal, created.data.id, 0, -1);
      trusted = false;
      send(IPC_SEND_CHANNELS.writeTerminal, created.data.id, 'rm -rf /\r');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(spawner.last().written).toEqual([]);
      expect(spawner.last().resizes).toEqual([]);
    });

    it('rejects malformed view identifiers', async () => {
      const project = await registerProject();
      const created = (await invoke<TerminalSession>(IPC_CHANNELS.createTerminal, {
        projectId: project.id,
      })) as { ok: true; data: TerminalSession };
      expect(
        await invoke(IPC_CHANNELS.attachTerminal, created.data.id, 'v1:other', 80, 24),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    });

    it('keeps the terminals of a removed project running, unassociated', async () => {
      const project = await registerProject();
      await invoke(IPC_CHANNELS.createTerminal, { projectId: project.id });
      expect(await invoke(IPC_CHANNELS.removeProject, project.id)).toEqual({
        ok: true,
        data: null,
      });
      expect(await invoke(IPC_CHANNELS.listTerminals)).toMatchObject({
        ok: true,
        data: [{ projectId: null, status: 'RUNNING' }],
      });
      expect(spawner.last().kills).toEqual([]);
    });

    it('accepts standalone directories only when chosen in the picker', async () => {
      const notPicked = await invoke(IPC_CHANNELS.createTerminal, { cwd: workspace });
      expect(notPicked).toMatchObject({ ok: false, error: { code: 'PROJECT_PATH_INVALID' } });

      await invoke(IPC_CHANNELS.chooseDirectory, 'terminal');
      const picked = await invoke<TerminalSession>(IPC_CHANNELS.createTerminal, { cwd: workspace });
      expect(picked).toMatchObject({ ok: true, data: { projectId: null, cwd: workspace } });

      // The default directory follows the same rule.
      pickedPath = path.join(temp.dir, 'data');
      expect(
        await invoke(IPC_CHANNELS.setTerminalPreferences, { defaultWorkingDirectory: '/etc' }),
      ).toMatchObject({ ok: false, error: { code: 'PROJECT_PATH_INVALID' } });
      expect(await invoke(IPC_CHANNELS.createTerminal, {})).toMatchObject({ ok: true });
    });

    it('manages groups and moves terminals without restarting them', async () => {
      const group = (await invoke<{ id: string }>(IPC_CHANNELS.createGroup, 'Dev')) as {
        ok: true;
        data: { id: string };
      };
      const project = await registerProject();
      const created = (await invoke<TerminalSession>(IPC_CHANNELS.createTerminal, {
        projectId: project.id,
      })) as { ok: true; data: TerminalSession };
      const moved = await invoke<TerminalSession>(
        IPC_CHANNELS.moveTerminal,
        created.data.id,
        group.data.id,
        0,
      );
      expect(moved).toMatchObject({
        ok: true,
        data: { groupId: group.data.id, pid: created.data.pid },
      });
      expect(spawner.spawned).toHaveLength(1);

      expect(await invoke(IPC_CHANNELS.renameTerminal, created.data.id, null)).toMatchObject({
        ok: true,
        data: { customTitle: null },
      });
      expect(
        await invoke(IPC_CHANNELS.deleteGroup, group.data.id, { terminateTerminals: false }),
      ).toEqual({ ok: true, data: null });
      expect(await invoke(IPC_CHANNELS.listGroups)).toEqual({ ok: true, data: [] });
      expect(await invoke(IPC_CHANNELS.createGroup, '')).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('exposes application information from the main process', async () => {
      expect(await invoke(IPC_CHANNELS.appInfo)).toEqual({
        ok: true,
        data: { desktopVersion: '0.4.0' },
      });
    });
  });

  describe('git workflow', () => {
    const gitRepository = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    };

    it('only accepts repositories resolved from projects or terminals', async () => {
      gitRepository(workspace);
      const outsider = path.join(temp.dir, 'outsider');
      gitRepository(outsider);
      // Not registered: refused even though it is a valid repository.
      expect(await invoke(IPC_CHANNELS.gitWorkingTree, outsider)).toMatchObject({
        ok: false,
        error: { code: 'GIT_REPOSITORY_UNAVAILABLE' },
      });

      const project = await registerProject();
      const repositories = await invoke<GitRepositoryEntry[]>(IPC_CHANNELS.gitRepositories);
      expect(repositories).toMatchObject({
        ok: true,
        data: [{ repositoryRoot: workspace, projectIds: [project.id], terminalIds: [] }],
      });
      const tree = await invoke<GitWorkingTree>(IPC_CHANNELS.gitWorkingTree, workspace);
      expect(tree).toMatchObject({
        ok: true,
        data: { files: [{ path: 'a.txt', unstaged: 'untracked' }] },
      });
      expect(await invoke(IPC_CHANNELS.gitWorkingTree, outsider)).toMatchObject({ ok: false });

      // Removing the project revokes access immediately.
      await invoke(IPC_CHANNELS.removeProject, project.id);
      expect(await invoke(IPC_CHANNELS.gitWorkingTree, workspace)).toMatchObject({
        ok: false,
        error: { code: 'GIT_REPOSITORY_UNAVAILABLE' },
      });
    });

    it('validates Git payloads and reports operations as events', async () => {
      gitRepository(workspace);
      await registerProject();
      for (const paths of [['../escape'], ['/etc/passwd'], []]) {
        expect(
          await invoke(IPC_CHANNELS.gitStage, { repositoryRoot: workspace, paths }),
        ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      }
      expect(
        await invoke(IPC_CHANNELS.gitPush, { repositoryRoot: workspace, force: true }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });

      const staged = await invoke<GitOperation>(IPC_CHANNELS.gitStage, {
        repositoryRoot: workspace,
        paths: ['a.txt'],
      });
      expect(staged).toMatchObject({ ok: true, data: { kind: 'stage', status: 'succeeded' } });
      const kinds = events.map(({ event }) => event.type);
      expect(kinds).toContain('git-operation');
      expect(kinds).toContain('git');
    });
  });

  describe('sessions', () => {
    it('accepts session workspaces only when chosen in the picker', async () => {
      const sneaky = await invoke(IPC_CHANNELS.createSession, {
        name: 'S',
        objective: 'x',
        workspacePath: workspace,
      });
      expect(sneaky).toMatchObject({ ok: false, error: { code: 'PROJECT_PATH_INVALID' } });

      await invoke(IPC_CHANNELS.chooseDirectory, 'session');
      const created = await invoke<AtlasSession>(IPC_CHANNELS.createSession, {
        name: 'S',
        objective: 'x',
        workspacePath: workspace,
      });
      expect(created).toMatchObject({ ok: true, data: { workspacePath: workspace } });
      const id = (created as { data: AtlasSession }).data.id;

      const edited = await invoke(IPC_CHANNELS.updateSession, id, {
        workspacePath: path.join(temp.dir, 'other'),
      });
      expect(edited).toMatchObject({ ok: false, error: { code: 'PROJECT_PATH_INVALID' } });
    });

    it('runs lifecycle actions and validates them', async () => {
      const project = await registerProject();
      const created = (await invoke<AtlasSession>(IPC_CHANNELS.createSession, {
        name: 'S',
        objective: 'x',
        projectId: project.id,
      })) as { data: AtlasSession };
      const id = created.data.id;
      expect(await invoke(IPC_CHANNELS.performSessionAction, id, 'complete')).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
      expect(await invoke(IPC_CHANNELS.performSessionAction, id, 'start')).toMatchObject({
        ok: false,
        error: { code: 'SESSION_TRANSITION_INVALID' },
      });
      await invoke(IPC_CHANNELS.performSessionAction, id, 'markReady');
      expect(await invoke(IPC_CHANNELS.performSessionAction, id, 'start')).toMatchObject({
        ok: true,
        data: { status: 'WAITING_EXECUTOR' },
      });
      const task = await invoke(IPC_CHANNELS.addSessionTask, id, { title: 'Plan' });
      expect(task).toMatchObject({ ok: true, data: { status: 'PENDING' } });
      const details = (await invoke<AtlasSessionDetails>(IPC_CHANNELS.getSession, id)) as {
        data: AtlasSessionDetails;
      };
      expect(details.data).toMatchObject({
        executing: false,
        workspace: { kind: 'project', projectId: project.id },
        availableActions: ['pause', 'cancel'],
      });
      expect(await invoke(IPC_CHANNELS.getSession, 'x', 'extra')).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
    });
  });
});
