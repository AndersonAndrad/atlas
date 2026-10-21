import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineMethod, EngineMethodResults } from '@atlas/contracts';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createTempDir } from '../../../tests/support/temp.js';
import { createEngine, createEngineDispatcher, type Engine } from '../src/index.js';
import { QUICK_COMMANDS_KEY, QuickCommandStore } from '../src/quick-commands.js';

class MemoryStore {
  readonly values = new Map<string, string>();
  get(key: string) {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string) {
    this.values.delete(key);
    return Promise.resolve();
  }
}

describe('Quick command store (PLAN-023)', () => {
  let ids = 0;
  const id = () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`;
  const project = '10000000-0000-4000-8000-000000000001';
  let store: MemoryStore;
  let commands: QuickCommandStore;
  beforeEach(() => {
    store = new MemoryStore();
    commands = new QuickCommandStore({ store, generateId: id });
  });

  it('keeps an ordered library and offers prioritized commands not hidden in a project', async () => {
    const dev = await commands.create({
      name: ' Dev ',
      command: ' npm run dev ',
      prioritized: true,
    });
    expect(dev).toMatchObject({ name: 'Dev', command: 'npm run dev' });
    const test = await commands.create({
      name: 'Test',
      command: 'go test ./...',
      prioritized: true,
    });
    await commands.create({ name: 'Lint', command: 'npm run lint', prioritized: false });

    expect((await commands.move(test.id, 'up')).map((c) => c.name)).toEqual([
      'Test',
      'Dev',
      'Lint',
    ]);
    // The first command cannot move further up.
    expect((await commands.move(test.id, 'up')).map((c) => c.name)).toEqual([
      'Test',
      'Dev',
      'Lint',
    ]);
    expect(await commands.projectActions(project)).toEqual([
      { kind: 'open-terminal' },
      { kind: 'run-command', commandId: test.id, name: 'Test', command: 'go test ./...' },
      { kind: 'run-command', commandId: dev.id, name: 'Dev', command: 'npm run dev' },
    ]);

    await commands.setProjectSettings(project, { hidden: [dev.id, dev.id], enabled: [] });
    expect(await commands.projectSettings(project)).toEqual({ hidden: [dev.id], enabled: [] });
    expect((await commands.projectActions(project)).map((a) => a.kind)).toEqual([
      'open-terminal',
      'run-command',
    ]);
    await expect(commands.forProject(project, dev.id)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    // Other projects still offer it.
    expect((await commands.forProject('other', dev.id)).command).toBe('npm run dev');

    await commands.update(dev.id, {
      name: 'Dev server',
      command: 'npm run dev',
      prioritized: false,
    });
    expect((await commands.list()).find((c) => c.id === dev.id)?.name).toBe('Dev server');
    await commands.remove(test.id);
    expect((await commands.list()).map((c) => c.name)).toEqual(['Dev server', 'Lint']);
    // Hidden ids of removed commands are dropped when the settings are saved.
    expect(
      await commands.setProjectSettings(project, {
        hidden: [dev.id, '00000000-0000-4000-8000-999999999999'],
        enabled: ['00000000-0000-4000-8000-999999999999'],
      }),
    ).toEqual({ hidden: [dev.id], enabled: [] });
    await commands.removeProject(project);
    expect(await commands.projectSettings(project)).toEqual({ hidden: [], enabled: [] });
  });

  it('offers other commands only in projects that enable them (PLAN-023 revision 2)', async () => {
    const other = '10000000-0000-4000-8000-000000000002';
    const lint = await commands.create({
      name: 'Lint',
      command: 'npm run lint',
      prioritized: false,
    });
    const all = await commands.create({ name: 'Status', command: 'git status', prioritized: true });
    expect((await commands.projectActions(project)).map((a) => a.kind)).toEqual([
      'open-terminal',
      'run-command',
    ]);
    await commands.setProjectSettings(project, { hidden: [], enabled: [lint.id] });
    // Library order: Lint comes before Status.
    expect(
      (await commands.projectActions(project)).flatMap((a) =>
        a.kind === 'run-command' ? [a.name] : [],
      ),
    ).toEqual(['Lint', 'Status']);
    expect((await commands.forProject(project, lint.id)).name).toBe('Lint');
    await expect(commands.forProject(other, lint.id)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    // Prioritizing an enabled command shows it everywhere; the project keeps its choice.
    await commands.update(lint.id, { name: 'Lint', command: 'npm run lint', prioritized: true });
    expect((await commands.forProject(other, lint.id)).name).toBe('Lint');
    await commands.update(lint.id, { name: 'Lint', command: 'npm run lint', prioritized: false });
    expect((await commands.forProject(project, lint.id)).name).toBe('Lint');
    expect(all.prioritized).toBe(true);

    // Settings saved by revision 1 (no `enabled`) still read.
    store.values.set(`quickCommands.project.${other}`, JSON.stringify({ hidden: [all.id] }));
    expect(await commands.projectSettings(other)).toEqual({ hidden: [all.id], enabled: [] });
    store.values.set(`quickCommands.project.${other}`, '["bad"]');
    expect(await commands.projectSettings(other)).toEqual({ hidden: [], enabled: [] });
  });

  it('refuses invalid commands, unknown ids and more than the limit', async () => {
    await expect(
      commands.create({ name: 'Two lines', command: 'npm i\nnpm run dev', prioritized: true }),
    ).rejects.toThrow();
    await expect(commands.create({ name: '', command: 'ls', prioritized: true })).rejects.toThrow();
    await expect(
      commands.create({ name: 'Long', command: 'x'.repeat(1001), prioritized: true }),
    ).rejects.toThrow();
    const missing = '00000000-0000-4000-8000-999999999999';
    await expect(commands.remove(missing)).rejects.toMatchObject({
      code: 'QUICK_COMMAND_NOT_FOUND',
    });
    await expect(commands.move(missing, 'down')).rejects.toMatchObject({
      code: 'QUICK_COMMAND_NOT_FOUND',
    });
    for (let index = 0; index < 100; index += 1) {
      await commands.create({ name: `c${index}`, command: 'ls', prioritized: false });
    }
    await expect(
      commands.create({ name: 'one more', command: 'ls', prioritized: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('shows nothing for an unreadable stored library and keeps concurrent writes', async () => {
    store.values.set(QUICK_COMMANDS_KEY, '{"version":2,"commands":[]}');
    expect(await commands.list()).toEqual([]);
    store.values.set(QUICK_COMMANDS_KEY, 'not json');
    expect(await commands.list()).toEqual([]);
    store.values.delete(QUICK_COMMANDS_KEY);
    await Promise.all(
      ['a', 'b', 'c'].map((name) => commands.create({ name, command: name, prioritized: true })),
    );
    expect((await commands.list()).map((c) => c.name).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('Running quick commands (PLAN-023)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let engine: Engine;
  let spawner: FakePtySpawner;
  const call = async <M extends EngineMethod>(
    method: M,
    ...params: unknown[]
  ): Promise<EngineMethodResults[M]> =>
    (await createEngineDispatcher(engine).call(
      method,
      params,
      'desktop',
    )) as EngineMethodResults[M];

  beforeEach(async () => {
    temp = createTempDir();
    spawner = new FakePtySpawner();
    engine = createEngine({
      dataDir: path.join(temp.dir, 'data'),
      component: 'test',
      terminals: { spawner, mirrors: new FakeMirrorFactory(), shells: new FakeShellProvider() },
    });
    await engine.initialize();
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('opens a terminal in the project named after the command and types it', async () => {
    const dir = path.join(temp.dir, 'web');
    mkdirSync(dir);
    const project = await engine.projects.create({ name: 'web', workspacePath: dir });
    const dev = await call('quickCommands.create', {
      name: 'Dev server',
      command: 'npm run dev',
      prioritized: true,
    });
    const terminal = await call('quickCommands.run', { projectId: project.id, commandId: dev.id });
    expect(terminal).toMatchObject({ projectId: project.id, title: 'Dev server' });
    expect(spawner.last().written.join('')).toBe('npm run dev\r');

    expect((await call('projects.actions', project.id)).length).toBe(2);
    await call('quickCommands.setProjectSettings', project.id, { hidden: [dev.id], enabled: [] });
    await expect(
      call('quickCommands.run', { projectId: project.id, commandId: dev.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // Commands sent by the renderer are never run: only stored ones, by id.
    await expect(
      call('quickCommands.run', { projectId: project.id, command: 'rm -rf /' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      call('quickCommands.projectSettings', '20000000-0000-4000-8000-000000000002'),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    await engine.removeProject(project.id);
    expect(await engine.quickCommands.projectSettings(project.id)).toEqual({
      hidden: [],
      enabled: [],
    });
  });
});
