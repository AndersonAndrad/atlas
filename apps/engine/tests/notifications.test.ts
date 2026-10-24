import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AtlasNotification, TerminalEvent } from '@atlas/contracts';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createTempDir } from '../../../tests/support/temp.js';
import { createEngine, type Engine } from '../src/index.js';

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('Engine notifications (SDD-009 Milestone A)', { timeout: 30_000 }, () => {
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
    mkdirSync(dir);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Ana');
    git('config', 'user.email', 'ana@example.com');
    writeFileSync(path.join(dir, 'README.md'), '# repo\n');
    git('add', '.');
    git('commit', '-qm', 'chore: init');
    engine = open();
    await engine.initialize();
    events = [];
    engine.terminals!.onEvent((event) => events.push(event));
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  const commit = async (file: string) => {
    writeFileSync(path.join(dir, file), `${file}\n`);
    const tree = await engine.gitWorkspace.workingTree(dir);
    return engine.gitWorkspace.commit(
      {
        repositoryRoot: dir,
        message: `docs: add ${file}`,
        stage: [file],
        unstage: [],
        expectedFingerprint: tree.indexFingerprint,
        push: false,
      },
      {},
      await engine.gitCommitChecks(dir),
    );
  };

  const notifications = async (count: number): Promise<AtlasNotification[]> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { items } = await engine.notifications.list();
      if (items.length >= count) return items;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return (await engine.notifications.list()).items;
  };

  it('reports finished commits with their project, live and after a restart', async () => {
    const project = await engine.projects.create({ name: 'Atlas repo', workspacePath: dir });
    await engine.gitRepositories();

    const done = await commit('a.txt');
    expect(done.commit.status).toBe('succeeded');
    const [created] = await notifications(1);
    expect(created).toMatchObject({
      type: 'SUCCESS',
      category: 'GIT',
      title: 'Commit created',
      projectId: project.id,
      sourceName: 'Atlas repo',
      taskId: done.commit.id,
      action: { type: 'git-operation', repositoryRoot: dir, operationId: done.commit.id },
      read: false,
    });
    // Clients get the new notification as an event, for a toast.
    expect(events).toContainEqual({ type: 'notifications', created });

    // A hook that refuses the commit is reported as an error, once.
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const failed = await commit('b.txt');
    expect(failed.commit.status).toBe('failed');
    const items = await notifications(2);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: 'ERROR', title: 'Commit failed' });
    expect(items[0]!.message).not.toContain('lint failed');

    await engine.notifications.markAsRead(items[1]!.id);
    await engine.shutdown();
    engine = open();
    await engine.initialize();
    const restored = await engine.notifications.list();
    expect(restored.unread).toBe(1);
    expect(restored.items.map((item) => [item.title, item.read])).toEqual([
      ['Commit failed', false],
      ['Commit created', true],
    ]);
  });

  it('does not report staging and names repositories without a project by their folder', async () => {
    writeFileSync(path.join(dir, 'c.txt'), 'c\n');
    await engine.gitWorkspace.stage(dir, ['c.txt']);
    const done = await commit('d.txt');
    expect(done.commit.status).toBe('succeeded');
    const items = await notifications(1);
    expect(items.map((item) => [item.title, item.sourceName, item.projectId])).toEqual([
      ['Commit created', 'repo', null],
    ]);
  });
});
