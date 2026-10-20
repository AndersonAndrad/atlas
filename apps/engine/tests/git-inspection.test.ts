import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitRepositorySnapshot, GitStatus } from '@atlas/contracts';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  GitCommandError,
  GitInspectionService,
  createGitRunner,
  gitEnvironment,
  type GitRunner,
} from '../src/index.js';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

/**
 * Real repositories in temporary directories. HOME and XDG_CONFIG_HOME point to
 * an empty directory so the user's global Git configuration is never read.
 */
describe.skipIf(!gitAvailable)('GitInspectionService with real repositories', () => {
  let temp: ReturnType<typeof createTempDir>;
  let env: Record<string, string>;
  let service: GitInspectionService;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8' });

  const repository = (name: string) => {
    const dir = path.join(temp.dir, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    return dir;
  };

  const commit = (dir: string, file: string, message: string, date: string) => {
    writeFileSync(path.join(dir, file), `${message}\n`);
    git(dir, 'add', file);
    execFileSync('git', ['commit', '-q', '-m', message], {
      cwd: dir,
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };

  const snapshotOf = async (dir: string): Promise<GitRepositorySnapshot> => {
    const status = await service.inspect(dir, { fresh: true });
    if (status.state !== 'repository') throw new Error(`Expected repository, got ${status.state}`);
    return status.snapshot;
  };

  beforeEach(() => {
    temp = createTempDir();
    const home = path.join(temp.dir, 'home');
    mkdirSync(home);
    env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Committer Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'Committer Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    };
    // GIT_* variables are dropped by the runner, so the global config file is pointed to by HOME.
    service = new GitInspectionService({ run: createGitRunner({ env }) });
  });
  afterEach(() => temp.cleanup());

  it('reports identity from configuration, not from the last commit author', async () => {
    const dir = repository('identity');
    commit(dir, 'a.txt', 'first', '2026-01-01T00:00:00Z');
    expect((await snapshotOf(dir)).identity).toEqual({ name: null, email: null });

    writeFileSync(
      path.join(env.HOME!, '.gitconfig'),
      '[user]\n\tname = Global User\n\temail = global@example.com\n',
    );
    expect((await snapshotOf(dir)).identity).toEqual({
      name: 'Global User',
      email: 'global@example.com',
    });

    git(dir, 'config', 'user.name', 'Local User');
    expect((await snapshotOf(dir)).identity).toEqual({
      name: 'Local User',
      email: 'global@example.com',
    });
  });

  it('counts local branches and lists the three most recent by latest commit', async () => {
    const dir = repository('branches');
    commit(dir, 'a.txt', 'main', '2026-01-01T00:00:00Z');
    for (const [branch, date] of [
      ['old', '2025-06-01T00:00:00Z'],
      ['newest', '2026-05-01T00:00:00Z'],
      ['middle', '2026-03-01T00:00:00Z'],
    ] as const) {
      git(dir, 'checkout', '-q', '-b', branch);
      commit(dir, `${branch}.txt`, branch, date);
      git(dir, 'checkout', '-q', 'main');
    }
    const snapshot = await snapshotOf(dir);
    expect(snapshot.localBranchCount).toBe(4);
    expect(snapshot.branch).toBe('main');
    expect(snapshot.recentBranches.map((branch) => branch.name)).toEqual([
      'newest',
      'middle',
      'main',
    ]);
    expect(snapshot.recentBranches[0]!.latestCommitAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('counts modified, staged, untracked, deleted and renamed files', async () => {
    const dir = repository('changes');
    for (const file of ['keep.txt', 'stage.txt', 'both.txt', 'gone.txt', 'old.txt']) {
      writeFileSync(path.join(dir, file), `${file}\n`);
    }
    git(dir, 'add', '.');
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env });

    writeFileSync(path.join(dir, 'keep.txt'), 'changed\n');
    writeFileSync(path.join(dir, 'stage.txt'), 'staged\n');
    git(dir, 'add', 'stage.txt');
    writeFileSync(path.join(dir, 'both.txt'), 'staged\n');
    git(dir, 'add', 'both.txt');
    writeFileSync(path.join(dir, 'both.txt'), 'staged and modified\n');
    rmSync(path.join(dir, 'gone.txt'));
    git(dir, 'mv', 'old.txt', 'new.txt');
    writeFileSync(path.join(dir, 'untracked.txt'), 'new\n');

    expect((await snapshotOf(dir)).changes).toEqual({
      modified: 2,
      staged: 3,
      untracked: 1,
      deleted: 1,
      renamed: 1,
      conflicted: 0,
      total: 6,
    });
  });

  it('computes ahead/behind from local tracking refs and reports missing upstreams', async () => {
    const origin = repository('origin');
    commit(origin, 'a.txt', 'base', '2026-01-01T00:00:00Z');
    const clone = path.join(temp.dir, 'clone');
    execFileSync('git', ['clone', '-q', origin, clone], { env });
    commit(clone, 'local.txt', 'local 1', '2026-01-02T00:00:00Z');
    commit(clone, 'local2.txt', 'local 2', '2026-01-03T00:00:00Z');
    commit(origin, 'remote.txt', 'remote', '2026-01-04T00:00:00Z');

    // Not fetched yet: the remote commit is unknown locally.
    expect(await snapshotOf(clone)).toMatchObject({ upstream: 'origin/main', ahead: 2, behind: 0 });
    git(clone, 'fetch', '-q');
    expect(await snapshotOf(clone)).toMatchObject({ ahead: 2, behind: 1, upstreamGone: false });

    git(clone, 'checkout', '-q', '-b', 'no-upstream');
    expect(await snapshotOf(clone)).toMatchObject({ upstream: null, ahead: null, behind: null });
  });

  it('handles detached HEAD, repositories without commits and subdirectories', async () => {
    const empty = repository('empty');
    expect(await snapshotOf(empty)).toMatchObject({
      branch: 'main',
      unbornHead: true,
      localBranchCount: 0,
      recentBranches: [],
    });

    const dir = repository('detached');
    commit(dir, 'a.txt', 'one', '2026-01-01T00:00:00Z');
    commit(dir, 'b.txt', 'two', '2026-01-02T00:00:00Z');
    git(dir, 'checkout', '-q', 'HEAD~1');
    const nested = path.join(dir, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    const snapshot = await snapshotOf(nested);
    expect(snapshot).toMatchObject({ branch: null, detachedHead: true, repositoryRoot: dir });
  });

  it('reports plain folders, removed repositories and unavailable directories', async () => {
    const folder = path.join(temp.dir, 'plain');
    mkdirSync(folder);
    expect((await service.inspect(folder)).state).toBe('not-repository');

    const dir = repository('removed');
    renameSync(path.join(dir, '.git'), path.join(temp.dir, 'moved.git'));
    expect((await service.inspect(dir, { fresh: true })).state).toBe('not-repository');

    expect(await service.inspect(path.join(temp.dir, 'missing'))).toMatchObject({
      state: 'unavailable',
      reason: 'directory-unavailable',
    });
  });

  it('never mutates the repository or runs a configured fsmonitor command', async () => {
    const dir = repository('safe');
    commit(dir, 'a.txt', 'one', '2026-01-01T00:00:00Z');
    writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
    const marker = path.join(temp.dir, 'pwned');
    const hook = path.join(temp.dir, 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    git(dir, 'config', 'core.fsmonitor', hook);

    const gitDir = path.join(dir, '.git');
    const before = {
      head: readFileSync(path.join(gitDir, 'HEAD'), 'utf8'),
      config: readFileSync(path.join(gitDir, 'config'), 'utf8'),
      index: readFileSync(path.join(gitDir, 'index')).toString('base64'),
    };
    await snapshotOf(dir);
    await snapshotOf(dir);
    expect(existsSync(marker)).toBe(false);
    expect({
      head: readFileSync(path.join(gitDir, 'HEAD'), 'utf8'),
      config: readFileSync(path.join(gitDir, 'config'), 'utf8'),
      index: readFileSync(path.join(gitDir, 'index')).toString('base64'),
    }).toEqual(before);
    expect(existsSync(path.join(gitDir, 'index.lock'))).toBe(false);
  });
});

describe('GitInspectionService failure handling', () => {
  let temp: ReturnType<typeof createTempDir>;
  beforeEach(() => {
    temp = createTempDir();
  });
  afterEach(() => temp.cleanup());

  const statusWith = (run: GitRunner): Promise<GitStatus> =>
    new GitInspectionService({ run }).inspect(temp.dir);

  it('reports a missing git executable', async () => {
    const run = createGitRunner({ executable: path.join(temp.dir, 'no-such-git') });
    expect(await statusWith(run)).toMatchObject({ state: 'unavailable', reason: 'not-installed' });
  });

  it('reports timeouts and untrusted repositories without throwing', async () => {
    expect(
      await statusWith(async () => {
        throw new GitCommandError('timeout', 'slow');
      }),
    ).toMatchObject({ state: 'unavailable', reason: 'timeout' });
    expect(
      await statusWith(async () => {
        throw new GitCommandError('unsafe-ownership', 'dubious');
      }),
    ).toMatchObject({ state: 'unavailable', reason: 'unsafe-ownership' });
  });

  it('serves concurrent requests from one inspection and limits concurrency', async () => {
    let running = 0;
    let peak = 0;
    let calls = 0;
    const run: GitRunner = async (args) => {
      calls += 1;
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (args[0] === 'rev-parse') return `${temp.dir}\n`;
      if (args[0] === 'config') throw new GitCommandError('failed', 'unset', 1);
      return '';
    };
    const service = new GitInspectionService({ run, concurrency: 2 });
    await Promise.all([
      service.inspect(temp.dir),
      service.inspect(temp.dir),
      service.inspect(temp.dir),
    ]);
    expect(calls).toBe(5); // rev-parse, status, for-each-ref, user.name, user.email — once
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('removes inherited GIT_* variables and disables prompts', () => {
    expect(
      gitEnvironment({ PATH: '/bin', GIT_DIR: '/evil', GIT_WORK_TREE: '/evil', HOME: '/h' }),
    ).toEqual({
      PATH: '/bin',
      HOME: '/h',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    });
  });
});
