import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

describe.skipIf(!posix)('Engine project files (SDD-011 Milestone A)', { timeout: 30_000 }, () => {
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

  beforeEach(async () => {
    temp = createTempDir();
    mkdirSync(path.join(temp.dir, 'home'));
    dir = path.join(temp.dir, 'repo');
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(path.join(dir, 'build'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Ana');
    git('config', 'user.email', 'ana@example.com');
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n*.log\n');
    writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const app = 1;\n');
    writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), '');
    writeFileSync(path.join(dir, 'debug.log'), 'x');
    writeFileSync(path.join(dir, 'build', 'out.js'), '');
    git('add', '.');
    git('commit', '-qm', 'chore: init');
    engine = createEngine({
      dataDir: path.join(temp.dir, 'data'),
      component: 'test',
      env: env(),
      terminals: {
        spawner: new FakePtySpawner(),
        mirrors: new FakeMirrorFactory(),
        shells: new FakeShellProvider(),
      },
    });
    await engine.initialize();
    events = [];
    engine.terminals!.onEvent((event) => events.push(event));
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it("hides what the repository ignores and searches only the repository's files", async () => {
    const project = await engine.projects.create({ name: 'App', workspacePath: dir });
    const listing = await engine.files.list({ projectId: project.id, path: '' });
    // `build` is not ignored by this repository, so it is listed; node_modules and logs are.
    expect(listing.entries.map((entry) => entry.name)).toEqual(['build', 'src', '.gitignore']);
    expect(listing.hiddenIgnored).toBe(3);
    const all = await engine.files.list({ projectId: project.id, path: '', showIgnored: true });
    expect(all.entries.filter((entry) => entry.ignored).map((entry) => entry.name)).toEqual([
      '.git',
      'node_modules',
      'debug.log',
    ]);
    const found = await engine.files.find({ projectId: project.id, query: 'index' });
    expect(found.paths).toEqual([]);
    expect((await engine.files.find({ projectId: project.id, query: 'app' })).paths).toEqual([
      'src/app.ts',
    ]);
  });

  it('saves through the dispatcher and refreshes the Git status (Scenario A)', async () => {
    const project = await engine.projects.create({ name: 'App', workspacePath: dir });
    const dispatcher = createEngineDispatcher(engine);
    const file = (await dispatcher.call(
      'files.read',
      [{ projectId: project.id, path: 'src/app.ts' }],
      'desktop',
    )) as { version: string };
    await dispatcher.call(
      'files.write',
      [
        {
          projectId: project.id,
          path: 'src/app.ts',
          content: 'export const app = 2;\n',
          encoding: 'utf8',
          expectedVersion: file.version,
        },
      ],
      'desktop',
    );
    expect(readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe('export const app = 2;\n');
    await expect
      .poll(() => events.some((event) => event.type === 'git'), { timeout: 5000 })
      .toBe(true);
    expect(git('status', '--porcelain')).toContain(' M src/app.ts');
  });

  it('is not offered to the command-line client', async () => {
    const project = await engine.projects.create({ name: 'App', workspacePath: dir });
    const dispatcher = createEngineDispatcher(engine);
    await expect(
      dispatcher.call('files.read', [{ projectId: project.id, path: 'src/app.ts' }], 'cli'),
    ).rejects.toThrow();
  });

  it('reports changes in watched folders', async () => {
    const project = await engine.projects.create({ name: 'App', workspacePath: dir });
    await engine.files.watch('window', { projectId: project.id, directories: ['src'] });
    // macOS FSEvents starts asynchronously and drops changes made before it is live, so the
    // file is written again on every attempt until one change is reported.
    let attempt = 0;
    await expect
      .poll(
        () => {
          writeFileSync(path.join(dir, 'src', 'app.ts'), `changed by Claude ${++attempt}\n`);
          return events.some(
            (event) =>
              event.type === 'files' &&
              event.projectId === project.id &&
              event.paths.includes('src/app.ts'),
          );
        },
        { timeout: 5000, interval: 200 },
      )
      .toBe(true);
  });
});
