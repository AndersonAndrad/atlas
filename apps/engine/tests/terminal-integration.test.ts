import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { TerminalEvent, TerminalSession } from '@atlas/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  connectToEngine,
  encodeMessage,
  runFilePath,
  startEngineHost,
  type EngineHost,
} from '../src/index.js';

/**
 * Real PTY processes (node-pty + bash) inside temporary directories. HOME points
 * to an empty temporary directory so no user dotfiles are loaded, and only
 * harmless commands (echo, printf, read, sleep, stty, exit) are executed.
 */
describe.skipIf(process.platform === 'win32')('terminal runtime with real PTYs', () => {
  let temp: ReturnType<typeof createTempDir>;
  let dataDir: string;
  let env: Record<string, string | undefined>;
  let host: EngineHost | undefined;
  let output: Map<string, string>;

  const startHost = async () => {
    host = await startEngineHost({ dataDir, env, component: 'test' });
    host.onTerminalEvent((event: TerminalEvent, subscriberId) => {
      if (event.type === 'output' && subscriberId !== undefined) {
        output.set(subscriberId, (output.get(subscriberId) ?? '') + event.data);
      }
    });
    return host;
  };

  const workspace = async (name: string) => {
    const dir = path.join(temp.dir, 'workspaces', name);
    mkdirSync(dir, { recursive: true });
    return host!.engine.projects.create({ name, workspacePath: dir });
  };

  const open = async (projectId: string, view = 'v') => {
    const session = await host!.engine.terminals!.create({ projectId, columns: 80, rows: 24 });
    await host!.engine.terminals!.attach(session.id, `${view}-${session.id}`, 80, 24);
    return session;
  };

  const outputOf = (session: TerminalSession, view = 'v') =>
    output.get(`${view}-${session.id}`) ?? '';

  const waitForOutput = async (session: TerminalSession, pattern: RegExp, view = 'v') => {
    const deadline = Date.now() + 10_000;
    while (!pattern.test(outputOf(session, view))) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for ${pattern}; got ${JSON.stringify(outputOf(session, view))}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const waitForStatus = async (id: string, statuses: string[]) => {
    const deadline = Date.now() + 10_000;
    while (!statuses.includes(host!.engine.terminals!.getById(id).status)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${statuses.join('|')}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return host!.engine.terminals!.getById(id);
  };

  const run = (session: TerminalSession, command: string) =>
    host!.engine.terminals!.write(session.id, `${command}\r`);

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    temp = createTempDir();
    dataDir = path.join(temp.dir, 'data');
    const home = path.join(temp.dir, 'home');
    mkdirSync(home);
    env = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      SHELL: '/bin/bash',
      LANG: 'en_US.UTF-8',
      BASH_SILENCE_DEPRECATION_WARNING: '1',
    };
    output = new Map();
  });

  afterEach(async () => {
    await host?.stop();
    host = undefined;
    temp.cleanup();
  });

  it('runs interactive commands in the project directory with colors', async () => {
    await startHost();
    const project = await workspace('nova');
    const session = await open(project.id);
    expect(session).toMatchObject({ status: 'RUNNING', cwd: project.workspacePath });

    run(session, 'pwd; printf "\\033[31m%s\\033[0m\\n" "$((40 + 2))"');
    await waitForOutput(session, /42/);
    // The escape sequences reach the view untouched.
    expect(outputOf(session)).toContain('\x1b[31m42\x1b[0m');
    expect(outputOf(session)).toContain(project.workspacePath);

    run(session, 'read -r name; echo "hello-$name"');
    await new Promise((resolve) => setTimeout(resolve, 200));
    host!.engine.terminals!.write(session.id, 'atlas\r');
    await waitForOutput(session, /hello-atlas/);
  });

  it('interrupts a foreground program with Ctrl+C', async () => {
    await startHost();
    const project = await workspace('nova');
    const session = await open(project.id);
    run(session, 'sleep 30');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(host!.engine.terminals!.closeInfo(session.id)).toMatchObject({
      requiresConfirmation: true,
      processName: 'sleep',
    });

    host!.engine.terminals!.write(session.id, '\x03');
    run(session, 'echo "rc=$?"');
    await waitForOutput(session, /rc=130/);
    expect(host!.engine.terminals!.closeInfo(session.id)).toEqual({ requiresConfirmation: false });
  });

  it('propagates terminal resizing to programs', async () => {
    await startHost();
    const project = await workspace('nova');
    const session = await open(project.id);
    host!.engine.terminals!.resize(session.id, 132, 43);
    run(session, 'stty size');
    await waitForOutput(session, /43 132/);
  });

  it('detects successful and nonzero exits', async () => {
    await startHost();
    const project = await workspace('nova');
    const ok = await open(project.id);
    const failing = await open(project.id);
    run(ok, 'exit 0');
    run(failing, 'exit 7');
    expect(await waitForStatus(ok.id, ['EXITED'])).toMatchObject({
      exitCode: 0,
      endReason: 'exited',
    });
    expect(await waitForStatus(failing.id, ['EXITED'])).toMatchObject({ exitCode: 7 });
    expect(isAlive(failing.pid!)).toBe(false);
  });

  it('runs ten concurrent terminals across projects with isolated output', async () => {
    await startHost();
    const projects = [await workspace('nova'), await workspace('wii'), await workspace('atlas')];
    const sessions: TerminalSession[] = [];
    for (let index = 0; index < 10; index += 1) {
      sessions.push(await open(projects[index % 3]!.id));
    }
    sessions.forEach((session, index) => run(session, `echo "marker-$((${index} * 11))-done"`));
    await Promise.all(
      sessions.map((session, index) =>
        waitForOutput(session, new RegExp(`marker-${index * 11}-done`)),
      ),
    );
    sessions.forEach((session, index) => {
      const others = sessions
        .map((_, other) => other)
        .filter((other) => other !== index)
        .map((other) => `marker-${other * 11}-done`);
      for (const marker of others) expect(outputOf(session)).not.toContain(marker);
      expect(session.cwd).toBe(projects[index % 3]!.workspacePath);
    });
    expect(host!.engine.terminals!.list(projects[0]!.id)).toHaveLength(4);
    expect(host!.engine.terminals!.activeCount()).toBe(10);
  });

  it('terminates one terminal without affecting the others and cleans up the process', async () => {
    await startHost();
    const project = await workspace('nova');
    const target = await open(project.id);
    const survivor = await open(project.id);
    run(target, 'sleep 60');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const ended = await host!.engine.terminals!.terminate(target.id);
    expect(ended).toMatchObject({ status: 'TERMINATED', endReason: 'user' });
    expect(isAlive(target.pid!)).toBe(false);

    run(survivor, 'echo "still-$((1 + 1))"');
    await waitForOutput(survivor, /still-2/);
  });

  it('restores the screen of a full-screen program for a new view', async () => {
    await startHost();
    const project = await workspace('nova');
    const session = await open(project.id);
    run(session, 'printf "\\033[?1049h\\033[2J\\033[HFULL-$((3 * 3))"; sleep 30');
    await waitForOutput(session, /FULL-9/);

    // A second view (e.g. after a renderer reload) gets the screen without a new PTY.
    const attachment = await host!.engine.terminals!.attach(session.id, 'reloaded', 80, 24);
    expect(attachment.snapshot).toContain('FULL-9');
    expect(attachment.snapshot).toContain('\x1b[?1049h');
    expect(host!.engine.terminals!.list()).toHaveLength(1);
  });

  it('never reports sessions of a stopped Engine as running', async () => {
    await startHost();
    const project = await workspace('nova');
    const graceful = await open(project.id);
    const pid = graceful.pid!;
    await host!.stop();
    expect(isAlive(pid)).toBe(false);

    await startHost();
    expect(host!.engine.terminals!.list()).toEqual([
      expect.objectContaining({
        id: graceful.id,
        status: 'TERMINATED',
        endReason: 'engine-shutdown',
      }),
    ]);

    // An Engine that dies without shutting down leaves sessions marked as lost.
    const crashed = await open(project.id);
    await host!.socket?.close();
    host!.engine.close();
    process.kill(crashed.pid!, 'SIGKILL');
    host = undefined;

    await startHost();
    expect(host!.engine.terminals!.getById(crashed.id)).toMatchObject({
      status: 'TERMINATED',
      endReason: 'engine-lost',
    });
  });

  it('rejects terminals for unregistered or unavailable projects', async () => {
    await startHost();
    const project = await workspace('gone');
    await expect(
      host!.engine.terminals!.create({ projectId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    const { rmSync } = await import('node:fs');
    rmSync(project.workspacePath, { recursive: true });
    await expect(host!.engine.terminals!.create({ projectId: project.id })).rejects.toMatchObject({
      code: 'PROJECT_PATH_UNAVAILABLE',
    });
  });

  describe('local socket for the CLI', () => {
    it('serves authenticated clients with a restricted method set', async () => {
      await startHost();
      const project = await workspace('nova');
      const client = await connectToEngine({ dataDir });
      try {
        const opened = await client.call('terminals.create', { projectId: project.id });
        expect(opened.status).toBe('RUNNING');
        expect(await client.call('terminals.list', { projectId: project.id })).toHaveLength(1);
        await expect(client.call('terminals.write', opened.id, 'echo hi\r')).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
        });
        await expect(client.call('projects.remove', project.id)).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
        });
        expect((await client.call('terminals.terminate', opened.id)).status).toBe('TERMINATED');
      } finally {
        client.close();
      }
    });

    it('keeps the run file private and drops clients with a wrong token', async () => {
      const { statSync } = await import('node:fs');
      await startHost();
      const info = JSON.parse(await readFile(runFilePath(dataDir), 'utf8')) as {
        endpoint: string;
      };
      expect(statSync(runFilePath(dataDir)).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(runFilePath(dataDir))).mode & 0o777).toBe(0o700);

      const socket = net.connect(info.endpoint);
      const closed = new Promise<string>((resolve) => {
        let received = '';
        socket.on('data', (chunk) => (received += chunk.toString()));
        socket.on('close', () => resolve(received));
      });
      socket.on('connect', () => {
        socket.write(encodeMessage({ type: 'hello', protocol: 1, token: 'guess' }));
        socket.write(
          encodeMessage({ type: 'request', id: 1, method: 'terminals.list', params: [{}] }),
        );
      });
      expect(await closed).toBe('');
    });

    it('reports a stopped Engine as unavailable and replaces stale sockets', async () => {
      await expect(connectToEngine({ dataDir })).rejects.toMatchObject({
        code: 'ENGINE_UNAVAILABLE',
      });
      await startHost();
      const endpoint = host!.socket!.endpoint;
      // Simulate a crash: the socket file and run file are left behind.
      await host!.socket!.close();
      writeFileSync(endpoint, '');
      host!.engine.close();
      host = undefined;

      await startHost();
      const client = await connectToEngine({ dataDir });
      expect((await client.call('engine.status')).activeTerminals).toBe(0);
      client.close();
    });

    it('refuses to start a second Engine for the same data directory', async () => {
      await startHost();
      await expect(startEngineHost({ dataDir, env })).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
    });
  });
});
