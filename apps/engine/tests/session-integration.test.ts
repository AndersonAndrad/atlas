import { chmodSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionChangedEvent } from '@atlas/contracts';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  createEngine,
  createEngineDispatcher,
  startEngineHost,
  type Engine,
  type EngineHost,
} from '../src/index.js';

/** ATLAS Sessions through the real Engine composition and SQLite database. */
describe('ATLAS Sessions in the Engine', () => {
  let temp: ReturnType<typeof createTempDir>;
  let dataDir: string;
  let host: EngineHost | undefined;
  let engines: Engine[];

  const startHost = async () => {
    host = await startEngineHost({
      dataDir,
      component: 'test',
      socket: false,
      terminals: {
        spawner: new FakePtySpawner(),
        mirrors: new FakeMirrorFactory(),
        shells: new FakeShellProvider(),
      },
    });
    return host;
  };
  /** A short-lived client such as the CLI: same services, no execution ownership. */
  const client = () => {
    const engine = createEngine({ dataDir, component: 'test' });
    engines.push(engine);
    return engine;
  };
  const directory = (name: string) => {
    const dir = path.join(temp.dir, 'workspaces', name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  beforeEach(() => {
    temp = createTempDir();
    dataDir = path.join(temp.dir, 'data');
    engines = [];
  });
  afterEach(async () => {
    await host?.stop();
    host = undefined;
    for (const engine of engines) engine.close();
    temp.cleanup();
  });

  it('persists sessions, tasks and events across Engine restarts', async () => {
    const engine = (await startHost()).engine;
    const project = await engine.projects.create({
      name: 'NOVA',
      workspacePath: directory('nova'),
    });
    const session = await engine.sessions.create({
      name: 'NOVA auth',
      objective: 'Implement authentication',
      projectId: project.id,
      executionProfile: 'MAXIMUM',
      constraints: ['Keep the public API'],
    });
    const task = await engine.sessions.addTask(session.id, { title: 'Design' });
    await engine.sessions.addTask(session.id, { title: 'Build', dependencies: [task.id] });
    await engine.sessions.perform(session.id, 'markReady');
    await engine.sessions.perform(session.id, 'start');
    await host!.stop();
    host = undefined;

    const restarted = (await startHost()).engine;
    const details = await restarted.sessions.getDetails(session.id);
    expect(details.session).toMatchObject({
      status: 'WAITING_EXECUTOR',
      executionProfile: 'MAXIMUM',
      constraints: ['Keep the public API'],
      startedAt: null,
    });
    expect(details.workspace).toMatchObject({ kind: 'project', projectName: 'NOVA' });
    expect(details.tasks.map((item) => [item.title, item.blockedBy.length])).toEqual([
      ['Design', 0],
      ['Build', 1],
    ]);
    expect(details).toMatchObject({ executing: false, executorAvailable: false });
    expect((await restarted.sessions.events(session.id)).map((event) => event.type)).toEqual([
      'SESSION_CREATED',
      'TASK_CREATED',
      'TASK_CREATED',
      'SESSION_READY',
      'SESSION_WAITING_EXECUTOR',
    ]);
  });

  it('marks sessions with work in flight as interrupted when the host starts', async () => {
    const engine = client();
    const session = await engine.sessions.create({ name: 'Running', objective: 'x' });
    const task = await engine.sessions.addTask(session.id, { title: 'Work' });
    // A previous host (with a future executor) stopped without recording the end.
    const db = new (await import('node:sqlite')).DatabaseSync(engine.databasePath);
    db.prepare("UPDATE atlas_sessions SET status = 'RUNNING' WHERE id = ?").run(session.id);
    db.prepare("UPDATE session_tasks SET status = 'IN_PROGRESS' WHERE id = ?").run(task.id);
    db.close();

    const started = (await startHost()).engine;
    const details = await started.sessions.getDetails(session.id);
    expect(details.session).toMatchObject({ status: 'INTERRUPTED', completedAt: null });
    expect(details.tasks[0]!.status).toBe('INTERRUPTED');
    expect(details.availableActions).toEqual(['resume', 'cancel']);
    expect((await started.sessions.events(session.id)).at(-1)).toMatchObject({
      type: 'SESSION_INTERRUPTED',
      metadata: { reason: 'engine-restart', from: 'RUNNING' },
    });
  });

  it('interrupts work in flight when the host stops', async () => {
    const started = await startHost();
    const session = await started.engine.sessions.create({ name: 'Running', objective: 'x' });
    const db = new (await import('node:sqlite')).DatabaseSync(started.engine.databasePath);
    db.prepare("UPDATE atlas_sessions SET status = 'WAITING_APPROVAL' WHERE id = ?").run(
      session.id,
    );
    db.close();
    await host!.stop();
    host = undefined;
    const engine = client();
    expect((await engine.sessions.get(session.id)).status).toBe('INTERRUPTED');
    expect((await engine.sessions.events(session.id)).at(-1)?.metadata).toMatchObject({
      reason: 'engine-shutdown',
      from: 'WAITING_APPROVAL',
    });
  });

  it('never reconciles from short-lived clients', async () => {
    const engine = client();
    const session = await engine.sessions.create({ name: 'Running', objective: 'x' });
    const db = new (await import('node:sqlite')).DatabaseSync(engine.databasePath);
    db.prepare("UPDATE atlas_sessions SET status = 'RUNNING' WHERE id = ?").run(session.id);
    db.close();
    const other = client();
    await other.initialize();
    expect((await other.sessions.get(session.id)).status).toBe('RUNNING');
  });

  it('keeps sessions when their project is removed or unavailable', async () => {
    const engine = (await startHost()).engine;
    const dir = directory('bank');
    const project = await engine.projects.create({ name: 'Bank', workspacePath: dir });
    const first = await engine.sessions.create({
      name: 'A',
      objective: 'x',
      projectId: project.id,
    });
    const second = await engine.sessions.create({
      name: 'B',
      objective: 'y',
      projectId: project.id,
    });

    renameSync(dir, `${dir}-moved`);
    expect((await engine.sessions.getDetails(first.id)).workspace).toMatchObject({
      kind: 'project',
      available: false,
    });
    await expect(engine.sessions.perform(first.id, 'markReady')).rejects.toMatchObject({
      code: 'PROJECT_PATH_UNAVAILABLE',
    });
    renameSync(`${dir}-moved`, dir);

    await engine.removeProject(project.id);
    for (const id of [first.id, second.id]) {
      expect(await engine.sessions.get(id)).toMatchObject({ projectId: null, workspacePath: dir });
    }
    expect((await engine.sessions.perform(first.id, 'markReady')).status).toBe('READY');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses to prepare a session in a directory it cannot write',
    async () => {
      const engine = client();
      const dir = directory('read-only');
      const session = await engine.sessions.create({
        name: 'RO',
        objective: 'x',
        workspacePath: dir,
      });
      chmodSync(dir, 0o555);
      try {
        await expect(engine.sessions.perform(session.id, 'markReady')).rejects.toMatchObject({
          code: 'PROJECT_PERMISSION_DENIED',
        });
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  it('detects concurrent changes from another process', async () => {
    const a = client();
    const b = client();
    const session = await a.sessions.create({ name: 'Shared', objective: 'x' });
    // Both clients act on the same stored revision; exactly one succeeds.
    const results = await Promise.allSettled([
      a.sessions.perform(session.id, 'markReady'),
      b.sessions.perform(session.id, 'cancel'),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({
          code: expect.stringMatching(/SESSION_(CONFLICT|TRANSITION_INVALID)/),
        });
      }
    }
    const events = await a.sessions.events(session.id);
    expect(events).toHaveLength(1 + fulfilled.length);
  });

  it('publishes change events to the host clients', async () => {
    const started = await startHost();
    const received: SessionChangedEvent[] = [];
    started.onSessionChanged((event) => received.push(event));
    const session = await started.engine.sessions.create({ name: 'Live', objective: 'x' });
    await started.engine.sessions.addTask(session.id, { title: 'One' });
    expect(received).toEqual([
      { type: 'session-changed', sessionId: session.id },
      { type: 'session-changed', sessionId: session.id },
    ]);
  });

  it('validates every request and limits CLI clients to read and lifecycle methods', async () => {
    const dispatcher = createEngineDispatcher(client());
    const created = (await dispatcher.call(
      'sessions.create',
      [{ name: 'CLI', objective: 'x' }],
      'cli',
    )) as { id: string };
    await expect(
      dispatcher.call('sessions.perform', [created.id, 'complete'], 'cli'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(dispatcher.call('sessions.get', ['../etc'], 'desktop')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      dispatcher.call('sessions.addTask', [created.id, { title: 'x' }], 'cli'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      dispatcher.call('sessions.setSettings', [{ maxConcurrentSessions: 2 }], 'cli'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      dispatcher.call('sessions.create', [{ name: 'x', objective: 'y', status: 'RUNNING' }], 'cli'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await dispatcher.call('sessions.perform', [created.id, 'cancel'], 'cli')).toMatchObject({
      status: 'CANCELLED',
    });
  });
});
