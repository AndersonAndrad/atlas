import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitOperation, GitWorkingTree } from '@atlas/contracts';
import { GitOperationCoordinator, GitWorkspaceService } from '@atlas/git';
import { AtlasError } from '@atlas/shared';
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

/**
 * Real repositories and a bare "remote" in temporary directories. HOME points to
 * an isolated directory so only the test's global configuration is used.
 */
describe.skipIf(!gitAvailable)('GitWorkspaceService with real repositories', () => {
  let temp: ReturnType<typeof createTempDir>;
  let home: string;
  let env: Record<string, string>;
  let service: GitWorkspaceService;
  let operations: GitOperation[];
  let changed: string[];

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
  const write = (dir: string, file: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  };
  const read = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8');

  const repository = (name: string) => {
    const dir = path.join(temp.dir, name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    return dir;
  };
  const committed = (name: string) => {
    const dir = repository(name);
    write(dir, 'README.md', 'one\ntwo\nthree\n');
    write(dir, 'src/app.ts', 'export const a = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'chore: initial');
    return dir;
  };
  /** A bare remote with `main`, and a clone that tracks it. */
  const withRemote = (name: string) => {
    const origin = path.join(temp.dir, `${name}-origin.git`);
    git(temp.dir, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = committed(`${name}-seed`);
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', '-u', 'origin', 'main');
    const clone = path.join(temp.dir, name);
    git(temp.dir, 'clone', '-q', origin, clone);
    return { origin, seed, clone };
  };

  const tree = (dir: string) => service.workingTree(dir);
  const file = (state: GitWorkingTree, name: string) =>
    state.files.find((entry) => entry.path === name);
  const commitMessage = (dir: string) => git(dir, 'log', '-1', '--format=%B').trim();

  const makeService = (environment: Record<string, string>) =>
    new GitWorkspaceService({
      exec: createGitExecutor({ env: environment }),
      coordinator: new GitOperationCoordinator({
        generateId: randomUUID,
        onChange: (operation) => operations.push(operation),
      }),
      onRepositoryChanged: (root) => changed.push(root),
    });

  beforeEach(() => {
    temp = createTempDir();
    home = path.join(temp.dir, 'home');
    mkdirSync(home);
    env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home };
    writeFileSync(
      path.join(home, '.gitconfig'),
      '[user]\n\tname = Ana Dev\n\temail = ana@example.com\n[init]\n\tdefaultBranch = main\n',
    );
    operations = [];
    changed = [];
    service = makeService(env);
  });
  afterEach(() => temp.cleanup());

  describe('working tree', () => {
    it('separates staged, unstaged, partially staged, untracked, deleted and renamed files', async () => {
      const dir = committed('tree');
      write(dir, 'deleted.txt', '');
      git(dir, 'add', 'deleted.txt');
      git(dir, 'commit', '-q', '-m', 'test: add file to delete');
      git(dir, 'rm', '-q', '--cached', 'deleted.txt');
      write(dir, 'README.md', 'one\ntwo changed\nthree\n');
      git(dir, 'add', 'README.md');
      write(dir, 'README.md', 'one\ntwo changed\nthree\nfour\n'); // partially staged
      write(dir, 'notes/new file.txt', 'a\nb\n');
      git(dir, 'mv', 'src/app.ts', 'src/main.ts');

      const state = await tree(dir);
      expect(file(state, 'README.md')).toMatchObject({
        staged: 'modified',
        unstaged: 'modified',
        stagedStats: { added: 1, removed: 1 },
        unstagedStats: { added: 1, removed: 0 },
      });
      expect(file(state, 'notes/new file.txt')).toMatchObject({
        staged: null,
        unstaged: 'untracked',
        unstagedStats: { added: 2, removed: 0 },
      });
      expect(file(state, 'src/main.ts')).toMatchObject({
        staged: 'renamed',
        originalPath: 'src/app.ts',
        unstaged: null,
      });
      expect(file(state, 'deleted.txt')).toMatchObject({ staged: 'deleted' });
      expect(state).toMatchObject({ branch: 'main', repositoryName: 'tree', truncated: false });
      expect(state.identity).toEqual({ name: 'Ana Dev', email: 'ana@example.com' });
      expect(state.lastFetchAt).toBeNull();
    });

    it('changes the index fingerprint when staged content changes, not on unstaged edits', async () => {
      const dir = committed('fingerprint');
      const before = (await tree(dir)).indexFingerprint;
      write(dir, 'README.md', 'edited\n');
      expect((await tree(dir)).indexFingerprint).toBe(before);
      git(dir, 'add', 'README.md');
      expect((await tree(dir)).indexFingerprint).not.toBe(before);
    });

    it('works in a repository without commits', async () => {
      const dir = repository('unborn');
      write(dir, 'a.txt', 'a\n');
      git(dir, 'add', 'a.txt');
      const state = await tree(dir);
      expect(state.unbornHead).toBe(true);
      expect(file(state, 'a.txt')).toMatchObject({ staged: 'added' });
    });
  });

  describe('diff', () => {
    it('shows staged and unstaged parts of a partially staged file separately', async () => {
      const dir = committed('diff');
      write(dir, 'README.md', 'one\nTWO\nthree\n');
      git(dir, 'add', 'README.md');
      write(dir, 'README.md', 'one\nTWO\nthree\nfour\n');

      const staged = await service.diff(dir, { path: 'README.md', area: 'staged' });
      expect(staged).toMatchObject({ change: 'modified', binary: false, added: 1, removed: 1 });
      expect(staged.text).toContain('-two');
      expect(staged.text).toContain('+TWO');
      expect(staged.text).not.toContain('+four');

      const unstaged = await service.diff(dir, { path: 'README.md', area: 'unstaged' });
      expect(unstaged.text).toContain('+four');
      expect(unstaged.text).not.toContain('-two');
    });

    it('synthesizes untracked diffs, detects binaries and truncates large files', async () => {
      const dir = committed('diff-kinds');
      write(dir, 'new.txt', 'x\ny\n');
      writeFileSync(path.join(dir, 'image.bin'), Buffer.from([0, 1, 2, 3, 0]));
      write(dir, 'big.txt', 'line\n'.repeat(20_000));

      expect(await service.diff(dir, { path: 'new.txt', area: 'unstaged' })).toMatchObject({
        change: 'untracked',
        text: '@@ -0,0 +1,2 @@\n+x\n+y',
        added: 2,
      });
      expect(await service.diff(dir, { path: 'image.bin', area: 'unstaged' })).toMatchObject({
        binary: true,
        text: '',
      });
      const big = await service.diff(dir, { path: 'big.txt', area: 'unstaged' });
      expect(big.truncated).toBe(true);
      expect(big.text.split('\n').length).toBeLessThanOrEqual(5000);

      git(dir, 'add', 'image.bin');
      expect((await service.diff(dir, { path: 'image.bin', area: 'staged' })).binary).toBe(true);
    });

    it('never follows untracked symbolic links', async () => {
      const dir = committed('symlink');
      const secret = path.join(temp.dir, 'secret.txt');
      writeFileSync(secret, 'TOP SECRET\n');
      symlinkSync(secret, path.join(dir, 'link'));
      const diff = await service.diff(dir, { path: 'link', area: 'unstaged' });
      expect(diff.text).toContain(secret);
      expect(diff.text).not.toContain('TOP SECRET');
    });

    it('rejects paths that have no changes in the requested area', async () => {
      const dir = committed('diff-reject');
      await expect(service.diff(dir, { path: 'README.md', area: 'unstaged' })).rejects.toThrow(
        AtlasError,
      );
      await expect(service.diff(dir, { path: '../outside', area: 'unstaged' })).rejects.toThrow(
        AtlasError,
      );
    });
  });

  describe('staging', () => {
    it('stages and unstages individual files, including literal names that look like pathspecs', async () => {
      const dir = committed('stage');
      write(dir, ':(glob)*.md', 'tricky\n');
      write(dir, 'other.txt', 'other\n');

      const staged = await service.stage(dir, [':(glob)*.md']);
      expect(staged).toMatchObject({ kind: 'stage', status: 'succeeded' });
      let state = await tree(dir);
      expect(file(state, ':(glob)*.md')?.staged).toBe('added');
      expect(file(state, 'other.txt')?.staged).toBeNull();

      await service.unstage(dir, [':(glob)*.md']);
      state = await tree(dir);
      expect(file(state, ':(glob)*.md')?.staged).toBeNull();
      expect(changed).toContain(dir);
    });

    it('unstages both sides of a staged rename and works without commits', async () => {
      const dir = committed('rename');
      git(dir, 'mv', 'src/app.ts', 'src/main.ts');
      await service.unstage(dir, ['src/main.ts']);
      const state = await tree(dir);
      expect(state.files.filter((entry) => entry.staged !== null)).toEqual([]);

      const unborn = repository('unstage-unborn');
      write(unborn, 'a.txt', 'a\n');
      git(unborn, 'add', 'a.txt');
      await service.unstage(unborn, ['a.txt']);
      expect(file(await tree(unborn), 'a.txt')?.unstaged).toBe('untracked');
    });

    it('rejects files without changes in the expected area', async () => {
      const dir = committed('stage-reject');
      await expect(service.stage(dir, ['README.md'])).rejects.toThrow(AtlasError);
      await expect(service.unstage(dir, ['missing.txt'])).rejects.toThrow(AtlasError);
    });
  });

  describe('commit', () => {
    it('commits only staged content and preserves partially staged changes', async () => {
      const dir = committed('commit');
      write(dir, 'README.md', 'one\nTWO\nthree\n');
      git(dir, 'add', 'README.md');
      write(dir, 'README.md', 'one\nTWO\nthree\nfour\n');
      write(dir, 'untouched.txt', 'not selected\n');
      const state = await tree(dir);

      const result = await service.commit({
        repositoryRoot: dir,
        message: 'docs(readme): uppercase two\n\nRefs: #1',
        stage: [],
        unstage: [],
        expectedFingerprint: state.indexFingerprint,
        push: false,
      });
      expect(result.commit).toMatchObject({ status: 'succeeded', kind: 'commit' });
      expect(result.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(result.push).toBeNull();
      expect(commitMessage(dir)).toBe('docs(readme): uppercase two\n\nRefs: #1');
      expect(git(dir, 'show', 'HEAD:README.md')).toBe('one\nTWO\nthree\n');
      expect(read(dir, 'README.md')).toBe('one\nTWO\nthree\nfour\n');
      const after = await tree(dir);
      expect(file(after, 'README.md')).toMatchObject({ staged: null, unstaged: 'modified' });
      expect(file(after, 'untouched.txt')?.unstaged).toBe('untracked');
    });

    it('applies the explicit selection: includes chosen unstaged files and excludes staged ones', async () => {
      const dir = committed('selection');
      write(dir, 'src/app.ts', 'export const a = 2;\n');
      git(dir, 'add', 'src/app.ts');
      write(dir, 'new.txt', 'new\n');
      const state = await tree(dir);

      const result = await service.commit({
        repositoryRoot: dir,
        message: 'feat: add new file',
        stage: ['new.txt'],
        unstage: ['src/app.ts'],
        expectedFingerprint: state.indexFingerprint,
        push: false,
      });
      expect(result.commit.status).toBe('succeeded');
      expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('new.txt');
      expect(file(await tree(dir), 'src/app.ts')).toMatchObject({
        staged: null,
        unstaged: 'modified',
      });
    });

    it('refuses invalid messages and a changed index without touching the repository', async () => {
      const dir = committed('refuse');
      write(dir, 'README.md', 'x\n');
      git(dir, 'add', 'README.md');
      const state = await tree(dir);
      const head = git(dir, 'rev-parse', 'HEAD');

      await expect(
        service.commit({
          repositoryRoot: dir,
          message: 'updated readme',
          stage: [],
          unstage: [],
          expectedFingerprint: state.indexFingerprint,
          push: false,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      write(dir, 'src/app.ts', 'changed elsewhere\n');
      git(dir, 'add', 'src/app.ts'); // e.g. from a terminal
      await expect(
        service.commit({
          repositoryRoot: dir,
          message: 'docs: update readme',
          stage: [],
          unstage: [],
          expectedFingerprint: state.indexFingerprint,
          push: false,
        }),
      ).rejects.toMatchObject({ code: 'GIT_INDEX_CHANGED' });
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    });

    it('enforces stricter project rules', async () => {
      const dir = committed('rules');
      write(dir, 'README.md', 'x\n');
      git(dir, 'add', 'README.md');
      const state = await tree(dir);
      await expect(
        service.commit(
          {
            repositoryRoot: dir,
            message: 'docs: x',
            stage: [],
            unstage: [],
            expectedFingerprint: state.indexFingerprint,
            push: false,
          },
          { requireScope: true },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('runs hooks and reports their failure with Git output, keeping the selection staged', async () => {
      const dir = committed('hooks');
      const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\necho "lint failed: token=abc" >&2\nexit 1\n');
      chmodSync(hook, 0o755);
      write(dir, 'new.txt', 'new\n');
      const state = await tree(dir);
      const head = git(dir, 'rev-parse', 'HEAD');

      const result = await service.commit({
        repositoryRoot: dir,
        message: 'feat: add file',
        stage: ['new.txt'],
        unstage: [],
        expectedFingerprint: state.indexFingerprint,
        push: false,
      });
      expect(result.commit.status).toBe('failed');
      expect(result.commit.error).toMatchObject({ code: 'hook-or-command-failed' });
      expect(result.commit.error?.message).toContain('remains staged');
      expect(result.commit.error?.output).toContain('lint failed');
      expect(result.hash).toBeNull();
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
      expect(file(await tree(dir), 'new.txt')?.staged).toBe('added');

      // A passing commit-msg hook runs as well.
      const msgHook = path.join(dir, '.git', 'hooks', 'commit-msg');
      writeFileSync(msgHook, '#!/bin/sh\necho "Signed-off-by: Hook" >> "$1"\n');
      chmodSync(msgHook, 0o755);
      chmodSync(hook, 0o644); // disables pre-commit
      const ok = await service.commit({
        repositoryRoot: dir,
        message: 'feat: add file',
        stage: [],
        unstage: [],
        expectedFingerprint: (await tree(dir)).indexFingerprint,
        push: false,
      });
      expect(ok.commit.status).toBe('succeeded');
      expect(commitMessage(dir)).toContain('Signed-off-by: Hook');
    });

    it('reports a missing identity and an empty commit', async () => {
      const dir = committed('identity');
      write(dir, 'README.md', 'x\n');
      git(dir, 'add', 'README.md');
      const bare = path.join(temp.dir, 'bare-home');
      mkdirSync(bare);
      const anonymous = makeService({ ...env, HOME: bare, XDG_CONFIG_HOME: bare, EMAIL: '' });
      git(dir, 'config', 'user.useConfigOnly', 'true');
      const result = await anonymous.commit({
        repositoryRoot: dir,
        message: 'docs: x',
        stage: [],
        unstage: [],
        expectedFingerprint: (await tree(dir)).indexFingerprint,
        push: false,
      });
      expect(result.commit.error?.code).toBe('identity-missing');

      const clean = committed('empty');
      const empty = await service.commit({
        repositoryRoot: clean,
        message: 'docs: nothing',
        stage: [],
        unstage: [],
        expectedFingerprint: (await tree(clean)).indexFingerprint,
        push: false,
      });
      expect(empty.commit.error?.code).toBe('nothing-to-commit');
    });
  });

  describe('remote operations', () => {
    it('commits and pushes, reporting each operation separately', async () => {
      const { clone, origin } = withRemote('push');
      write(clone, 'README.md', 'pushed\n');
      git(clone, 'add', 'README.md');
      const result = await service.commit({
        repositoryRoot: clone,
        message: 'docs: push it',
        stage: [],
        unstage: [],
        expectedFingerprint: (await tree(clone)).indexFingerprint,
        push: true,
      });
      expect(result.commit.status).toBe('succeeded');
      expect(result.push).toMatchObject({ kind: 'push', status: 'succeeded' });
      expect(git(origin, 'rev-parse', 'main')).toBe(git(clone, 'rev-parse', 'HEAD'));
      expect(await tree(clone)).toMatchObject({ ahead: 0, behind: 0 });
    });

    it('keeps the commit when the push is rejected and never forces', async () => {
      const { clone, seed } = withRemote('rejected');
      write(seed, 'other.txt', 'remote change\n');
      git(seed, 'add', 'other.txt');
      git(seed, 'commit', '-q', '-m', 'feat: remote');
      git(seed, 'push', '-q');

      write(clone, 'README.md', 'local\n');
      git(clone, 'add', 'README.md');
      const result = await service.commit({
        repositoryRoot: clone,
        message: 'docs: local',
        stage: [],
        unstage: [],
        expectedFingerprint: (await tree(clone)).indexFingerprint,
        push: true,
      });
      expect(result.commit.status).toBe('succeeded');
      expect(result.push).toMatchObject({ status: 'failed', error: { code: 'rejected' } });
      expect(commitMessage(clone)).toBe('docs: local');
    });

    it('requires an explicit destination for branches without upstream', async () => {
      const { clone, origin } = withRemote('upstream');
      git(clone, 'switch', '-q', '-c', 'feature/x');
      write(clone, 'f.txt', 'f\n');
      git(clone, 'add', 'f.txt');
      git(clone, 'commit', '-q', '-m', 'feat: f');

      await expect(service.push(clone)).rejects.toMatchObject({ code: 'GIT_NO_UPSTREAM' });
      await expect(
        service.push(clone, { remote: 'nope', branch: 'feature/x' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        service.push(clone, { remote: 'origin', branch: 'bad..name' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      const pushed = await service.push(clone, { remote: 'origin', branch: 'feature/x' });
      expect(pushed.status).toBe('succeeded');
      expect(git(origin, 'branch', '--list', 'feature/x').trim()).toContain('feature/x');
      expect((await tree(clone)).upstream).toBe('origin/feature/x');

      // An upstream remote that is not a configured remote is never passed to git.
      git(clone, 'config', 'branch.feature/x.remote', '--receive-pack=evil');
      await expect(service.push(clone)).rejects.toMatchObject({ code: 'GIT_NO_UPSTREAM' });
    });

    it('fetches, reports behind counts and pulls fast-forward only', async () => {
      const { clone, seed } = withRemote('pull');
      write(seed, 'README.md', 'from remote\n');
      git(seed, 'commit', '-q', '-am', 'docs: remote');
      git(seed, 'push', '-q');

      expect((await tree(clone)).behind).toBe(0);
      const fetched = await service.fetch(clone, 'origin');
      expect(fetched).toMatchObject({ kind: 'fetch', status: 'succeeded' });
      const state = await tree(clone);
      expect(state.behind).toBe(1);
      expect(state.lastFetchAt).not.toBeNull();

      expect(await service.pullInfo(clone)).toMatchObject({
        branch: 'main',
        upstream: 'origin/main',
        configuredStrategy: 'unset',
        hasLocalChanges: false,
      });
      const pulled = await service.pull(clone, 'ff-only');
      expect(pulled.status).toBe('succeeded');
      expect(read(clone, 'README.md')).toBe('from remote\n');
      expect((await tree(clone)).behind).toBe(0);
    });

    it('refuses divergent fast-forward pulls without changing anything', async () => {
      const { clone, seed } = withRemote('diverged');
      write(seed, 'remote.txt', 'r\n');
      git(seed, 'add', 'remote.txt');
      git(seed, 'commit', '-q', '-m', 'feat: remote');
      git(seed, 'push', '-q');
      write(clone, 'local.txt', 'l\n');
      git(clone, 'add', 'local.txt');
      git(clone, 'commit', '-q', '-m', 'feat: local');
      const head = git(clone, 'rev-parse', 'HEAD');

      const pulled = await service.pull(clone, 'ff-only');
      expect(pulled).toMatchObject({ status: 'failed', error: { code: 'rejected' } });
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
    });

    it('reports merge conflicts from a configured pull and does not resolve them', async () => {
      const { clone, seed } = withRemote('conflict');
      write(seed, 'README.md', 'remote line\n');
      git(seed, 'commit', '-q', '-am', 'docs: remote');
      git(seed, 'push', '-q');
      write(clone, 'README.md', 'local line\n');
      git(clone, 'commit', '-q', '-am', 'docs: local');
      git(clone, 'config', 'pull.rebase', 'false');

      expect((await service.pullInfo(clone)).configuredStrategy).toBe('merge');
      const pulled = await service.pull(clone, 'configured');
      expect(pulled).toMatchObject({ status: 'failed', error: { code: 'conflict' } });
      const state = await tree(clone);
      expect(state.inProgress).toBe('merge');
      expect(file(state, 'README.md')?.staged).toBe('conflicted');
      expect(read(clone, 'README.md')).toContain('<<<<<<<');
      // A second pull is refused before running while the merge is unfinished.
      await expect(service.pull(clone, 'ff-only')).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    });

    it('reports network failures without leaking credentials', async () => {
      const dir = committed('network');
      git(dir, 'remote', 'add', 'origin', 'https://ana:s3cr3t-token@127.0.0.1:9/repo.git');
      git(dir, 'config', 'branch.main.remote', 'origin');
      git(dir, 'config', 'branch.main.merge', 'refs/heads/main');

      expect((await service.remotes(dir))[0]).toMatchObject({
        name: 'origin',
        fetchUrl: 'https://***@127.0.0.1:9/repo.git',
      });
      const fetched = await service.fetch(dir, 'origin');
      expect(fetched.status).toBe('failed');
      expect(fetched.error?.code).toBe('network');
      expect(JSON.stringify(fetched)).not.toContain('s3cr3t');
    });
  });

  describe('branches', () => {
    it('lists, creates, switches and renames branches', async () => {
      const { clone, seed } = withRemote('branches');
      git(seed, 'push', '-q', 'origin', 'main:remote-only');
      await service.fetch(clone, 'origin');

      let list = await service.branches(clone);
      expect(list.current).toBe('main');
      expect(list.local.map((branch) => branch.name)).toEqual(['main']);
      expect(list.local[0]).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 });
      expect(list.remote.map((branch) => branch.name).sort()).toEqual([
        'origin/main',
        'origin/remote-only',
      ]);

      expect(
        (await service.createBranch(clone, { name: 'feature/a', switchTo: true })).status,
      ).toBe('succeeded');
      expect((await service.branches(clone)).current).toBe('feature/a');
      await service.renameBranch(clone, { from: 'feature/a', to: 'feature/b' });
      await service.switchBranch(clone, { name: 'origin/remote-only', kind: 'remote' });
      list = await service.branches(clone);
      expect(list.current).toBe('remote-only');
      expect(list.local.find((branch) => branch.name === 'remote-only')?.upstream).toBe(
        'origin/remote-only',
      );
      expect(list.local.map((branch) => branch.name)).toContain('feature/b');
    });

    it('rejects invalid names and refuses to overwrite local changes when switching', async () => {
      const dir = committed('branch-safety');
      for (const name of ['bad..name', '@{-1}', 'with space', '-dash']) {
        await expect(service.createBranch(dir, { name, switchTo: false })).rejects.toThrow(
          AtlasError,
        );
      }
      git(dir, 'switch', '-q', '-c', 'other');
      write(dir, 'README.md', 'other branch\n');
      git(dir, 'commit', '-q', '-am', 'docs: other');
      git(dir, 'switch', '-q', 'main');
      write(dir, 'README.md', 'uncommitted\n');

      const switched = await service.switchBranch(dir, { name: 'other', kind: 'local' });
      expect(switched).toMatchObject({ status: 'failed', error: { code: 'conflict' } });
      expect(read(dir, 'README.md')).toBe('uncommitted\n');
      expect((await service.branches(dir)).current).toBe('main');
    });
  });

  it('serializes conflicting mutations on one repository and reports every state', async () => {
    const dir = committed('serial');
    write(dir, 'a.txt', 'a\n');
    write(dir, 'b.txt', 'b\n');
    const [first, second] = await Promise.all([
      service.stage(dir, ['a.txt']),
      service.stage(dir, ['b.txt']),
    ]);
    expect([first.status, second.status]).toEqual(['succeeded', 'succeeded']);
    const states = operations.filter((op) => op.id === second.id).map((op) => op.status);
    expect(states).toEqual(['queued', 'running', 'succeeded']);
    const firstFinished = operations.findIndex(
      (op) => op.id === first.id && op.status === 'succeeded',
    );
    const secondRunning = operations.findIndex(
      (op) => op.id === second.id && op.status === 'running',
    );
    expect(firstFinished).toBeLessThan(secondRunning);
  });
});
