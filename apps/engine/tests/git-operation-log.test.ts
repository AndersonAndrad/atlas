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

  it("searches the reflog and lists the files of an entry's commit (PLAN-022)", async () => {
    writeFileSync(path.join(root, 'login.ts'), 'export const a = 1;\nexport const b = 2;\n');
    writeFileSync(path.join(root, 'logo.png'), Buffer.from([0, 1, 2, 3, 0, 255]));
    git('add', '.');
    git('commit', '-qm', 'feat: login form', '-m', 'With a body.');
    const login = git('rev-parse', 'HEAD');
    git('mv', 'login.ts', 'signin.ts');
    writeFileSync(path.join(root, 'signin.ts'), 'export const a = 1;\nexport const b = 3;\n');
    git('add', '.');
    git('commit', '-qm', 'refactor: rename login');
    git('checkout', '-q', login);

    const byMessage = await call('git.reflog', { repositoryRoot: root, limit: 10, query: 'LOGIN' });
    expect(byMessage.map((entry) => entry.action)).toEqual(['checkout', 'commit', 'commit']);
    // The checkout is found through the subject of the commit it moved to.
    expect(byMessage[0]).toMatchObject({ commitSubject: 'feat: login form', index: 0 });
    const byHash = await call('git.reflog', {
      repositoryRoot: root,
      limit: 10,
      query: login.slice(0, 7),
    });
    expect(byHash.every((entry) => entry.hash === login)).toBe(true);
    expect(byHash).toHaveLength(2);
    expect(await call('git.reflog', { repositoryRoot: root, limit: 10, query: 'nothing' })).toEqual(
      [],
    );

    const first = await call('git.commitFiles', { repositoryRoot: root, hash: login });
    expect(first).toMatchObject({
      subject: 'feat: login form',
      body: 'With a body.',
      author: 'Ana',
      parentCount: 1,
      truncated: false,
    });
    expect(first!.files).toEqual([
      { path: 'login.ts', originalPath: null, change: 'added', added: 2, removed: 0 },
      { path: 'logo.png', originalPath: null, change: 'added', added: null, removed: null },
    ]);
    const renamed = await call('git.commitFiles', {
      repositoryRoot: root,
      hash: git('rev-parse', 'HEAD@{1}'),
    });
    expect(renamed!.files).toEqual([
      { path: 'signin.ts', originalPath: 'login.ts', change: 'renamed', added: 1, removed: 1 },
    ]);
    const initial = await call('git.commitFiles', {
      repositoryRoot: root,
      hash: git('rev-list', '--max-parents=0', 'HEAD'),
    });
    expect(initial!.parentCount).toBe(0);
    expect(initial!.files.length).toBeGreaterThan(0);

    // A commit that does not exist (e.g. garbage-collected) and invalid hashes.
    expect(
      await call('git.commitFiles', { repositoryRoot: root, hash: 'f'.repeat(40) }),
    ).toBeNull();
    await expect(
      call('git.commitFiles', { repositoryRoot: root, hash: 'HEAD' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      call('git.commitFiles', { repositoryRoot: root, hash: '--output=x'.padEnd(40, 'a') }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it("lists a merge commit's files against its first parent (PLAN-022)", async () => {
    git('switch', '-qc', 'side');
    writeFileSync(path.join(root, 'side.ts'), 'export {};\n');
    git('add', 'side.ts');
    git('commit', '-qm', 'feat: side');
    git('switch', '-q', 'main');
    writeFileSync(path.join(root, 'main.ts'), 'export {};\n');
    git('add', 'main.ts');
    git('commit', '-qm', 'feat: main');
    git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const merge = await call('git.commitFiles', {
      repositoryRoot: root,
      hash: git('rev-parse', 'HEAD'),
    });
    expect(merge!.parentCount).toBe(2);
    expect(merge!.files.map((file) => file.path)).toEqual(['side.ts']);
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
