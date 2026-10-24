import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GIT_PREFERENCES,
  DEFAULT_PROJECT_GIT_SETTINGS,
  IPC_CHANNELS,
  IPC_SEND_CHANNELS,
  type AtlasSession,
  type AtlasSessionDetails,
  type DirectoryChoice,
  type GitCommitContext,
  type GitOperation,
  type GitRepositoryEntry,
  type ProjectGitSettings,
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
  let copied: string[] = [];
  let saved: { suggestedName: string; text: string }[] = [];
  let revealed: string[] = [];
  let opened: string[] = [];

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
    saved = [];
    revealed = [];
    opened = [];
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
      writeClipboard: async (text: string, target: string) => {
        copied.push(target === 'clipboard' ? text : `${target}:${text}`);
      },
      readClipboard: async (target: string) =>
        target === 'selection' ? 'primary text' : 'clipboard text',
      saveTextFile: async (suggestedName: string, text: string) => {
        saved.push({ suggestedName, text });
        return true;
      },
      revealPath: (absolutePath: string) => revealed.push(absolutePath),
      openExternal: async (url: string) => {
        opened.push(url);
      },
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

  it('stores notes and reveals only files inside the project of the link', async () => {
    const project = await registerProject();
    writeFileSync(path.join(workspace, 'README.md'), '# W');
    const created = await invoke<{ id: string; revision: number }>(IPC_CHANNELS.notesCreate, {
      projectId: project.id,
      title: 'Decisions',
      content: 'See [readme](atlas:file/README.md)',
    });
    expect(created).toMatchObject({ ok: true, data: { revision: 1 } });
    expect(
      await invoke(IPC_CHANNELS.notesList, { scope: { kind: 'project', projectId: project.id } }),
    ).toMatchObject({ ok: true, data: { counts: { active: 1 }, notes: [{ title: 'Decisions' }] } });

    expect(
      await invoke(IPC_CHANNELS.notesRevealFile, {
        projectId: project.id,
        href: 'atlas:file/README.md',
      }),
    ).toEqual({ ok: true, data: null });
    expect(revealed).toEqual([path.join(realpathSync(workspace), 'README.md')]);
    for (const href of ['atlas:file/../data', 'atlas:file/missing.md', 'atlas:note/x']) {
      expect(
        await invoke(IPC_CHANNELS.notesRevealFile, { projectId: project.id, href }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }
    expect(revealed).toHaveLength(1);
  });

  it('opens only web and e-mail links of notes outside the app', async () => {
    for (const url of ['https://example.com/a', 'mailto:dev@example.com']) {
      expect(await invoke(IPC_CHANNELS.notesOpenExternal, url)).toEqual({ ok: true, data: null });
    }
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'x']) {
      expect(await invoke(IPC_CHANNELS.notesOpenExternal, url)).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
    }
    expect(opened).toEqual(['https://example.com/a', 'mailto:dev@example.com']);
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

  it('adds a Preflight folder only when it was chosen in the picker', async () => {
    const other = path.join(temp.dir, 'other');
    mkdirSync(other);
    expect(await invoke(IPC_CHANNELS.preflightAddFolder, other)).toMatchObject({
      ok: false,
      error: { code: 'PREFLIGHT_UNAUTHORIZED' },
    });
    await invoke(IPC_CHANNELS.chooseDirectory, 'preflight-workspace');
    const added = await invoke<{ id: string; path: string }>(
      IPC_CHANNELS.preflightAddFolder,
      workspace,
    );
    expect(added).toMatchObject({ ok: true, data: { path: workspace, projectId: null } });
    expect(await invoke(IPC_CHANNELS.preflightWorkspaces)).toMatchObject({
      ok: true,
      data: [{ path: workspace }],
    });
    // Configurations are validated in the Engine: a check cannot leave the workspace.
    const id = (added as { data: { id: string } }).data.id;
    const saved = await invoke(IPC_CHANNELS.preflightSaveConfig, id, {
      checks: [
        {
          id: 'x',
          name: 'x',
          type: 'COMMAND',
          category: 'CUSTOM',
          workingDirectory: '../..',
          command: 'true',
          packageManager: null,
          script: null,
          workflowPath: null,
          workflowJob: null,
          act: null,
          required: true,
          enabled: true,
          timeoutSeconds: 60,
          executionTriggers: ['MANUAL'],
          dependsOn: [],
          exclusive: false,
          requiredTools: [],
          env: {},
        },
      ],
      profiles: [],
    });
    expect(saved).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('saves text only through the save dialog, with a plain suggested name', async () => {
    expect(await invoke(IPC_CHANNELS.saveText, 'report.md', '# Report')).toEqual({
      ok: true,
      data: { saved: true },
    });
    expect(saved).toEqual([{ suggestedName: 'report.md', text: '# Report' }]);
    for (const name of ['../report.md', '/tmp/report.md', '.hidden', 'a/b.md']) {
      expect(await invoke(IPC_CHANNELS.saveText, name, 'x'), name).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
    }
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

    it('copies text to the clipboard through the main process', async () => {
      copied = [];
      expect(await invoke(IPC_CHANNELS.copyText, 'CONFLICT (content)')).toEqual({
        ok: true,
        data: null,
      });
      expect(copied).toEqual(['CONFLICT (content)']);
      expect(await invoke(IPC_CHANNELS.copyText, 'picked', 'selection')).toEqual({
        ok: true,
        data: null,
      });
      expect(copied).toEqual(['CONFLICT (content)', 'selection:picked']);
      expect(await invoke(IPC_CHANNELS.copyText, 42)).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
      expect(await invoke(IPC_CHANNELS.copyText, 'x', 'find')).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
    });

    it('reads clipboard text through the main process', async () => {
      expect(await invoke(IPC_CHANNELS.readText)).toEqual({ ok: true, data: 'clipboard text' });
      expect(await invoke(IPC_CHANNELS.readText, 'selection')).toEqual({
        ok: true,
        data: 'primary text',
      });
      expect(await invoke(IPC_CHANNELS.readText, 'files')).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
      trusted = false;
      expect(await invoke(IPC_CHANNELS.readText)).toMatchObject({ ok: false });
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

    it('rejects Git workflow methods from CLI clients and untrusted renderer frames', async () => {
      const dispatcher = createEngineDispatcher(engine);
      for (const method of [
        'git.commit',
        'git.commitContext',
        'git.getProjectSettings',
        'git.setProjectSettings',
      ]) {
        await expect(dispatcher.call(method, [], 'cli')).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
        });
      }
      trusted = false;
      expect(await invoke(IPC_CHANNELS.gitCommitContext, workspace)).toMatchObject({
        ok: false,
        error: { code: 'INTERNAL_ERROR' },
      });
    });

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

    it('stores per-project commit settings and removes them with the project', async () => {
      gitRepository(workspace);
      const project = await registerProject();
      const defaults = await invoke<ProjectGitSettings>(
        IPC_CHANNELS.gitGetProjectSettings,
        project.id,
      );
      expect(defaults).toEqual({
        ok: true,
        data: { enforceConventionalCommits: true, preCommitSteps: [] },
      });

      const step = {
        name: 'Tests',
        command: 'npm run test',
        mode: 'complete',
        timeoutSeconds: 600,
        readyAfterSeconds: 15,
        readyText: null,
      };
      const saved = await invoke<ProjectGitSettings>(
        IPC_CHANNELS.gitSetProjectSettings,
        project.id,
        {
          enforceConventionalCommits: false,
          preCommitSteps: [step],
        },
      );
      expect(saved).toMatchObject({ ok: true, data: { enforceConventionalCommits: false } });
      for (const invalid of [
        { enforceConventionalCommits: true, preCommitSteps: Array.from({ length: 6 }, () => step) },
        { enforceConventionalCommits: true, preCommitSteps: [{ ...step, command: 'a\nb' }] },
        { enforceConventionalCommits: true, preCommitSteps: [{ ...step, mode: 'shell' }] },
      ]) {
        expect(await invoke(IPC_CHANNELS.gitSetProjectSettings, project.id, invalid)).toMatchObject(
          { ok: false, error: { code: 'VALIDATION_FAILED' } },
        );
      }

      const context = await invoke<GitCommitContext>(IPC_CHANNELS.gitCommitContext, workspace);
      expect(context).toMatchObject({
        ok: true,
        data: { projects: [{ id: project.id, settings: { preCommitSteps: [step] } }] },
      });
      // A project that is not part of the repository is refused for commits.
      expect(
        await invoke(IPC_CHANNELS.gitCommit, {
          repositoryRoot: workspace,
          message: 'docs: x',
          stage: ['a.txt'],
          unstage: [],
          expectedFingerprint: '0'.repeat(64),
          push: false,
          projectId: '00000000-0000-4000-8000-000000000000',
        }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });

      await invoke(IPC_CHANNELS.removeProject, project.id);
      expect(await engine.projectGitSettings.get(project.id)).toEqual({
        enforceConventionalCommits: true,
        preCommitSteps: [],
      });
    });

    it('flags unreadable stored preferences and commit settings without changing them', async () => {
      gitRepository(workspace);
      const project = await registerProject();
      // Stored values that no longer match the contract, as left by a broken edit.
      const db = new DatabaseSync(path.join(temp.dir, 'data', 'atlas.db'));
      const store = db.prepare('INSERT INTO application_settings (key, value) VALUES (?, ?)');
      store.run('git.preferences', '{"headerMaxLength":"short"}');
      store.run(`git.project.${project.id}`, '{"preCommitSteps":"npm test"}');
      db.close();

      expect(await invoke(IPC_CHANNELS.gitGetPreferences)).toEqual({
        ok: true,
        data: { ...DEFAULT_GIT_PREFERENCES, invalid: true },
      });
      expect(await invoke(IPC_CHANNELS.gitGetProjectSettings, project.id)).toEqual({
        ok: true,
        data: { ...DEFAULT_PROJECT_GIT_SETTINGS, settingsInvalid: true },
      });

      // Saving replaces them; readable values carry no flag.
      await invoke(IPC_CHANNELS.gitSetPreferences, { requireScope: true });
      await invoke(IPC_CHANNELS.gitSetProjectSettings, project.id, DEFAULT_PROJECT_GIT_SETTINGS);
      expect(await invoke(IPC_CHANNELS.gitGetPreferences)).toEqual({
        ok: true,
        data: { ...DEFAULT_GIT_PREFERENCES, requireScope: true },
      });
      expect(await invoke(IPC_CHANNELS.gitGetProjectSettings, project.id)).toEqual({
        ok: true,
        data: DEFAULT_PROJECT_GIT_SETTINGS,
      });
    });

    it('includes newly registered projects in a previously discovered repository', async () => {
      gitRepository(workspace);
      const first = await registerProject();
      await invoke(IPC_CHANNELS.gitRepositories);
      const nested = path.join(workspace, 'nested');
      mkdirSync(nested);
      const second = await engine.projects.create({ workspacePath: nested, name: 'Nested' });
      await engine.projectGitSettings.set(second.id, {
        enforceConventionalCommits: false,
        preCommitSteps: [],
      });
      const context = await invoke<GitCommitContext>(IPC_CHANNELS.gitCommitContext, workspace);
      expect(context.ok).toBe(true);
      if (!context.ok) throw new Error('Commit context failed');
      expect(context.data.projects.map((project) => project.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      await expect(engine.gitCommitChecks(workspace)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      expect(await engine.gitCommitChecks(workspace, second.id)).toMatchObject({
        enforceConventionalCommits: false,
        cwd: nested,
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
      for (const commits of [[], ['HEAD'], ['abc']]) {
        expect(
          await invoke(IPC_CHANNELS.gitCherryPick, {
            repositoryRoot: workspace,
            branch: 'main',
            commits,
            recordOrigin: true,
          }),
        ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      }
      expect(
        await invoke(IPC_CHANNELS.gitCherryPickPreview, {
          repositoryRoot: path.join(temp.dir, 'elsewhere'),
          branch: 'main',
        }),
      ).toMatchObject({ ok: false });

      const staged = await invoke<GitOperation>(IPC_CHANNELS.gitStage, {
        repositoryRoot: workspace,
        paths: ['a.txt'],
      });
      expect(staged).toMatchObject({ ok: true, data: { kind: 'stage', status: 'succeeded' } });
      const kinds = events.map(({ event }) => event.type);
      expect(kinds).toContain('git-operation');
      expect(kinds).toContain('git');

      // The operation stays in the persistent log with the Git commands it ran.
      const okStaged = staged as { ok: true; data: GitOperation };
      const log = await invoke<{ operations: { id: string; commandCount: number }[] }>(
        IPC_CHANNELS.gitOperationLog,
        { repositoryRoot: workspace },
      );
      expect(log).toMatchObject({ ok: true, data: { operations: [{ id: okStaged.data.id }] } });
      expect(await invoke(IPC_CHANNELS.gitOperationDetails, okStaged.data.id)).toMatchObject({
        ok: true,
        data: {
          operation: { kind: 'stage' },
          commands: expect.arrayContaining([expect.objectContaining({ outcome: 'succeeded' })]),
        },
      });
      expect(await invoke(IPC_CHANNELS.gitOperationLog, { limit: 0 })).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
      expect(await invoke(IPC_CHANNELS.gitOperationDetails, 'not-an-id')).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
      expect(await invoke(IPC_CHANNELS.gitReflog, { repositoryRoot: workspace })).toMatchObject({
        ok: true,
      });
      expect(
        await invoke(IPC_CHANNELS.gitReflog, { repositoryRoot: path.join(temp.dir, 'outsider') }),
      ).toMatchObject({ ok: false });
      expect(await invoke(IPC_CHANNELS.gitSetLogSettings, { retentionDays: 0 })).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
      expect(await invoke(IPC_CHANNELS.gitLogSettings)).toMatchObject({
        ok: true,
        data: { retentionDays: 90, maxOperations: 5000 },
      });
    });
  });

  describe('shared context', () => {
    it('scopes context to authorized targets and starts AI sessions in terminals', async () => {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
      const project = await registerProject();
      const target = { projectId: project.id };
      const recorded = await invoke(IPC_CHANNELS.contextRecord, {
        target,
        scope: 'project',
        category: 'architecture',
        title: 'Hexagonal',
        body: 'Ports in core',
      });
      expect(recorded).toMatchObject({
        ok: true,
        data: { title: 'Hexagonal', verification: 'user' },
      });
      expect(await invoke(IPC_CHANNELS.contextList, { target })).toMatchObject({
        ok: true,
        data: [{ title: 'Hexagonal' }],
      });

      const outsider = path.join(temp.dir, 'outsider');
      mkdirSync(outsider);
      execFileSync('git', ['init', '-q'], { cwd: outsider });
      expect(
        await invoke(IPC_CHANNELS.contextList, { target: { workspacePath: outsider } }),
      ).toMatchObject({ ok: false, error: { code: 'GIT_REPOSITORY_UNAVAILABLE' } });

      expect(
        await invoke(IPC_CHANNELS.aiStart, { provider: 'gpt', target, includeContext: false }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      const started = await invoke<{ terminalId: string; prompt: string | null }>(
        IPC_CHANNELS.aiStart,
        { provider: 'codex', target, includeContext: true },
      );
      expect(started).toMatchObject({ ok: true });
      const data = (started as { ok: true; data: { terminalId: string; prompt: string } }).data;
      expect(data.prompt).toContain('Hexagonal');
      expect(spawner.last().written.join('')).toMatch(/^codex "\$\(cat '.+\.md'\)"\r$/);
      expect(await invoke(IPC_CHANNELS.contextSessionForTerminal, data.terminalId)).toMatchObject({
        ok: true,
        data: { provider: 'codex', captureMode: 'managed' },
      });
    });

    it('reports health, reconciles and stores context budgets', async () => {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
      const project = await registerProject();
      const target = { projectId: project.id };
      expect(await invoke(IPC_CHANNELS.contextHealth, target)).toMatchObject({
        ok: true,
        data: { lastReconciliation: null, totals: { activeEntries: 0 } },
      });
      expect(await invoke(IPC_CHANNELS.contextReconcile, target)).toMatchObject({
        ok: true,
        data: { lastReconciliation: { stale: 0 } },
      });
      expect(
        await invoke(IPC_CHANNELS.contextHealth, { workspacePath: path.join(temp.dir, 'nope') }),
      ).toMatchObject({ ok: false });

      expect(await invoke(IPC_CHANNELS.contextBudgets)).toMatchObject({
        ok: true,
        data: { defaultTokens: 6000 },
      });
      expect(await invoke(IPC_CHANNELS.contextSetBudgets, { defaultTokens: 100 })).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
      expect(await invoke(IPC_CHANNELS.contextSetBudgets, { roles: { qa: 2000 } })).toMatchObject({
        ok: true,
        data: { defaultTokens: 6000, roles: { qa: 2000 } },
      });
      expect(
        await invoke(IPC_CHANNELS.contextBundle, { target, agentRole: 'qa', excludeIds: ['x'] }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await invoke(IPC_CHANNELS.contextBundle, { target, agentRole: 'qa' })).toMatchObject({
        ok: true,
        data: { budgetTokens: 2000, budgetSource: 'role' },
      });
    });

    it('validates project AI configuration changes', async () => {
      const project = await registerProject();
      expect(await invoke(IPC_CHANNELS.contextProjectConfig, project.id)).toMatchObject({
        ok: true,
        data: { config: { keepContext: false, atlasEnabled: false } },
      });
      expect(
        await invoke(IPC_CHANNELS.contextSetProjectConfig, project.id, { keepContext: 'yes' }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(
        await invoke(IPC_CHANNELS.contextSetProjectConfig, project.id, { context: { file: '/x' } }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(
        await invoke(IPC_CHANNELS.contextSetProjectConfig, '../escape', { keepContext: true }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(
        await invoke(IPC_CHANNELS.contextSetProjectConfig, project.id, { atlasEnabled: true }),
      ).toMatchObject({ ok: true, data: { config: { atlasEnabled: true } } });
    });
  });

  describe('skills', () => {
    const skillDir = (name: string) => {
      const dir = path.join(temp.dir, 'skills', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
      return dir;
    };

    it('reads only folders chosen in the picker or inside an added source', async () => {
      const dir = skillDir('helper');
      expect(await invoke(IPC_CHANNELS.skillsInspect, dir)).toMatchObject({
        ok: false,
        error: { code: 'SKILL_SOURCE_UNAUTHORIZED' },
      });
      expect(
        await invoke(IPC_CHANNELS.skillsAddSource, { path: path.dirname(dir), kind: 'path' }),
      ).toMatchObject({ ok: false, error: { code: 'SKILL_SOURCE_UNAUTHORIZED' } });
      // The renderer cannot claim the folder was picked.
      expect(await invoke(IPC_CHANNELS.skillsInspect, dir, true)).toMatchObject({ ok: false });

      pickedPath = path.dirname(dir);
      await invoke(IPC_CHANNELS.chooseDirectory, 'skill');
      expect(
        await invoke(IPC_CHANNELS.skillsAddSource, { path: path.dirname(dir), kind: 'path' }),
      ).toMatchObject({ ok: true });
      const preview = await invoke<{ contentHash: string }>(IPC_CHANNELS.skillsInspect, dir);
      expect(preview).toMatchObject({ ok: true, data: { name: 'helper' } });
      const { contentHash } = (preview as { ok: true; data: { contentHash: string } }).data;
      expect(
        await invoke(IPC_CHANNELS.skillsImport, { path: dir, confirm: false, contentHash }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(
        await invoke(IPC_CHANNELS.skillsImport, { path: dir, confirm: true, contentHash }),
      ).toMatchObject({ ok: true, data: { name: 'helper', enabled: false } });
      expect(await invoke(IPC_CHANNELS.skillsList)).toMatchObject({
        ok: true,
        data: [{ name: 'helper' }],
      });
    });

    it('accepts sync folders only when picked or suggested, and validates rules', async () => {
      expect(
        await invoke(IPC_CHANNELS.skillsSetSyncTargets, { codex: path.join(temp.dir, 'anywhere') }),
      ).toMatchObject({ ok: false, error: { code: 'SKILL_SOURCE_UNAUTHORIZED' } });
      const chosen = path.join(temp.dir, 'chosen');
      mkdirSync(chosen);
      pickedPath = chosen;
      await invoke(IPC_CHANNELS.chooseDirectory, 'skill');
      expect(await invoke(IPC_CHANNELS.skillsSetSyncTargets, { codex: chosen })).toMatchObject({
        ok: true,
        data: { codex: chosen, claude: null },
      });
      const skill = await invoke<{ id: string }>(IPC_CHANNELS.skillsCreateFromTemplate, {
        templateId: 'code-review',
        name: 'review',
      });
      const id = (skill as { ok: true; data: { id: string } }).data.id;
      expect(
        await invoke(IPC_CHANNELS.skillsAssign, {
          skillId: id,
          scope: 'role',
          target: 'boss',
          effect: 'enable',
        }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(
        await invoke(IPC_CHANNELS.skillsAssign, {
          skillId: id,
          scope: 'provider',
          target: 'codex',
          effect: 'enable',
        }),
      ).toMatchObject({ ok: true });
      expect(await invoke(IPC_CHANNELS.skillsResolve, { provider: 'codex' })).toMatchObject({
        ok: true,
        data: [{ active: true, layer: 'provider' }],
      });
      expect(
        await invoke(IPC_CHANNELS.skillsReadFile, { skillId: id, sequence: 1, path: '../x' }),
      ).toMatchObject({ ok: false, error: { code: 'SKILL_NOT_FOUND' } });
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
