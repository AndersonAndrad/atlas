import type { TerminalEvent, TerminalSession } from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import {
  TERMINAL_LIMITS,
  TerminalService,
  TerminalSettings,
  canTransition,
  type KeyValueStore,
  type TerminalSessionRepository,
} from '../src/index.js';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_PROJECT = '33333333-3333-4333-8333-333333333333';
const GROUP_X = '44444444-4444-4444-8444-444444444444';
const GROUP_Y = '55555555-5555-4555-8555-555555555555';

class MemorySessions implements TerminalSessionRepository {
  rows = new Map<string, TerminalSession>();
  async findAll() {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
  async save(session: TerminalSession) {
    this.rows.set(session.id, { ...session });
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
  async markInterrupted(endedAt: string) {
    let count = 0;
    for (const row of this.rows.values()) {
      if (!['EXITED', 'FAILED', 'TERMINATED'].includes(row.status)) {
        Object.assign(row, { status: 'TERMINATED', endReason: 'engine-lost', endedAt });
        count += 1;
      }
    }
    return count;
  }
}

class MemoryStore implements KeyValueStore {
  values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

describe('TerminalService', () => {
  let spawner: FakePtySpawner;
  let mirrors: FakeMirrorFactory;
  let shells: FakeShellProvider;
  let sessions: MemorySessions;
  let settings: TerminalSettings;
  let service: TerminalService;
  let events: { event: TerminalEvent; subscriberId: string | undefined }[];
  let idCounter: number;
  let cwds: Map<number, string>;
  let existingGroups: Set<string>;
  let settled: string[];

  const build = (overrides: Partial<ConstructorParameters<typeof TerminalService>[0]> = {}) => {
    const created = new TerminalService({
      sessions,
      spawner,
      mirrors,
      shells,
      workspaces: {
        resolveProjectDirectory: async (projectId) => {
          if (projectId === UNKNOWN_PROJECT) throw new AtlasError('PROJECT_NOT_FOUND');
          return `/work/${projectId.slice(0, 1)}`;
        },
        resolveDirectory: async (directory) => {
          if (directory.startsWith('/missing')) throw new AtlasError('PROJECT_PATH_UNAVAILABLE');
          return directory.replace(/\/+$/, '') || '/';
        },
        assertProjectExists: async (projectId) => {
          if (projectId === UNKNOWN_PROJECT) throw new AtlasError('PROJECT_NOT_FOUND');
        },
        homeDirectory: () => '/home/me',
      },
      settings,
      environment: { shellEnvironment: () => ({ TERM: 'xterm-256color' }) },
      cwdResolver: { currentDirectory: async (pid) => cwds.get(pid) ?? null },
      groupExists: async (groupId) => existingGroups.has(groupId),
      onCommandSettled: (session) => settled.push(session.id),
      clock: { now: () => new Date('2026-10-19T12:00:00.000Z') },
      generateId: () => `00000000-0000-4000-8000-${String(idCounter++).padStart(12, '0')}`,
      timing: {
        flushIntervalMs: 5,
        killTimeoutMs: 50,
        pauseThreshold: 100,
        resumeThreshold: 20,
        cwdCheckDelayMs: 10,
      },
      ...overrides,
    });
    created.onEvent((event, subscriberId) => events.push({ event, subscriberId }));
    return created;
  };

  const statuses = (sessionId: string) =>
    events
      .filter(
        (
          entry,
        ): entry is {
          event: Extract<TerminalEvent, { type: 'session' }>;
          subscriberId: undefined;
        } => entry.event.type === 'session' && entry.event.session.id === sessionId,
      )
      .map((entry) => entry.event.session.status);

  const outputs = (subscriberId: string) =>
    events
      .filter((entry) => entry.event.type === 'output' && entry.subscriberId === subscriberId)
      .map((entry) => entry.event as Extract<TerminalEvent, { type: 'output' }>);

  beforeEach(() => {
    spawner = new FakePtySpawner();
    mirrors = new FakeMirrorFactory();
    shells = new FakeShellProvider();
    sessions = new MemorySessions();
    settings = new TerminalSettings(new MemoryStore());
    events = [];
    idCounter = 1;
    cwds = new Map();
    existingGroups = new Set([GROUP_X, GROUP_Y]);
    settled = [];
    service = build();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('create', () => {
    it('starts the default shell in the registered project directory', async () => {
      const session = await service.create({ projectId: PROJECT_A, columns: 100, rows: 30 });

      expect(session).toMatchObject({
        projectId: PROJECT_A,
        cwd: '/work/1',
        currentCwd: '/work/1',
        cwdSource: 'initial',
        status: 'RUNNING',
        title: '1',
        autoTitle: '1',
        customTitle: null,
        groupId: null,
        groupPosition: 0,
        shell: { id: 'zsh', path: '/bin/zsh' },
        columns: 100,
        rows: 30,
        createdAt: '2026-10-19T12:00:00.000Z',
        startedAt: '2026-10-19T12:00:00.000Z',
      });
      const pty = spawner.last();
      expect(session.pid).toBe(pty.pid);
      expect(pty.options).toMatchObject({
        file: '/bin/zsh',
        args: ['-l'],
        cwd: '/work/1',
        columns: 100,
        rows: 30,
      });
      expect(statuses(session.id)).toEqual(['CREATED', 'STARTING', 'RUNNING']);
      expect(sessions.rows.get(session.id)?.status).toBe('RUNNING');
    });

    it('uses the requested shell, then the preferred default', async () => {
      const bash = await service.create({ projectId: PROJECT_A, shellId: 'bash' });
      expect(bash.shell.id).toBe('bash');

      await settings.updatePreferences({ defaultShellId: 'bash' });
      const preferred = await service.create({ projectId: PROJECT_A });
      expect(preferred.shell.id).toBe('bash');
    });

    it('never takes a directory for a project terminal', async () => {
      await expect(
        service.create({ projectId: PROJECT_A, cwd: '/etc' } as never),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(spawner.spawned).toHaveLength(0);
    });

    it('rejects unregistered projects without spawning', async () => {
      await expect(service.create({ projectId: UNKNOWN_PROJECT })).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
      });
      expect(spawner.spawned).toHaveLength(0);
      expect(service.list()).toEqual([]);
    });

    it('rejects shells that are not available', async () => {
      await expect(service.create({ projectId: PROJECT_A, shellId: 'fish' })).rejects.toMatchObject(
        { code: 'TERMINAL_SHELL_UNAVAILABLE' },
      );
    });

    it('records a failed start without reporting the session as running', async () => {
      spawner.failNext = new Error('posix_spawnp failed.');
      const session = await service.create({ projectId: PROJECT_A });
      expect(session).toMatchObject({
        status: 'FAILED',
        endReason: 'startup-failed',
        failureMessage: 'The shell could not be started.',
      });
      expect(statuses(session.id)).toEqual(['CREATED', 'STARTING', 'FAILED']);
      expect(() => service.write(session.id, 'ls\r')).toThrow(
        expect.objectContaining({ code: 'TERMINAL_NOT_RUNNING' }),
      );
    });

    it('enforces the active session limit', async () => {
      for (let index = 0; index < TERMINAL_LIMITS.maxActiveSessions; index += 1) {
        await service.create({ projectId: PROJECT_A });
      }
      await expect(service.create({ projectId: PROJECT_A })).rejects.toMatchObject({
        code: 'TERMINAL_LIMIT_REACHED',
      });
    });
  });

  describe('standalone terminals and names', () => {
    it('starts without a project in a given directory, the default one, or home', async () => {
      const inFolder = await service.create({ cwd: '/srv/tools/' });
      expect(inFolder).toMatchObject({ projectId: null, cwd: '/srv/tools', title: 'tools' });
      expect(spawner.last().options.cwd).toBe('/srv/tools');

      expect(await service.create({})).toMatchObject({ cwd: '/home/me', title: '~' });

      await settings.updatePreferences({ defaultWorkingDirectory: '/opt/work' });
      expect((await service.create({})).cwd).toBe('/opt/work');

      await settings.updatePreferences({ defaultWorkingDirectory: '/missing/dir' });
      expect((await service.create({})).cwd).toBe('/home/me');
    });

    it('rejects unavailable directories and directory plus project', async () => {
      await expect(service.create({ cwd: '/missing/x' })).rejects.toMatchObject({
        code: 'PROJECT_PATH_UNAVAILABLE',
      });
      await expect(service.create({ projectId: PROJECT_A, cwd: '/tmp' })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      expect(spawner.spawned).toHaveLength(0);
    });

    it('keeps custom names separate from automatic ones and can restore them', async () => {
      const session = await service.create({ cwd: '/srv/api', title: 'NOVA Backend' });
      expect(session).toMatchObject({
        title: 'NOVA Backend',
        customTitle: 'NOVA Backend',
        autoTitle: 'api',
      });
      const restored = await service.rename(session.id, null);
      expect(restored).toMatchObject({ title: 'api', customTitle: null });
      expect(sessions.rows.get(session.id)).toMatchObject({ customTitle: null, autoTitle: 'api' });
    });

    it('follows the detected working directory without overwriting a custom name', async () => {
      const named = await service.create({ cwd: '/srv/api', title: 'Docker Services' });
      const auto = await service.create({ cwd: '/srv/api' });
      cwds.set(named.pid!, '/srv/web');
      cwds.set(auto.pid!, '/srv/web');

      for (const session of [named, auto]) service.write(session.id, 'cd ../web\r');
      await vi.waitFor(() => expect(service.getById(auto.id).currentCwd).toBe('/srv/web'));
      await vi.waitFor(() => expect(service.getById(named.id).currentCwd).toBe('/srv/web'));

      expect(service.getById(auto.id)).toMatchObject({
        title: 'web',
        autoTitle: 'web',
        cwdSource: 'detected',
        cwd: '/srv/api',
      });
      expect(service.getById(named.id)).toMatchObject({
        title: 'Docker Services',
        autoTitle: 'web',
      });
    });

    it('reports each settled command, even when the directory did not change', async () => {
      const session = await service.create({ cwd: '/srv/api' });
      service.write(session.id, 'echo x >> file\r');
      await vi.waitFor(() => expect(settled).toEqual([session.id]));
      cwds.set(session.pid!, '/srv/api');
      service.write(session.id, 'touch other\r');
      await vi.waitFor(() => expect(settled).toEqual([session.id, session.id]));
      service.write(session.id, 'ls');
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(settled).toHaveLength(2);
    });

    it('keeps the initial directory when the platform cannot report it', async () => {
      const session = await service.create({ cwd: '/srv/api' });
      service.write(session.id, 'cd /\r');
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(service.getById(session.id)).toMatchObject({
        currentCwd: '/srv/api',
        cwdSource: 'initial',
      });
    });

    it('associates terminals with projects and detaches them when a project goes away', async () => {
      const session = await service.create({ cwd: '/srv/api' });
      expect((await service.associate(session.id, PROJECT_A)).projectId).toBe(PROJECT_A);
      await expect(service.associate(session.id, UNKNOWN_PROJECT)).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
      });

      const other = await service.create({ projectId: PROJECT_A });
      await service.detachProject(PROJECT_A);
      for (const id of [session.id, other.id]) {
        expect(service.getById(id)).toMatchObject({ projectId: null, status: 'RUNNING' });
      }
    });
  });

  describe('groups', () => {
    it('places new terminals at the end of their group', async () => {
      const a = await service.create({ cwd: '/a', groupId: GROUP_X });
      const b = await service.create({ cwd: '/b', groupId: GROUP_X });
      const c = await service.create({ cwd: '/c' });
      expect([a, b, c].map((s) => [s.groupId, s.groupPosition])).toEqual([
        [GROUP_X, 0],
        [GROUP_X, 1],
        [null, 0],
      ]);
      await expect(
        service.create({ cwd: '/d', groupId: '66666666-6666-4666-8666-666666666666' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('moves terminals between and within groups without restarting them', async () => {
      const a = await service.create({ cwd: '/a', groupId: GROUP_X });
      const b = await service.create({ cwd: '/b', groupId: GROUP_X });
      const c = await service.create({ projectId: PROJECT_B, groupId: GROUP_Y });

      await service.move(c.id, GROUP_X, 0);
      await service.move(a.id, GROUP_X, 10_000);
      const order = service
        .list()
        .filter((s) => s.groupId === GROUP_X)
        .sort((x, y) => x.groupPosition - y.groupPosition)
        .map((s) => s.id);
      expect(order).toEqual([c.id, b.id, a.id]);
      // Same processes: nothing was spawned or killed.
      expect(spawner.spawned).toHaveLength(3);
      expect(spawner.spawned.every((pty) => pty.kills.length === 0)).toBe(true);
      expect(service.getById(c.id).pid).toBe(c.pid);

      await service.ungroupAll(GROUP_X);
      expect(service.list().filter((s) => s.groupId === null)).toHaveLength(3);
    });
  });

  describe('input, output and resizing', () => {
    it('writes raw input to the PTY', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      service.write(session.id, 'echo "$HOME" && ls\r');
      expect(spawner.last().written).toEqual(['echo "$HOME" && ls\r']);
    });

    it('delivers ordered output only to attached subscribers', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      const pty = spawner.last();
      await service.attach(session.id, 'view-1', 80, 24);

      pty.emit('a');
      pty.emit('b');
      await vi.waitFor(() => expect(outputs('view-1')).toHaveLength(1));
      pty.emit('\x1b[31mred\x1b[0m');
      await vi.waitFor(() => expect(outputs('view-1')).toHaveLength(2));

      expect(outputs('view-1').map((event) => [event.seq, event.data])).toEqual([
        [1, 'ab'],
        [2, '\x1b[31mred\x1b[0m'],
      ]);
      expect(outputs('view-2')).toEqual([]);
    });

    it('replays the screen when a view attaches and continues without gaps', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      const pty = spawner.last();
      pty.emit('before ');
      const attachment = await service.attach(session.id, 'view-1', 80, 24);
      expect(attachment.snapshot).toBe('before ');
      expect(attachment.seq).toBe(1);

      pty.emit('after');
      await vi.waitFor(() => expect(outputs('view-1')).toHaveLength(1));
      expect(outputs('view-1')[0]).toMatchObject({ seq: 2, data: 'after' });
    });

    it('pauses the PTY when a view falls behind and resumes on acknowledgement', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      const pty = spawner.last();
      await service.attach(session.id, 'view-1', 80, 24);

      pty.emit('x'.repeat(150));
      await vi.waitFor(() => expect(pty.paused).toBe(true));
      service.acknowledge(session.id, 'view-1', 140);
      expect(pty.paused).toBe(false);
    });

    it('does not pause hidden sessions, and detaching releases back-pressure', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      const pty = spawner.last();
      pty.emit('y'.repeat(500));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pty.paused).toBe(false);

      await service.attach(session.id, 'desktop-1-0:v1', 80, 24);
      pty.emit('z'.repeat(150));
      await vi.waitFor(() => expect(pty.paused).toBe(true));
      service.detachSubscriber('desktop-1-0');
      expect(pty.paused).toBe(false);
    });

    it('propagates size changes to the PTY and the mirror once', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      service.resize(session.id, 120, 40);
      service.resize(session.id, 120, 40);
      expect(spawner.last().resizes).toEqual([[120, 40]]);
      expect(mirrors.created[0]!.size).toEqual([120, 40]);
      expect(service.getById(session.id)).toMatchObject({ columns: 120, rows: 40 });
    });

    it('clears the mirrored scrollback', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      spawner.last().emit('secret output');
      await service.attach(session.id, 'v', 80, 24);
      service.clear(session.id);
      expect((await service.attach(session.id, 'w', 80, 24)).snapshot).toBe('');
    });
  });

  describe('lifecycle', () => {
    it('reports a nonzero exit and stops accepting input', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      spawner.last().exit({ exitCode: 2 });
      await vi.waitFor(() => expect(service.getById(session.id).status).toBe('EXITED'));

      expect(service.getById(session.id)).toMatchObject({ exitCode: 2, endReason: 'exited' });
      expect(statuses(session.id).at(-1)).toBe('EXITED');
      expect(() => service.write(session.id, 'x')).toThrow(
        expect.objectContaining({ code: 'TERMINAL_NOT_RUNNING' }),
      );
    });

    it('records unexpected termination by a signal', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      spawner.last().exit({ exitCode: 0, signal: 9 });
      await vi.waitFor(() => expect(service.getById(session.id).status).toBe('EXITED'));
      expect(service.getById(session.id)).toMatchObject({ signal: 9, endReason: 'exited' });
    });

    it('terminates with SIGHUP and resolves once the process exited', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      const ended = await service.terminate(session.id);
      expect(ended).toMatchObject({ status: 'TERMINATED', endReason: 'user' });
      expect(spawner.last().kills).toEqual(['SIGHUP']);
      expect(statuses(session.id).slice(-2)).toEqual(['TERMINATING', 'TERMINATED']);
      expect(sessions.rows.get(session.id)?.status).toBe('TERMINATED');
    });

