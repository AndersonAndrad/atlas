import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineMethod, EngineMethodResults } from '@atlas/contracts';
import { openDatabase } from '@atlas/persistence';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createTempDir } from '../../../tests/support/temp.js';
import { createEngine, createEngineDispatcher, type Engine } from '../src/index.js';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!gitAvailable)('Git operation log and reflog (PLAN-016)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let dataDir: string;
  let engine: Engine;
  let root: string;
  const env = () => ({
    ...process.env,
    HOME: path.join(temp.dir, 'home'),
    XDG_CONFIG_HOME: path.join(temp.dir, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
  });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: env(), encoding: 'utf8' }).trim();
  const call = async <M extends EngineMethod>(
    method: M,
    ...params: unknown[]
  ): Promise<EngineMethodResults[M]> =>
    (await createEngineDispatcher(engine).call(
      method,
      params,
      'desktop',
    )) as EngineMethodResults[M];

  const open = async () => {
    engine = createEngine({
      dataDir,
      component: 'test',
      env: env(),
      terminals: {
        spawner: new FakePtySpawner(),
        mirrors: new FakeMirrorFactory(),
        shells: new FakeShellProvider(),
      },
    });
    await engine.initialize();
    await engine.gitRepositories();
  };

  beforeEach(async () => {
    temp = createTempDir();
    mkdirSync(path.join(temp.dir, 'home'));
    dataDir = path.join(temp.dir, 'data');
    const dir = path.join(temp.dir, 'api');
    mkdirSync(dir);
    root = realpathSync(dir);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Ana');
    git('config', 'user.email', 'ana@example.com');
    writeFileSync(path.join(root, 'a.ts'), 'export {};\n');
    git('add', '.');
    git('commit', '-qm', 'chore: init');
    await open();
    await engine.projects.create({ name: 'api', workspacePath: root });
    await engine.gitRepositories();
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('keeps operations with their Git commands across restarts', async () => {
    writeFileSync(path.join(root, 'b.ts'), 'export {};\n');
    const staged = await call('git.stage', { repositoryRoot: root, paths: ['b.ts'] });
    const branched = await call('git.createBranch', {
      repositoryRoot: root,
      name: 'feature/log',
      switchTo: true,
    });
    expect([staged.status, branched.status]).toEqual(['succeeded', 'succeeded']);

    await engine.shutdown();
    await open();
    const page = await call('git.operationLog', { repositoryRoot: root, limit: 10 });
    expect(page.operations.map((operation) => operation.kind)).toEqual(['create-branch', 'stage']);
    expect(page.nextBefore).toBeNull();
    const details = await call('git.operationDetails', staged.id);
    expect(details.operation).toMatchObject({ status: 'succeeded', repositoryRoot: root });
    expect(details.commands.length).toBeGreaterThan(0);
    expect(details.commands.some((command) => command.args.includes('add'))).toBe(true);
    expect(details.commands.every((command) => command.outcome === 'succeeded')).toBe(true);
    expect(details.operation.commandCount).toBe(details.commands.length);

    expect(
      (await call('git.operationLog', { kind: 'stage', limit: 10 })).operations.map((o) => o.id),
    ).toEqual([staged.id]);
  });

  it('shows the reflog, telling ATLAS changes from changes made in a terminal', async () => {
    await call('git.createBranch', { repositoryRoot: root, name: 'feature/x', switchTo: true });
    // Reflog times have one-second precision: keep the terminal change clearly apart.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    writeFileSync(path.join(root, 'c.ts'), 'export {};\n');
    git('add', 'c.ts');
    git('commit', '-qm', 'feat: from the terminal');

    const entries = await call('git.reflog', { repositoryRoot: root, limit: 10 });
    expect(entries[0]).toMatchObject({
      index: 0,
      action: 'commit',
      message: 'feat: from the terminal',
      identity: 'Ana',
      atlasOperationId: null,
    });
    const checkout = entries.find((entry) => entry.action === 'checkout');
    expect(checkout?.message).toBe('moving from main to feature/x');
    expect(checkout?.atlasOperationId).not.toBeNull();
    await expect(
      call('git.reflog', { repositoryRoot: path.join(temp.dir, 'elsewhere'), limit: 5 }),
    ).rejects.toThrow();
  });

  it('closes operations a previous run left unfinished and applies the retention', async () => {
    await engine.shutdown();
    const db = openDatabase({ filePath: path.join(dataDir, 'atlas.db') });
    const insert = db.prepare(
      `INSERT INTO git_operation_log (id, repository_root, kind, status, started_at)
       VALUES (?, ?, 'push', ?, ?)`,
    );
    insert.run('00000000-0000-4000-8000-000000000001', root, 'running', new Date().toISOString());
    insert.run('00000000-0000-4000-8000-000000000002', root, 'succeeded', '2020-01-01T00:00:00Z');
    db.close();

    await open();
    const page = await call('git.operationLog', { repositoryRoot: root, limit: 10 });
    expect(page.operations).toEqual([
      expect.objectContaining({
        id: '00000000-0000-4000-8000-000000000001',
        status: 'cancelled',
        summary: 'ATLAS stopped before the operation finished.',
      }),
    ]);
    expect(await call('git.setLogSettings', { retentionDays: 30 })).toEqual({
      retentionDays: 30,
      maxOperations: 5000,
    });
    expect(await call('git.logSettings')).toMatchObject({ retentionDays: 30 });
  });
});
