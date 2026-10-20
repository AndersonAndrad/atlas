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

  const build = (overrides: Partial<ConstructorParameters<typeof TerminalService>[0]> = {}) => {
    const created = new TerminalService({
      sessions,
      spawner,
      mirrors,
      shells,
      workspaces: {
        resolveWorkingDirectory: async (projectId) => {
          if (projectId === UNKNOWN_PROJECT) throw new AtlasError('PROJECT_NOT_FOUND');
          return `/work/${projectId.slice(0, 1)}`;
        },
      },
      settings,
      environment: { shellEnvironment: () => ({ TERM: 'xterm-256color' }) },
      clock: { now: () => new Date('2026-10-19T12:00:00.000Z') },
      generateId: () => `00000000-0000-4000-8000-${String(idCounter++).padStart(12, '0')}`,
      timing: { flushIntervalMs: 5, killTimeoutMs: 50, pauseThreshold: 100, resumeThreshold: 20 },
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
        status: 'RUNNING',
        title: 'zsh',
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
      expect(preferred.title).toBe('bash 2');
    });

    it('never takes the working directory from the caller', async () => {
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

    it('gives unique default titles per project', async () => {
      const titles = [];
      for (let index = 0; index < 3; index += 1) {
        titles.push((await service.create({ projectId: PROJECT_A })).title);
      }
      titles.push((await service.create({ projectId: PROJECT_B })).title);
      expect(titles).toEqual(['zsh', 'zsh 2', 'zsh 3', 'zsh']);
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

    it('removes all sessions of a removed project', async () => {
      await service.create({ projectId: PROJECT_A });
      await service.create({ projectId: PROJECT_A });
      const other = await service.create({ projectId: PROJECT_B });
      await service.removeProjectSessions(PROJECT_A);
      expect(service.list().map((session) => session.id)).toEqual([other.id]);
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
