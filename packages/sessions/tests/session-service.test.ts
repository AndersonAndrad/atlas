import { describe, expect, it } from 'vitest';
import { SessionService, SessionSettingsStore } from '../src/index.js';
import { FakeWorkspaces, InMemorySessionRepository } from './fakes.js';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const OTHER_PROJECT = '00000000-0000-4000-8000-000000000002';

function setup() {
  const repository = new InMemorySessionRepository();
  const workspaces = new FakeWorkspaces();
  workspaces.directories.add('/work/nova');
  workspaces.directories.add('/work/loose');
  workspaces.projects.set(PROJECT, {
    id: PROJECT,
    name: 'NOVA',
    workspacePath: '/work/nova',
  });
  let counter = 0;
  let time = Date.parse('2026-10-20T10:00:00Z');
  const service = new SessionService({
    sessions: repository,
    workspaces,
    clock: { now: () => new Date((time += 1000)) },
    generateId: () => `00000000-0000-4000-9000-${String(++counter).padStart(12, '0')}`,
  });
  const changes: string[] = [];
  service.onChange((event) => changes.push(event.sessionId));
  return { repository, workspaces, service, changes };
}

const base = { name: 'NOVA auth', objective: 'Implement authentication' };

describe('SessionService', () => {
  it('creates draft sessions without any provider or workspace', async () => {
    const { service, repository, changes } = setup();
    const session = await service.create(base);
    expect(session).toMatchObject({
      status: 'DRAFT',
      executionProfile: 'BALANCED',
      projectId: null,
      workspacePath: null,
      constraints: [],
      startedAt: null,
      completedAt: null,
    });
    expect(repository.events.map((event) => event.type)).toEqual(['SESSION_CREATED']);
    expect(changes).toEqual([session.id]);
  });

  it('validates input, project and directory references', async () => {
    const { service } = setup();
    await expect(service.create({ name: '', objective: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(service.create({ ...base, executionProfile: 'TURBO' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      service.create({ ...base, projectId: PROJECT, workspacePath: '/work/loose' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.create({ ...base, projectId: OTHER_PROJECT })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(service.create({ ...base, workspacePath: '/missing' })).rejects.toMatchObject({
      code: 'PROJECT_PATH_UNAVAILABLE',
    });
    await expect(
      service.create({ ...base, constraints: Array.from({ length: 21 }, () => 'c') }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('keeps several independent sessions for the same and other projects', async () => {
    const { service, workspaces } = setup();
    workspaces.projects.set(OTHER_PROJECT, {
      id: OTHER_PROJECT,
      name: 'Bank',
      workspacePath: '/work/loose',
    });
    const a = await service.create({ ...base, projectId: PROJECT, executionProfile: 'ECONOMY' });
    const b = await service.create({ ...base, name: 'Tests', projectId: PROJECT });
    const c = await service.create({ ...base, name: 'Bank', projectId: OTHER_PROJECT });
    await service.perform(a.id, 'markReady');
    await service.perform(a.id, 'start');

    const list = await service.list();
    expect(list.map((item) => item.session.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(list.find((item) => item.session.id === a.id)?.projectName).toBe('NOVA');
    expect((await service.get(a.id)).status).toBe('WAITING_EXECUTOR');
    expect((await service.get(b.id)).status).toBe('DRAFT');
    expect((await service.list({ projectId: OTHER_PROJECT })).map((i) => i.session.id)).toEqual([
      c.id,
    ]);
    expect((await service.events(b.id)).map((event) => event.type)).toEqual(['SESSION_CREATED']);
  });

  it('runs the user lifecycle and records transitions', async () => {
    const { service } = setup();
    const { id } = await service.create({ ...base, workspacePath: '/work/loose' });
    await service.perform(id, 'markReady');
    await service.perform(id, 'returnToDraft');
    await service.perform(id, 'markReady');
    const started = await service.perform(id, 'start');
    expect(started).toMatchObject({ status: 'WAITING_EXECUTOR', startedAt: null });
    await service.perform(id, 'pause');
    expect((await service.perform(id, 'resume')).status).toBe('WAITING_EXECUTOR');
    const cancelled = await service.perform(id, 'cancel');
    expect(cancelled).toMatchObject({ status: 'CANCELLED', completedAt: null });
    expect(cancelled.endedAt).not.toBeNull();
    const archived = await service.perform(id, 'archive');
    expect(archived.archivedAt).not.toBeNull();

    expect((await service.events(id)).map((event) => event.type)).toEqual([
      'SESSION_CREATED',
      'SESSION_READY',
      'SESSION_RETURNED_TO_DRAFT',
      'SESSION_READY',
      'SESSION_WAITING_EXECUTOR',
      'SESSION_PAUSED',
      'SESSION_RESUMED',
      'SESSION_CANCELLED',
      'SESSION_ARCHIVED',
    ]);
    expect((await service.list()).length).toBe(0);
    expect((await service.list({ includeArchived: true })).length).toBe(1);
  });

  it('rejects invalid transitions without changing anything', async () => {
    const { service, repository } = setup();
    const { id } = await service.create(base);
    for (const action of ['start', 'pause', 'resume', 'archive', 'returnToDraft']) {
      await expect(service.perform(id, action)).rejects.toMatchObject({
        code: 'SESSION_TRANSITION_INVALID',
      });
    }
    await expect(service.perform(id, 'complete')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await service.perform(id, 'cancel');
    await expect(service.perform(id, 'markReady')).rejects.toMatchObject({
      code: 'SESSION_TRANSITION_INVALID',
    });
    expect(repository.events).toHaveLength(2);
  });

  it('checks workspace access before preparing a session for execution', async () => {
    const { service, workspaces } = setup();
    const { id } = await service.create({ ...base, workspacePath: '/work/loose' });
    workspaces.readOnly.add('/work/loose');
    await expect(service.perform(id, 'markReady')).rejects.toMatchObject({
      code: 'PROJECT_PERMISSION_DENIED',
    });
    workspaces.readOnly.clear();
    await service.perform(id, 'markReady');
    workspaces.directories.delete('/work/loose');
    await expect(service.perform(id, 'start')).rejects.toMatchObject({
      code: 'PROJECT_PATH_UNAVAILABLE',
    });
    expect((await service.getDetails(id)).workspace).toEqual({
      kind: 'directory',
      path: '/work/loose',
      available: false,
    });
  });

  it('edits only drafts and records changed field names, not their contents', async () => {
    const { service } = setup();
    const { id } = await service.create(base);
    await service.update(id, {
      objective: 'Secret token sk-123 must not leak',
      projectId: PROJECT,
      constraints: ['x'],
    });
    const events = await service.events(id);
    expect(events.at(-1)).toMatchObject({
      type: 'SESSION_UPDATED',
      metadata: { fields: ['objective', 'projectId', 'constraints'] },
    });
    expect(JSON.stringify(events)).not.toContain('sk-123');
    await service.perform(id, 'markReady');
    await expect(service.update(id, { name: 'Other' })).rejects.toMatchObject({
      code: 'SESSION_TRANSITION_INVALID',
    });
  });

  it('plans tasks with dependencies and rejects cycles', async () => {
    const { service } = setup();
    const { id } = await service.create(base);
    const design = await service.addTask(id, { title: 'Design' });
    const build = await service.addTask(id, { title: 'Build', dependencies: [design.id] });
    expect(build.blockedBy).toEqual([design.id]);
    await expect(
      service.updateTask(id, design.id, { dependencies: [build.id] }),
    ).rejects.toMatchObject({ code: 'SESSION_TASK_CYCLE' });
    await expect(
      service.addTask(id, { title: 'Bad', dependencies: ['00000000-0000-4000-8000-0000000000ff'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.removeTask(id, design.id)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    const tasks = await service.tasks(id);
    expect(tasks.map((task) => task.title)).toEqual(['Design', 'Build']);
    expect(tasks[0]!.dependencies).toEqual([]);

    await service.cancelTask(id, build.id);
    await service.removeTask(id, build.id);
    expect((await service.tasks(id)).map((task) => task.title)).toEqual(['Design']);
    expect((await service.events(id)).map((event) => event.type).slice(1)).toEqual([
      'TASK_CREATED',
      'TASK_CREATED',
      'TASK_CANCELLED',
      'TASK_REMOVED',
    ]);
  });

  it('cancels unfinished tasks with the session and freezes the plan', async () => {
    const { service } = setup();
    const { id } = await service.create(base);
    await service.addTask(id, { title: 'One' });
    await service.addTask(id, { title: 'Two' });
    await service.perform(id, 'cancel');
    expect((await service.tasks(id)).map((task) => task.status)).toEqual([
      'CANCELLED',
      'CANCELLED',
    ]);
    expect((await service.events(id)).at(-1)?.metadata).toMatchObject({ taskCount: 2 });
    await expect(service.addTask(id, { title: 'Late' })).rejects.toMatchObject({
      code: 'SESSION_TRANSITION_INVALID',
    });
  });

  it('interrupts sessions with work in flight and never resumes them automatically', async () => {
    const { service, repository } = setup();
    const running = await service.create(base);
    const waiting = await service.create({ ...base, name: 'Waiting' });
    const task = await service.addTask(running.id, { title: 'Work' });
    repository.force(running.id, 'RUNNING');
    repository.tasks.get(task.id)!.status = 'IN_PROGRESS';
    await service.perform(waiting.id, 'markReady');
    await service.perform(waiting.id, 'start');

    expect(await service.reconcile('engine-restart')).toBe(1);
    expect((await service.get(running.id)).status).toBe('INTERRUPTED');
    expect((await service.get(running.id)).completedAt).toBeNull();
    expect((await service.tasks(running.id))[0]!.status).toBe('INTERRUPTED');
    expect((await service.events(running.id)).at(-1)).toMatchObject({
      type: 'SESSION_INTERRUPTED',
      metadata: { from: 'RUNNING', to: 'INTERRUPTED', reason: 'engine-restart', taskCount: 1 },
    });
    expect((await service.get(waiting.id)).status).toBe('WAITING_EXECUTOR');
    expect(await service.reconcile('engine-restart')).toBe(0);
    expect((await service.perform(running.id, 'resume')).status).toBe('WAITING_EXECUTOR');
  });

  it('keeps the directory of sessions whose project is removed', async () => {
    const { service } = setup();
    const { id } = await service.create({ ...base, projectId: PROJECT });
    expect(await service.detachProject(PROJECT, '/work/nova')).toBe(1);
    const session = await service.get(id);
    expect(session).toMatchObject({ projectId: null, workspacePath: '/work/nova' });
    expect((await service.events(id)).at(-1)).toMatchObject({
      type: 'SESSION_PROJECT_DETACHED',
      metadata: { reason: 'project-removed' },
    });
  });

  it('rejects changes based on a stale revision', async () => {
    const { service, repository } = setup();
    const { id } = await service.create(base);
    const stored = (await repository.findById(id))!;
    await service.perform(id, 'markReady');
    expect(
      await repository.commit({
        sessionId: id,
        expectedRevision: stored.revision,
        session: { ...stored.session, name: 'Stale' },
        events: [],
      }),
    ).toBe(false);
    expect((await service.get(id)).name).toBe(base.name);
  });

  it('reports a conflict instead of overwriting a concurrent change', async () => {
    const { service, repository, changes } = setup();
    const { id } = await service.create(base);
    repository.commit = async () => false;
    await expect(service.perform(id, 'markReady')).rejects.toMatchObject({
      code: 'SESSION_CONFLICT',
    });
    expect(changes).toEqual([id]);
    expect((await service.get(id)).status).toBe('DRAFT');
  });

  it('reports unknown sessions and tasks', async () => {
    const { service } = setup();
    await expect(service.get('00000000-0000-4000-8000-00000000abcd')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    await expect(service.get('not-a-uuid')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const { id } = await service.create(base);
    await expect(
      service.cancelTask(id, '00000000-0000-4000-8000-00000000abcd'),
    ).rejects.toMatchObject({ code: 'SESSION_TASK_NOT_FOUND' });
  });
});

describe('SessionSettingsStore', () => {
  const store = () => {
    const values = new Map<string, string>();
    return new SessionSettingsStore({
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => void values.set(key, value),
    });
  };

  it('provides profile defaults and validates updates', async () => {
    const settings = store();
    expect(await settings.get()).toEqual({
      maxConcurrentSessions: 3,
      profiles: {
        ECONOMY: { maxParallelTasks: 1 },
        BALANCED: { maxParallelTasks: 2 },
        MAXIMUM: { maxParallelTasks: 4 },
      },
    });
    const updated = await settings.update({
      maxConcurrentSessions: 5,
      profiles: {
        ECONOMY: { maxParallelTasks: 2 },
        BALANCED: { maxParallelTasks: 2 },
        MAXIMUM: { maxParallelTasks: 8 },
      },
    });
    expect(updated.maxConcurrentSessions).toBe(5);
    expect(await settings.get()).toEqual(updated);
  });

  it('rejects out-of-range limits, inverted profiles and security fields', async () => {
    const settings = store();
    await expect(settings.update({ maxConcurrentSessions: 0 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      settings.update({
        profiles: {
          ECONOMY: { maxParallelTasks: 4 },
          BALANCED: { maxParallelTasks: 2 },
          MAXIMUM: { maxParallelTasks: 8 },
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // Profiles carry planning limits only; there is nothing that could weaken security.
    await expect(
      settings.update({
        profiles: {
          ECONOMY: { maxParallelTasks: 1 },
          BALANCED: { maxParallelTasks: 2 },
          MAXIMUM: { maxParallelTasks: 4, skipApprovals: true },
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
