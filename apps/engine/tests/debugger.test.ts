import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DebugEvent, DebugSession } from '@atlas/contracts';
import { DebugSessionManager } from '@atlas/debugger';
import { noopLogger } from '@atlas/shared';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  NodeDebugFileSystem,
  ProcessTreeAdapterLauncher,
  adapterEnvironment,
} from '../src/adapters/debug-adapter-process.js';

// SDD-016 Task 01 with a real adapter process (tests/support/fake-debug-adapter.mjs) that
// misbehaves on purpose. POSIX only: it checks process groups and PIDs.

const ADAPTER = fileURLToPath(
  new URL('../../../tests/support/fake-debug-adapter.mjs', import.meta.url),
);
const PROJECT = '00000000-0000-4000-8000-000000000900';
const OWNER = 'desktop-1';
const posix = process.platform !== 'win32';

const alive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe.skipIf(!posix)('Debug session manager (SDD-016 Task 01)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let project: string;
  let manager: DebugSessionManager;
  let events: { owner: string; event: DebugEvent }[];
  let pids: number[];

  beforeEach(() => {
    temp = createTempDir();
    project = path.join(temp.dir, 'app');
    mkdirSync(path.join(project, 'src'), { recursive: true });
    events = [];
    pids = [];
    const launcher = new ProcessTreeAdapterLauncher(process.env);
    manager = new DebugSessionManager({
      launcher: {
        launch: (spec, handlers) => {
          const started = launcher.launch(spec, handlers);
          if (started.pid !== undefined) pids.push(started.pid);
          return started;
        },
      },
      fileSystem: new NodeDebugFileSystem(),
      projectPath: async (id) => (id === PROJECT ? project : null),
      timeouts: { initialize: 1500, launch: 1500, configurationDone: 1500, disconnect: 500 },
      clock: { now: () => new Date() },
      generateId: (() => {
        let n = 0;
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      })(),
      logger: noopLogger,
    });
    manager.onEvent((owner, event) => events.push({ owner, event }));
    for (const mode of [
      'normal',
      'stop-on-entry',
      'launch-after-config',
      'refuse-launch',
      'crash-on-launch',
      'hang-initialize',
      'garbage',
      'split',
      'ignore-disconnect',
      'spawn-child',
      'reverse-request',
      'terminate-soon',
      'same-chunk',
    ]) {
      manager.registerAdapter({
        id: mode,
        label: mode,
        command: process.execPath,
        args: [ADAPTER, mode, path.join(temp.dir, 'child.pid')],
        languages: ['javascript'],
      });
    }
  });

  afterEach(async () => {
    await manager.close();
    for (const pid of pids) expect(alive(pid)).toBe(false);
    temp.cleanup();
  });

  const config = (adapterId: string, extra: Record<string, unknown> = {}) => ({
    name: `Debug ${adapterId}`,
    adapterId,
    request: 'launch',
    projectId: PROJECT,
    program: 'src/main.js',
    ...extra,
  });

  async function run(
    adapterId: string,
    extra: Record<string, unknown> = {},
  ): Promise<DebugSession> {
    const created = await manager.create(OWNER, config(adapterId, extra));
    expect(created.status).toBe('CREATED');
    return manager.start(OWNER, created.id);
  }

  const statuses = () =>
    events
      .filter((item) => item.event.type === 'status')
      .map((item) => (item.event as { status: string }).status);

  it('starts nothing on create, then runs the handshake on start and stops cleanly', async () => {
    const created = await manager.create(OWNER, config('normal'));
    expect(pids).toEqual([]);
    const session = await manager.start(OWNER, created.id);
    expect(session).toMatchObject({
      status: 'RUNNING',
      failure: null,
      capabilities: { supportsConfigurationDoneRequest: true },
    });
    expect(alive(pids[0])).toBe(true);
    await waitFor(() => events.some((item) => item.event.type === 'adapter-event'));
    expect(events).toContainEqual({
      owner: OWNER,
      event: {
        type: 'output',
        sessionId: session.id,
        category: 'console',
        output: 'launching src/main.js\n',
      },
    });
    expect(events).toContainEqual({
      owner: OWNER,
      event: {
        type: 'adapter-event',
        sessionId: session.id,
        event: 'process',
        body: { name: 'src/main.js', startMethod: 'launch' },
      },
    });

    const stopped = await manager.stop(OWNER, session.id);
    expect(stopped.status).toBe('TERMINATED');
    expect(stopped.endedAt).not.toBeNull();
    expect(alive(pids[0])).toBe(false);
    expect(statuses()).toEqual(['STARTING', 'RUNNING', 'TERMINATING', 'TERMINATED']);
  });

  it('pauses on entry and reports the stop', async () => {
    const session = await run('stop-on-entry', { stopOnEntry: true });
    await waitFor(() => manager.session(OWNER, session.id).status === 'PAUSED');
    expect(events.map((item) => item.event)).toContainEqual({
      type: 'stopped',
      sessionId: session.id,
      reason: 'entry',
      threadId: 1,
      description: null,
    });
  });

  it('accepts adapters that answer launch only after configurationDone', async () => {
    expect((await run('launch-after-config')).status).toBe('RUNNING');
  });

  it('sees an initialized event sent in the same chunk as the initialize response', async () => {
    expect((await run('same-chunk')).status).toBe('RUNNING');
  });

  it('reads messages written one byte at a time', async () => {
    expect((await run('split')).status).toBe('RUNNING');
  });

  it('fails with the adapter message when launch is refused', async () => {
    const session = await run('refuse-launch');
    expect(session).toMatchObject({
      status: 'FAILED',
      failure: { code: 'DEBUG_LAUNCH_FAILED', adapterMessage: 'Program not found: missing.js' },
    });
    await waitFor(() => !alive(pids[0]));
  });

  it('fails and cleans up when the adapter crashes', async () => {
    const session = await run('crash-on-launch');
    expect(session.status).toBe('FAILED');
    expect(session.failure).toMatchObject({
      code: 'DEBUG_ADAPTER_FAILED',
      adapterMessage: 'adapter: cannot find the runtime',
    });
    expect(alive(pids[0])).toBe(false);
  });

  it('times out an adapter that never answers and kills it', async () => {
    const session = await run('hang-initialize');
    expect(session).toMatchObject({ status: 'FAILED', failure: { code: 'DEBUG_TIMEOUT' } });
    await waitFor(() => !alive(pids[0]));
  });

  it('fails on invalid framing and kills the adapter', async () => {
    const session = await run('garbage');
    expect(session).toMatchObject({ status: 'FAILED', failure: { code: 'DEBUG_ADAPTER_FAILED' } });
    await waitFor(() => !alive(pids[0]));
  });

  it('kills an adapter that ignores disconnect and SIGTERM', async () => {
    const session = await run('ignore-disconnect');
    const stopped = await manager.stop(OWNER, session.id);
    expect(stopped.status).toBe('TERMINATED');
    expect(alive(pids[0])).toBe(false);
  }, 10_000);

  it('cleans up the whole tree after the adapter dies unexpectedly', async () => {
    const session = await run('spawn-child');
    const childFile = path.join(temp.dir, 'child.pid');
    await waitFor(() => existsSync(childFile));
    const child = Number(readFileSync(childFile, 'utf8'));
    expect(alive(child)).toBe(true);
    process.kill(pids[0]!, 'SIGKILL');
    await waitFor(() => manager.session(OWNER, session.id).status === 'FAILED');
    expect(manager.session(OWNER, session.id).failure?.code).toBe('DEBUG_ADAPTER_FAILED');
    await waitFor(() => !alive(child));
  });

  it('refuses requests from the adapter to run commands', async () => {
    const session = await run('reverse-request');
    await waitFor(() =>
      events.some(
        (item) => item.event.type === 'adapter-event' && item.event.event === 'reverseAnswer',
      ),
    );
    expect(events.map((item) => item.event)).toContainEqual({
      type: 'adapter-event',
      sessionId: session.id,
      event: 'reverseAnswer',
      body: { success: false, command: 'runInTerminal' },
    });
  });

  it('ends the session when the debuggee terminates', async () => {
    const session = await run('terminate-soon');
    await waitFor(() => manager.session(OWNER, session.id).status === 'TERMINATED');
    expect(alive(pids[0])).toBe(false);
  });

  it('passes arguments without a shell', async () => {
    const marker = path.join(temp.dir, 'pwned');
    const session = await run('normal', { program: `$(touch ${marker}); \`touch ${marker}\`` });
    expect(session.status).toBe('RUNNING');
    await waitFor(() => events.some((item) => item.event.type === 'output'));
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps sessions to their owner and one active at a time', async () => {
    const session = await manager.create(OWNER, config('normal'));
    expect(() => manager.session('desktop-2', session.id)).toThrow(
      expect.objectContaining({ code: 'DEBUG_SESSION_NOT_FOUND' }),
    );
    await expect(manager.start('desktop-2', session.id)).rejects.toMatchObject({
      code: 'DEBUG_SESSION_NOT_FOUND',
    });
    expect(manager.sessions('desktop-2')).toEqual([]);
    await expect(manager.create(OWNER, config('normal'))).rejects.toMatchObject({
      code: 'DEBUG_BUSY',
    });
    await manager.start(OWNER, session.id);
    await expect(manager.start(OWNER, session.id)).rejects.toMatchObject({
      code: 'DEBUG_INVALID_STATE',
    });
    await manager.stop(OWNER, session.id);
    expect((await manager.create(OWNER, config('normal'))).status).toBe('CREATED');
  });

  it('stops an owner’s sessions when it detaches', async () => {
    const session = await run('normal');
    expect(session.status).toBe('RUNNING');
    await manager.detach(OWNER);
    expect(alive(pids[0])).toBe(false);
    expect(manager.sessions(OWNER)).toEqual([]);
  });

  it('ends a CREATED session without running anything', async () => {
    const session = await manager.create(OWNER, config('normal'));
    expect((await manager.stop(OWNER, session.id)).status).toBe('TERMINATED');
    expect(pids).toEqual([]);
  });

  it('refuses unknown adapters, unknown projects and invalid configurations', async () => {
    await expect(manager.create(OWNER, config('missing'))).rejects.toMatchObject({
      code: 'DEBUG_ADAPTER_NOT_FOUND',
    });
    await expect(
      manager.create(
        OWNER,
        config('normal', { projectId: '00000000-0000-4000-8000-000000000999' }),
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    for (const invalid of [
      { cwd: '../outside' },
      { options: { cwd: 1, 'bad-key': 1 } },
      { request: 'run' },
    ]) {
      await expect(manager.create(OWNER, config('normal', invalid))).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    expect(() =>
      manager.registerAdapter({ id: 'rel', label: 'x', command: 'node', args: [], languages: [] }),
    ).toThrow(expect.objectContaining({ code: 'DEBUG_ADAPTER_INVALID' }));
  });

  it('fails without starting when the folder escapes the project through a link', async () => {
    symlinkSync(temp.dir, path.join(project, 'escape'));
    const session = await run('normal', { cwd: 'escape' });
    expect(session).toMatchObject({
      status: 'FAILED',
      failure: { code: 'DEBUG_WORKSPACE_INVALID' },
    });
    expect(pids).toEqual([]);
  });

  it('fails without starting when the adapter is not an executable file', async () => {
    const script = path.join(temp.dir, 'not-executable');
    writeFileSync(script, '#!/bin/sh\n');
    chmodSync(script, 0o644);
    manager.registerAdapter({ id: 'plain', label: 'x', command: script, args: [], languages: [] });
    const session = await run('plain');
    expect(session).toMatchObject({ status: 'FAILED', failure: { code: 'DEBUG_ADAPTER_INVALID' } });
    expect(pids).toEqual([]);
  });

  it('gives adapters the environment without Electron and ATLAS internals', () => {
    expect(
      adapterEnvironment({
        PATH: '/bin',
        ELECTRON_RUN_AS_NODE: '1',
        ATLAS_DATA_DIR: '/x',
        HOME: '/h',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});
