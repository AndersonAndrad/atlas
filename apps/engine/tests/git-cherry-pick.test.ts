import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitOperationCoordinator, GitWorkspaceService } from '@atlas/git';
import { createTempDir } from '../../../tests/support/temp.js';
import { createGitExecutor } from '../src/index.js';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!gitAvailable)('Cherry-pick (PLAN-019)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let env: Record<string, string>;
  let service: GitWorkspaceService;
  let dir: string;

  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    }).trim();
  const write = (file: string, content: string) => writeFileSync(path.join(dir, file), content);
  const commit = (file: string, content: string, message: string) => {
    write(file, content);
    git('add', file);
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const subjects = () => git('log', '--format=%s', '-5').split('\n');

  beforeEach(() => {
    temp = createTempDir();
    const home = path.join(temp.dir, 'home');
    mkdirSync(home);
    env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home };
    writeFileSync(
      path.join(home, '.gitconfig'),
      '[user]\n\tname = Ana Dev\n\temail = ana@example.com\n[init]\n\tdefaultBranch = main\n',
    );
    service = new GitWorkspaceService({
      exec: createGitExecutor({ env }),
      coordinator: new GitOperationCoordinator({ generateId: randomUUID }),
    });
    dir = path.join(temp.dir, 'repo');
    mkdirSync(dir);
    git('init', '-q', '-b', 'main');
    commit('base.txt', 'base\n', 'chore: base');
    commit('shared.txt', 'one\n', 'chore: shared');
    git('switch', '-qc', 'feature');
  });
  afterEach(() => temp.cleanup());

  it('lists commits of another branch, marks already applied ones and applies chosen ones in order', async () => {
    const a = commit('a.txt', 'a\n', 'feat: add a');
    const b = commit('b.txt', 'b\n', 'add b without convention');
    const c = commit('c.txt', 'c\n', 'feat: add c');
    git('switch', '-q', 'main');
    // `a` already reached main with another hash (another parent, so never the same commit).
    commit('main.txt', 'main\n', 'chore: main moves on');
    git('cherry-pick', a);

    const preview = await service.cherryPickPreview(dir, 'feature');
    expect(preview).toMatchObject({ branch: 'feature', current: 'main', truncated: false });
    expect(preview.commits.map((item) => [item.subject, item.applied, item.conventional])).toEqual([
      ['feat: add a', true, true],
      ['add b without convention', false, false],
      ['feat: add c', false, true],
    ]);
    expect(preview.commits[1]).toMatchObject({ hash: b, author: 'Ana Dev' });

    await expect(
      service.cherryPick({
        repositoryRoot: dir,
        branch: 'feature',
        commits: [a],
        recordOrigin: true,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.cherryPick({ repositoryRoot: dir, branch: 'main', commits: [b], recordOrigin: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // Chosen in reverse; applied in the source branch's order, keeping the original commits.
    const result = await service.cherryPick({
      repositoryRoot: dir,
      branch: 'feature',
      commits: [c, b],
      recordOrigin: true,
    });
    expect(result).toMatchObject({ kind: 'cherry-pick', status: 'succeeded' });
    expect(result.summary).toBe('Applied 2 commits of feature to main.');
    expect(subjects().slice(0, 2)).toEqual(['feat: add c', 'add b without convention']);
    expect(git('log', '-1', '--format=%B')).toContain(`(cherry picked from commit ${c})`);
    expect(git('log', '-1', '--format=%an')).toBe('Ana Dev');
    expect((await service.workingTree(dir)).inProgress).toBeNull();
  });

  it('stops on conflicts and continues after they are resolved', async () => {
    const first = commit('shared.txt', 'feature\n', 'feat: change shared');
    const second = commit('other.txt', 'other\n', 'feat: add other');
    git('switch', '-q', 'main');
    commit('shared.txt', 'main\n', 'fix: change shared on main');

    const stopped = await service.cherryPick({
      repositoryRoot: dir,
      branch: 'feature',
      commits: [first, second],
      recordOrigin: false,
    });
    expect(stopped).toMatchObject({ status: 'failed', error: { code: 'conflict' } });
    expect(stopped.error?.message).toContain('stopped at');
    expect(stopped.error?.message).toContain('shared.txt');
    expect(stopped.error?.message).toContain('1 commit after it will follow');
    const tree = await service.workingTree(dir);
    expect(tree.inProgress).toBe('cherry-pick');
    expect(tree.cherryPick).toMatchObject({
      hash: first,
      subject: 'feat: change shared',
      remaining: 1,
    });

    // Conflicts must be resolved first; then Continue commits with the original message.
    await expect(service.continueCherryPick(dir)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    write('shared.txt', 'resolved\n');
    git('add', 'shared.txt');
    const continued = await service.continueCherryPick(dir);
    expect(continued).toMatchObject({ kind: 'continue-cherry-pick', status: 'succeeded' });
    expect(subjects().slice(0, 3)).toEqual([
      'feat: add other',
      'feat: change shared',
      'fix: change shared on main',
    ]);
    expect((await service.workingTree(dir)).inProgress).toBeNull();
  });

  it('skips a commit or aborts back to the state before the cherry-pick', async () => {
    const first = commit('shared.txt', 'feature\n', 'feat: change shared');
    const second = commit('other.txt', 'other\n', 'feat: add other');
    git('switch', '-q', 'main');
    const head = commit('shared.txt', 'main\n', 'fix: change shared on main');

    await service.cherryPick({
      repositoryRoot: dir,
      branch: 'feature',
      commits: [first, second],
      recordOrigin: false,
    });
    const skipped = await service.skipCherryPick(dir);
    expect(skipped).toMatchObject({ kind: 'skip-cherry-pick', status: 'succeeded' });
    expect(subjects()[0]).toBe('feat: add other');

    git('reset', '-q', '--hard', head);
    await service.cherryPick({
      repositoryRoot: dir,
      branch: 'feature',
      commits: [second, first],
      recordOrigin: false,
    });
    // `second` comes after `first` on feature, so the sequence stops at `first` first.
    expect((await service.workingTree(dir)).cherryPick?.hash).toBe(first);
    const aborted = await service.abortCherryPick(dir);
    expect(aborted).toMatchObject({ kind: 'abort-cherry-pick', status: 'succeeded' });
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect((await service.workingTree(dir)).inProgress).toBeNull();
    await expect(service.abortCherryPick(dir)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('explains a commit that became empty and refuses unsafe starts', async () => {
    const change = commit('shared.txt', 'same\n', 'feat: same change');
    git('switch', '-q', 'main');
    // main reaches the same content another way: a different patch with an empty result.
    commit('shared.txt', 'other\n', 'chore: other');
    commit('shared.txt', 'same\n', 'chore: same again');
    const preview = await service.cherryPickPreview(dir, 'feature');
    expect(preview.commits.find((item) => item.hash === change)?.applied).toBe(false);
    const empty = await service.cherryPick({
      repositoryRoot: dir,
      branch: 'feature',
      commits: [change],
      recordOrigin: false,
    });
    expect(empty).toMatchObject({ status: 'failed', error: { code: 'conflict' } });
    expect(empty.error?.message).toContain('would be empty');
    expect((await service.skipCherryPick(dir)).status).toBe('succeeded');
    expect((await service.workingTree(dir)).inProgress).toBeNull();

    write('base.txt', 'dirty\n');
    await expect(
      service.cherryPick({
        repositoryRoot: dir,
        branch: 'feature',
        commits: [change],
        recordOrigin: false,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.cherryPickPreview(dir, 'missing')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('takes commits from a remote-tracking branch', async () => {
    const picked = commit('remote.txt', 'r\n', 'feat: from the remote');
    const origin = path.join(temp.dir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', origin], { env });
    git('remote', 'add', 'origin', origin);
    git('push', '-q', 'origin', 'feature');
    git('switch', '-q', 'main');
    git('branch', '-D', 'feature');
    git('fetch', '-q', 'origin');

    const preview = await service.cherryPickPreview(dir, 'origin/feature');
    expect(preview.commits.map((item) => item.hash)).toEqual([picked]);
    const result = await service.cherryPick({
      repositoryRoot: dir,
      branch: 'origin/feature',
      commits: [picked],
      recordOrigin: false,
    });
    expect(result.status).toBe('succeeded');
    expect(subjects()[0]).toBe('feat: from the remote');
  });
});