    it('kills a process that ignores SIGHUP', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      spawner.last().exitOnKill = false;
      const ended = await service.terminate(session.id);
      expect(ended.status).toBe('TERMINATED');
      expect(spawner.last().kills).toEqual(['SIGHUP', 'SIGKILL']);
    });

    it('treats terminating an ended session as a no-op', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      spawner.last().exit({ exitCode: 0 });
      await vi.waitFor(() => expect(service.getById(session.id).status).toBe('EXITED'));
      await expect(service.terminate(session.id)).resolves.toMatchObject({ status: 'EXITED' });
      expect(spawner.last().kills).toEqual([]);
    });

    it('closes one session without affecting others', async () => {
      const first = await service.create({ projectId: PROJECT_A });
      const second = await service.create({ projectId: PROJECT_A });
      const other = await service.create({ projectId: PROJECT_B });
      await service.dismiss(first.id);

      expect(service.list().map((session) => session.id)).toEqual([second.id, other.id]);
      expect(service.getById(second.id).status).toBe('RUNNING');
      expect(events.at(-1)?.event).toEqual({
        type: 'removed',
        sessionId: first.id,
        projectId: PROJECT_A,
      });
      expect(sessions.rows.has(first.id)).toBe(false);
      expect(mirrors.created[0]!.disposed).toBe(true);
    });

    it('restarts an ended session with the same title and shell', async () => {
      const session = await service.create({ projectId: PROJECT_A, shellId: 'bash' });
      await service.rename(session.id, 'Dev server');
      await service.terminate(session.id);
      const restarted = await service.restart(session.id);

      expect(restarted).toMatchObject({ title: 'Dev server', status: 'RUNNING' });
      expect(restarted.shell.id).toBe('bash');
      expect(restarted.id).not.toBe(session.id);
      expect(() => service.getById(session.id)).toThrow(
        expect.objectContaining({ code: 'TERMINAL_NOT_FOUND' }),
      );
    });

    it('refuses to restart a running session', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      await expect(service.restart(session.id)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    });

    it('asks for confirmation only when a program other than the shell runs', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      expect(service.closeInfo(session.id)).toEqual({ requiresConfirmation: false });

      spawner.last().foregroundProcess = 'node';
      expect(service.closeInfo(session.id)).toEqual({
        requiresConfirmation: true,
        processName: 'node',
      });

      spawner.last().foregroundProcess = undefined;
      expect(service.closeInfo(session.id)).toEqual({ requiresConfirmation: true });
      expect(service.closeAllInfo()).toEqual({ runningSessions: 1, busySessions: 1 });
    });

    it('marks sessions of a previous Engine run as lost on initialization', async () => {
      const running = await service.create({ projectId: PROJECT_A });
      const restarted = build();
      await restarted.initialize();

      expect(restarted.list()).toEqual([
        expect.objectContaining({ id: running.id, status: 'TERMINATED', endReason: 'engine-lost' }),
      ]);
      expect(restarted.activeCount()).toBe(0);
      expect((await restarted.attach(running.id, 'v', 80, 24)).snapshot).toBe('');
    });

    it('terminates every process on shutdown and refuses new sessions', async () => {
      const first = await service.create({ projectId: PROJECT_A });
      const second = await service.create({ projectId: PROJECT_B });
      await service.shutdown();

      for (const id of [first.id, second.id]) {
        expect(sessions.rows.get(id)).toMatchObject({
          status: 'TERMINATED',
          endReason: 'engine-shutdown',
        });
      }
      await expect(service.create({ projectId: PROJECT_A })).rejects.toMatchObject({
        code: 'TERMINAL_START_FAILED',
      });
    });
  });

  describe('lookup', () => {
    it('filters by project and reports unknown or malformed ids as not found', async () => {
      const a = await service.create({ projectId: PROJECT_A });
      await service.create({ projectId: PROJECT_B });
      expect(service.list(PROJECT_A).map((session) => session.id)).toEqual([a.id]);
      for (const id of ['00000000-0000-4000-8000-999999999999', 'not-a-uuid']) {
        expect(() => service.getById(id)).toThrow(
          expect.objectContaining({ code: 'TERMINAL_NOT_FOUND' }),
        );
      }
    });

    it('returns copies so callers cannot mutate Engine state', async () => {
      const session = await service.create({ projectId: PROJECT_A });
      service.list()[0]!.status = 'EXITED';
      session.shell.path = '/tmp/evil';
      expect(service.getById(session.id)).toMatchObject({
        status: 'RUNNING',
        shell: { path: '/bin/zsh' },
      });
    });
  });
});

describe('terminal status transitions', () => {
  it('allows only forward lifecycle transitions', () => {
    expect(canTransition('CREATED', 'STARTING')).toBe(true);
    expect(canTransition('STARTING', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'TERMINATING')).toBe(true);
    expect(canTransition('TERMINATING', 'TERMINATED')).toBe(true);
    expect(canTransition('RUNNING', 'EXITED')).toBe(true);
    expect(canTransition('EXITED', 'RUNNING')).toBe(false);
    expect(canTransition('TERMINATED', 'RUNNING')).toBe(false);
    expect(canTransition('FAILED', 'RUNNING')).toBe(false);
    expect(canTransition('CREATED', 'RUNNING')).toBe(false);
  });
});
