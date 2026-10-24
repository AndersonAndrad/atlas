import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TerminalEvent } from '@atlas/contracts';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createTempDir } from '../../../tests/support/temp.js';
import { createEngine, createEngineDispatcher, type Engine } from '../src/index.js';

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('Engine notes (SDD-010 Milestone A)', { timeout: 30_000 }, () => {
  let temp: ReturnType<typeof createTempDir>;
  let engine: Engine;
  let dir: string;
  let events: TerminalEvent[];
  const env = () => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: path.join(temp.dir, 'home'),
    SHELL: '/bin/sh',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env: env(), encoding: 'utf8' });

  const open = () =>
    createEngine({
      dataDir: path.join(temp.dir, 'data'),
      component: 'test',
      env: env(),
      terminals: {
        spawner: new FakePtySpawner(),
        mirrors: new FakeMirrorFactory(),
        shells: new FakeShellProvider(),
      },
    });

  beforeEach(async () => {
    temp = createTempDir();
    mkdirSync(path.join(temp.dir, 'home'));
    dir = path.join(temp.dir, 'repo');
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Ana');
    git('config', 'user.email', 'ana@example.com');
    writeFileSync(path.join(dir, 'docs', 'api.md'), '# API\n');
    git('add', '.');
    git('commit', '-qm', 'chore: init');
    git('branch', 'feature/notes');
    engine = open();
    await engine.initialize();
    events = [];
    engine.terminals!.onEvent((event) => events.push(event));
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('keeps notes across restarts (Scenario A) and publishes changes', async () => {
    const project = await engine.projects.create({ name: 'App', workspacePath: dir });
    const note = await engine.notes.create({
      projectId: project.id,
      title: 'Decisions',
      content: '- Use SQLite FTS5 for search',
    });
    expect(events).toContainEqual({ type: 'notes', noteId: note.id });
    await engine.shutdown();

    engine = open();
    await engine.initialize();
    const list = await engine.notes.list({
      scope: { kind: 'project', projectId: project.id },
      search: 'fts5',
    });
    expect(list.notes.map((item) => item.title)).toEqual(['Decisions']);
    expect((await engine.notes.get(note.id)).content).toBe('- Use SQLite FTS5 for search');
  });

  it('keeps notes of a removed project in its folder for a new registration (Q2)', async () => {
    const project = await engine.projects.create({ name: 'App', workspacePath: dir });
    const note = await engine.notes.create({ projectId: project.id, title: 'Kept', content: '' });
    await engine.removeProject(project.id);
    expect(await engine.notes.get(note.id)).toMatchObject({ projectId: null });
    expect((await engine.notes.list({ scope: { kind: 'all' } })).notes).toHaveLength(1);

    const again = await engine.projects.create({ name: 'App again', workspacePath: dir });
    const list = await engine.notes.list({ scope: { kind: 'project', projectId: again.id } });
    expect(list.notes.map((item) => item.id)).toEqual([note.id]);
    expect((await engine.notes.list({ scope: { kind: 'global' } })).notes).toEqual([]);
  });

  it('resolves links to sessions, branches and files inside the project only', async () => {
    const project = await engine.projects.create({ name: 'App', workspacePath: dir });
    const session = await engine.sessions.create({ name: 'Refactor', objective: 'x' });
    // A symbolic link pointing outside the project must not resolve.
    const outside = path.join(temp.dir, 'outside.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, path.join(dir, 'escape.txt'));

    const statuses = await engine.notes.checkLinks({
      projectId: project.id,
      links: [
        `atlas:session/${session.id}`,
        'atlas:branch/feature/notes',
        'atlas:branch/nope',
        'atlas:file/docs/api.md',
        'atlas:file/docs',
        'atlas:file/escape.txt',
        'atlas:file/missing.md',
      ],
    });
    expect(statuses.map((status) => status.valid)).toEqual([
      true,
      true,
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(statuses[0]!.label).toBe('Refactor');

    const dispatcher = createEngineDispatcher(engine);
    await expect(
      dispatcher.call(
        'notes.filePath',
        [{ projectId: project.id, href: 'atlas:file/escape.txt' }],
        'desktop',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // Notes are not part of the CLI surface.
    await expect(
      dispatcher.call('notes.list', [{ scope: { kind: 'all' } }], 'cli'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
