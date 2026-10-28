import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineMethod, EngineMethodResults, Project } from '@atlas/contracts';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createTempDir } from '../../../tests/support/temp.js';
import { createEngine, createEngineDispatcher, type Engine } from '../src/index.js';

/** Quick commands in every project or in selected ones (PLAN-023, SDD-025 Task 03). */
describe('Quick commands', () => {
  let temp: ReturnType<typeof createTempDir>;
  let engine: Engine;
  let spawner: FakePtySpawner;
  let web: Project;
  let api: Project;
  const call = async <M extends EngineMethod>(
    method: M,
    ...params: unknown[]
  ): Promise<EngineMethodResults[M]> =>
    (await createEngineDispatcher(engine).call(
      method,
      params,
      'desktop',
    )) as EngineMethodResults[M];
  const project = async (name: string) => {
    const dir = path.join(temp.dir, name);
    mkdirSync(dir);
    return engine.projects.create({ name, workspacePath: dir });
  };
  const offered = async (projectId: string) =>
    (await call('projects.actions', projectId)).flatMap((action) =>
      action.kind === 'run-command' ? [action.name] : [],
    );

  beforeEach(async () => {
    temp = createTempDir();
    spawner = new FakePtySpawner();
    engine = createEngine({
      dataDir: path.join(temp.dir, 'data'),
      component: 'test',
      terminals: { spawner, mirrors: new FakeMirrorFactory(), shells: new FakeShellProvider() },
    });
    await engine.initialize();
    web = await project('web');
    api = await project('api');
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('offers a command everywhere without projects, and only in its projects otherwise', async () => {
    const all = await call('quickCommands.create', {
      name: ' Status ',
      command: ' git status ',
      projectIds: [],
    });
    expect(all).toMatchObject({ name: 'Status', command: 'git status', scope: 'ALL' });
    const one = await call('quickCommands.create', {
      name: 'Dev',
      command: 'npm run dev',
      projectIds: [web.id],
    });
    const both = await call('quickCommands.create', {
      name: 'Test',
      command: 'pnpm test',
      projectIds: [api.id, web.id],
    });
    expect(both).toMatchObject({ scope: 'PROJECTS', projectIds: [api.id, web.id] });
    expect(await offered(web.id)).toEqual(['Status', 'Dev', 'Test']);
    expect(await offered(api.id)).toEqual(['Status', 'Test']);

    // Scoped to global and back, in place: one record, same id.
    await call('quickCommands.update', one.id, {
      name: 'Dev',
      command: 'npm run dev',
      projectIds: [],
    });
    expect(await offered(api.id)).toEqual(['Status', 'Dev', 'Test']);
    await call('quickCommands.update', one.id, {
      name: 'Dev',
      command: 'npm run dev',
      projectIds: [api.id],
    });
    expect(await offered(web.id)).toEqual(['Status', 'Test']);
    expect((await call('quickCommands.list')).map((command) => command.id)).toEqual([
      all.id,
      one.id,
      both.id,
    ]);
  });

  it('adds or removes a project from the project details, never for global commands', async () => {
    const all = await call('quickCommands.create', { name: 'A', command: 'ls', projectIds: [] });
    const lint = await call('quickCommands.create', {
      name: 'Lint',
      command: 'npm run lint',
      projectIds: [web.id],
    });
    expect(
      await call('quickCommands.setAssignment', {
        commandId: lint.id,
        projectId: api.id,
        assigned: true,
      }),
    ).toMatchObject({ projectIds: [web.id, api.id] });
    await call('quickCommands.setAssignment', {
      commandId: lint.id,
      projectId: web.id,
      assigned: false,
    });
    const last = await call('quickCommands.setAssignment', {
      commandId: lint.id,
      projectId: api.id,
      assigned: false,
    });
    // Its last project removed: available nowhere, not everywhere.
    expect(last).toMatchObject({ scope: 'PROJECTS', projectIds: [] });
    expect(await offered(api.id)).toEqual(['A']);
    await expect(
      call('quickCommands.setAssignment', {
        commandId: all.id,
        projectId: web.id,
        assigned: false,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('runs a command only where it is offered, in a new terminal', async () => {
    const dev = await call('quickCommands.create', {
      name: 'Dev server',
      command: 'npm run dev',
      projectIds: [web.id],
    });
    const status = await call('quickCommands.create', {
      name: 'Status',
      command: 'git status',
      projectIds: [],
    });
    const terminal = await call('quickCommands.run', { projectId: web.id, commandId: dev.id });
    expect(terminal).toMatchObject({ projectId: web.id, title: 'Dev server' });
    expect(spawner.last().written.join('')).toBe('npm run dev\r');

    // Another project, or no project, cannot run a command limited to projects.
    await expect(
      call('quickCommands.run', { projectId: api.id, commandId: dev.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(call('quickCommands.run', { commandId: dev.id })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    // A command of all projects runs without one, in the default folder: one terminal only.
    const before = engine.terminals!.list().length;
    const plain = await call('quickCommands.run', { commandId: status.id });
    expect(plain.projectId).toBeNull();
    expect(engine.terminals!.list()).toHaveLength(before + 1);
    expect(spawner.last().written.join('')).toBe('git status\r');
    // Commands sent by the renderer are never run: only stored ones, by id.
    await expect(
      call('quickCommands.run', { projectId: web.id, command: 'rm -rf /' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('keeps scopes when projects are renamed, removed or missing their folder', async () => {
    const test = await call('quickCommands.create', {
      name: 'Test',
      command: 'pnpm test',
      projectIds: [web.id],
    });
    await engine.projects.update(web.id, { name: 'web renamed' });
    expect((await call('quickCommands.list'))[0]!.projectIds).toEqual([web.id]);

    rmSync(path.join(temp.dir, 'web'), { recursive: true });
    await expect(
      call('quickCommands.run', { projectId: web.id, commandId: test.id }),
    ).rejects.toMatchObject({ code: 'PROJECT_PATH_UNAVAILABLE' });

    await engine.removeProject(web.id);
    expect((await call('quickCommands.list'))[0]).toMatchObject({
      scope: 'PROJECTS',
      projectIds: [],
    });
    expect(await offered(api.id)).toEqual([]);
  });

  it('refuses invalid commands, unknown projects and ids, and more than the limit', async () => {
    const create = (input: Record<string, unknown>) =>
      call('quickCommands.create', { name: 'x', command: 'ls', projectIds: [], ...input });
    await expect(create({ command: 'npm i\nnpm run dev' })).rejects.toThrow();
    await expect(create({ name: '' })).rejects.toThrow();
    await expect(create({ command: 'x'.repeat(1001) })).rejects.toThrow();
    await expect(create({ projectIds: [web.id, web.id] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      create({ projectIds: ['20000000-0000-4000-8000-000000000002'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(create({ projectIds: ['../web'] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(create({ prioritized: true })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const missing = '00000000-0000-4000-8000-999999999999';
    await expect(call('quickCommands.remove', missing)).rejects.toMatchObject({
      code: 'QUICK_COMMAND_NOT_FOUND',
    });
    await expect(call('quickCommands.move', missing, 'down')).rejects.toMatchObject({
      code: 'QUICK_COMMAND_NOT_FOUND',
    });
    await expect(
      call('quickCommands.update', missing, { name: 'x', command: 'ls', projectIds: [] }),
    ).rejects.toMatchObject({ code: 'QUICK_COMMAND_NOT_FOUND' });
    await Promise.all(Array.from({ length: 100 }, (_, index) => create({ name: `c${index}` })));
    await expect(create({ name: 'one more' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await call('quickCommands.list')).toHaveLength(100);
  });

  it('moves commands and keeps them after a restart', async () => {
    const a = await call('quickCommands.create', { name: 'A', command: 'a', projectIds: [] });
    const b = await call('quickCommands.create', {
      name: 'B',
      command: 'b',
      projectIds: [api.id],
    });
    expect((await call('quickCommands.move', b.id, 'up')).map((c) => c.name)).toEqual(['B', 'A']);
    expect((await call('quickCommands.move', b.id, 'up')).map((c) => c.name)).toEqual(['B', 'A']);
    await engine.shutdown();
    engine = createEngine({
      dataDir: path.join(temp.dir, 'data'),
      component: 'test',
      terminals: { spawner, mirrors: new FakeMirrorFactory(), shells: new FakeShellProvider() },
    });
    await engine.initialize();
    expect(await call('quickCommands.list')).toEqual([
      { id: b.id, name: 'B', command: 'b', scope: 'PROJECTS', projectIds: [api.id] },
      { id: a.id, name: 'A', command: 'a', scope: 'ALL', projectIds: [] },
    ]);
  });
});
