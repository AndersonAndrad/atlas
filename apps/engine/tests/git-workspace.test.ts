import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitOperation, GitWorkingTree } from '@atlas/contracts';
import type { GitExecutor } from '@atlas/git';
import { GitCommandError, GitOperationCoordinator, GitWorkspaceService } from '@atlas/git';
import { AtlasError } from '@atlas/shared';
import { createTempDir } from '../../../tests/support/temp.js';
import { ShellPreCommitRunner } from '../src/adapters/shell-pre-commit-runner.js';
import { createEngine, createGitExecutor } from '../src/index.js';

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
  let coordinator: GitOperationCoordinator;

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

  const makeService = (environment: Record<string, string>) => {
    coordinator = new GitOperationCoordinator({
      generateId: randomUUID,
      onChange: (operation) => operations.push(operation),
    });
    return new GitWorkspaceService({
      exec: createGitExecutor({ env: environment }),
      stepRunner: new ShellPreCommitRunner({
        platform: 'linux',
        shell: '/bin/sh',
        env: environment,
        killGraceMs: 500,
      }),
      coordinator,
      onRepositoryChanged: (root) => changed.push(root),
    });
  };

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

    it('refuses a commit after switching branches at the same HEAD', async () => {
      const dir = committed('branch-fingerprint');
      write(dir, 'README.md', 'changed\n');
      git(dir, 'add', 'README.md');
      const state = await tree(dir);
      const head = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'switch', '-q', '-c', 'other');
      await expect(
        service.commit({
          repositoryRoot: dir,
          message: 'docs: reviewed on main',
          stage: [],
          unstage: [],
          expectedFingerprint: state.indexFingerprint,
          push: false,
        }),
      ).rejects.toMatchObject({ code: 'GIT_INDEX_CHANGED' });
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
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

  describe('commit checks', () => {
    const steps = (...commands: string[]) =>
      commands.map((command, index) => ({
        name: `step ${index + 1}`,
        command,
        mode: 'complete' as const,
        timeoutSeconds: 30,
        readyAfterSeconds: 2,
        readyText: null,
      }));
    const prepared = async (name: string) => {
      const dir = committed(name);
      write(dir, 'README.md', 'staged\n');
      git(dir, 'add', 'README.md');
      write(dir, 'new.txt', 'new\n');
      return { dir, state: await tree(dir) };
    };

    it('runs every step before committing and records their durations', async () => {
      const { dir, state } = await prepared('checks-pass');
      const result = await service.commit(
        {
          repositoryRoot: dir,
          message: 'docs: checked',
          stage: ['new.txt'],
          unstage: [],
          expectedFingerprint: state.indexFingerprint,
          push: false,
        },
        {},
        {
          enforceConventionalCommits: true,
          steps: steps('true', 'echo built > build.log'),
          cwd: dir,
        },
      );
      expect(result.commit.status).toBe('succeeded');
      expect(result.commit.steps?.map((step) => step.status)).toEqual(['passed', 'passed']);
      expect(result.commit.steps?.every((step) => step.durationMs !== null)).toBe(true);
      expect(read(dir, 'build.log')).toBe('built\n');
      expect(commitMessage(dir)).toBe('docs: checked');
      // Running steps were published while the commit was in progress.
      expect(operations.some((op) => op.steps?.[0]?.status === 'running')).toBe(true);
    });

    it('does not commit or touch the index when a step fails', async () => {
      const { dir, state } = await prepared('checks-fail');
      const head = git(dir, 'rev-parse', 'HEAD');
      const result = await service.commit(
        {
          repositoryRoot: dir,
          message: 'docs: checked',
          stage: ['new.txt'],
          unstage: [],
          expectedFingerprint: state.indexFingerprint,
          push: false,
        },
        {},
        {
          enforceConventionalCommits: true,
          steps: steps('true', 'echo "2 tests failed" >&2; exit 1', 'echo never > never.log'),
          cwd: dir,
        },
      );
      expect(result.commit).toMatchObject({ status: 'failed', error: { code: 'check-failed' } });
      expect(result.commit.error?.message).toContain('step 2');
      expect(result.commit.steps?.map((step) => step.status)).toEqual([
        'passed',
        'failed',
        'skipped',
      ]);
      expect(result.commit.steps?.[1]).toMatchObject({ exitCode: 1 });
      expect(result.commit.steps?.[1]?.output).toContain('2 tests failed');
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
      expect((await tree(dir)).indexFingerprint).toBe(state.indexFingerprint);
      expect(file(await tree(dir), 'new.txt')?.staged).toBeNull();
    });

    it('refuses before running steps when nothing would be committed', async () => {
      const dir = committed('checks-empty');
      const result = await service.commit(
        {
          repositoryRoot: dir,
          message: 'docs: nothing',
          stage: [],
          unstage: [],
          expectedFingerprint: (await tree(dir)).indexFingerprint,
          push: false,
        },
        {},
        { enforceConventionalCommits: true, steps: steps('echo ran > ran.log'), cwd: dir },
      );
      expect(result.commit.error?.code).toBe('nothing-to-commit');
      expect(result.commit.steps).toBeNull();
      expect(() => read(dir, 'ran.log')).toThrow();
    });

    it('refuses commits when the file list hides part of the index', async () => {
      const { dir } = await prepared('checks-truncated');
      git(dir, 'add', 'new.txt');
      const limited = new GitWorkspaceService({
        exec: createGitExecutor({ env }),
        coordinator,
        limits: { maxFiles: 1 },
      });
      const state = await limited.workingTree(dir);
      const head = git(dir, 'rev-parse', 'HEAD');
      expect(state.truncated).toBe(true);
      expect(state.stagedTruncated).toBe(true);
      await expect(
        limited.commit({
          repositoryRoot: dir,
          message: 'docs: incomplete selection',
          stage: [],
          unstage: [],
          expectedFingerprint: state.indexFingerprint,
          push: false,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
      expect((await limited.workingTree(dir)).indexFingerprint).toBe(state.indexFingerprint);
    });

    it('detects index changes made while steps run', async () => {
      const { dir, state } = await prepared('checks-race');
      await expect(
        service.commit(
          {
            repositoryRoot: dir,
            message: 'docs: checked',
            stage: [],
            unstage: [],
            expectedFingerprint: state.indexFingerprint,
            push: false,
          },
          {},
          { enforceConventionalCommits: true, steps: steps('git add new.txt'), cwd: dir },
        ),
      ).rejects.toMatchObject({ code: 'GIT_INDEX_CHANGED' });
    });

    it('does not commit when cancellation arrives with the last passing check', async () => {
      const { dir, state } = await prepared('checks-last-cancel');
      const head = git(dir, 'rev-parse', 'HEAD');
      const cancelling = new GitWorkspaceService({
        exec: createGitExecutor({ env }),
        coordinator,
        stepRunner: {
          async run() {
            const running = coordinator.list().find((operation) => operation.status === 'running')!;
            coordinator.cancel(running.id);
            return {
              status: 'passed',
              exitCode: 0,
              detail: 'exited with code 0',
              output: '',
              durationMs: 1,
            };
          },
        },
      });
      const result = await cancelling.commit(
        {
          repositoryRoot: dir,
          message: 'docs: cancelled',
          stage: ['new.txt'],
          unstage: [],
          expectedFingerprint: state.indexFingerprint,
          push: false,
        },
        {},
        { enforceConventionalCommits: true, steps: steps('true'), cwd: dir },
      );
      expect(result.commit.status).toBe('cancelled');
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
      expect((await tree(dir)).indexFingerprint).toBe(state.indexFingerprint);
    });

    it('accepts any message when the project does not enforce Conventional Commits', async () => {
      const { dir, state } = await prepared('checks-free');
      const input = {
        repositoryRoot: dir,
        message: 'wip: anything goes',
        stage: [],
        unstage: [],
        expectedFingerprint: state.indexFingerprint,
        push: false,
      };
      await expect(
        service.commit({ ...input, message: 'updated stuff' }, { requireScope: true }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const result = await service.commit(
        { ...input, message: 'updated stuff' },
        { requireScope: true },
        { enforceConventionalCommits: false, steps: [], cwd: dir },
      );
      expect(result.commit.status).toBe('succeeded');
      expect(commitMessage(dir)).toBe('updated stuff');
      await expect(
        service.commit(
          { ...input, message: '   ', expectedFingerprint: (await tree(dir)).indexFingerprint },
          {},
          { enforceConventionalCommits: false, steps: [], cwd: dir },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('can be cancelled while steps run, without committing', async () => {
      const { dir, state } = await prepared('checks-cancel');
      const head = git(dir, 'rev-parse', 'HEAD');
      const pending = service.commit(
        {
          repositoryRoot: dir,
          message: 'docs: checked',
          stage: [],
          unstage: [],
          expectedFingerprint: state.indexFingerprint,
          push: false,
        },
        {},
        { enforceConventionalCommits: true, steps: steps('sleep 30'), cwd: dir },
      );
      for (let i = 0; i < 100; i += 1) {
        if (operations.some((op) => op.steps?.[0]?.status === 'running')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const running = operations.find((op) => op.kind === 'commit' && op.cancellable)!;
      expect(running).toBeDefined();
      coordinator.cancel(running.id);
      const result = await pending;
      expect(result.commit.status).toBe('cancelled');
      expect(result.commit.steps?.[0]?.status).toBe('cancelled');
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    });
  });

  describe('commit safety', () => {
    const step = {
      name: 'check',
      command: 'true',
      mode: 'complete' as const,
      timeoutSeconds: 30,
      readyAfterSeconds: 2,
      readyText: null,
    };
    const passed = {
      status: 'passed' as const,
      exitCode: 0,
      detail: 'exited with code 0',
      output: '',
      durationMs: 1,
    };
    /** A service whose only pre-commit step runs `during` instead of a command. */
    const withStep = (during: (signal: AbortSignal) => Promise<void> | void) =>
      new GitWorkspaceService({
        exec: createGitExecutor({ env }),
        coordinator,
        stepRunner: {
          async run(_step, { signal }) {
            await during(signal);
            return passed;
          },
        },
      });
    const selection = async (dir: string, stage: string[]) => ({
      repositoryRoot: dir,
      message: 'docs: reviewed',
      stage,
      unstage: [],
      expectedFingerprint: (await tree(dir)).indexFingerprint,
      push: false,
    });
    const checks = (dir: string) => ({ enforceConventionalCommits: true, steps: [step], cwd: dir });

    /**
     * A real executor that runs `before(args)` ahead of each Git command, e.g. to
     * change a file between the last check and `git add`.
     */
    const wrapped =
      (before: (args: readonly string[]) => void | Promise<void>): GitExecutor =>
      async (args, options) => {
        await before(args);
        return createGitExecutor({ env })(args, options);
      };
    const isCommand = (args: readonly string[], command: string) => args[1] === command;
    const stagedRaw = (dir: string) => git(dir, 'diff', '--cached', '--raw', '--no-abbrev');
    /** A repository with a staged edit to exclude and a new file to include. */
    const mixedSelection = async (name: string) => {
      const dir = committed(name);
      write(dir, 'README.md', 'staged edit\n');
      git(dir, 'add', 'README.md');
      write(dir, 'new.txt', 'reviewed\n');
      return {
        dir,
        input: {
          ...(await selection(dir, ['new.txt'])),
          unstage: ['README.md'],
        },
      };
    };

    it('restores the index when a selected file changes right before it is staged', async () => {
      const { dir, input } = await mixedSelection('safety-restore');
      const before = stagedRaw(dir);
      const head = git(dir, 'rev-parse', 'HEAD');
      const racing = new GitWorkspaceService({
        exec: wrapped((args) => {
          if (isCommand(args, 'add')) write(dir, 'new.txt', 'changed after the check\n');
        }),
        coordinator,
      });
      await expect(racing.commit(input)).rejects.toMatchObject({
        code: 'GIT_INDEX_CHANGED',
        issues: [{ field: 'selection', message: expect.stringContaining('were restored') }],
      });
      expect(stagedRaw(dir)).toBe(before);
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
      const failed = operations.filter((operation) => operation.status === 'failed').at(-1);
      expect(failed?.error?.message).toContain('were restored');
    });

    it('says the selection remains staged when the index cannot be restored', async () => {
      const { dir, input } = await mixedSelection('safety-restore-failed');
      const head = git(dir, 'rev-parse', 'HEAD');
      const racing = new GitWorkspaceService({
        exec: wrapped((args) => {
          if (isCommand(args, 'add')) write(dir, 'new.txt', 'changed after the check\n');
          if (isCommand(args, 'reset')) throw new GitCommandError('failed', 'reset failed', 1);
        }),
        coordinator,
      });
      await expect(racing.commit(input)).rejects.toMatchObject({
        code: 'GIT_INDEX_CHANGED',
        issues: [{ field: 'selection', message: expect.stringContaining('remains staged') }],
      });
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
      expect(file(await tree(dir), 'new.txt')?.staged).toBe('added');
    });

    it('restores exclusions when a selected new file is deleted before it is staged', async () => {
      const { dir, input } = await mixedSelection('safety-restore-deleted');
      const before = stagedRaw(dir);
      const head = git(dir, 'rev-parse', 'HEAD');
      const racing = new GitWorkspaceService({
        exec: wrapped((args) => {
          if (isCommand(args, 'add')) rmSync(path.join(dir, 'new.txt'));
        }),
        coordinator,
      });
      const result = await racing.commit(input);
      expect(result.commit.status).toBe('failed');
      expect(result.commit.error?.message).not.toContain('remains staged');
      // `README.md` is staged again although `new.txt` is in neither the tree nor the index.
      expect(stagedRaw(dir)).toBe(before);
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    });

    it('restores the index of a repository without commits', async () => {
      const dir = repository('safety-restore-unborn');
      write(dir, 'staged.txt', 'staged\n');
      git(dir, 'add', 'staged.txt');
      write(dir, 'new.txt', 'reviewed\n');
      const before = stagedRaw(dir);
      const racing = new GitWorkspaceService({
        exec: wrapped((args) => {
          if (isCommand(args, 'add')) write(dir, 'new.txt', 'changed after the check\n');
        }),
        coordinator,
      });
      await expect(
        racing.commit({ ...(await selection(dir, ['new.txt'])), unstage: ['staged.txt'] }),
      ).rejects.toMatchObject({ code: 'GIT_INDEX_CHANGED' });
      expect(stagedRaw(dir)).toBe(before);
      expect(file(await tree(dir), 'new.txt')?.unstaged).toBe('untracked');
    });

    it('keeps intent-to-add files marked when the index is restored', async () => {
      const dir = committed('safety-restore-intent');
      write(dir, 'README.md', 'staged edit\n');
      git(dir, 'add', 'README.md');
      write(dir, 'intent.txt', 'planned\n');
      git(dir, 'add', '-N', 'intent.txt');
      const before = stagedRaw(dir);
      const status = () => git(dir, 'status', '--porcelain=v2', '--', 'intent.txt');
      const intent = status();
      expect(intent).toMatch(/^1 \.A /);
      const racing = new GitWorkspaceService({
        exec: wrapped((args) => {
          if (isCommand(args, 'add') && !args.includes('-N')) {
            write(dir, 'intent.txt', 'changed after the check\n');
          }
        }),
        coordinator,
      });
      await expect(
        racing.commit({ ...(await selection(dir, ['intent.txt'])), unstage: ['README.md'] }),
      ).rejects.toMatchObject({
        code: 'GIT_INDEX_CHANGED',
        issues: [{ field: 'selection', message: expect.stringContaining('were restored') }],
      });
      expect(stagedRaw(dir)).toBe(before);
      expect(status()).toBe(intent);
    });

    it('restores the index when the executable bit changes right before staging', async () => {
      const dir = committed('safety-mode');
      write(dir, 'run.sh', 'echo hi\n');
      chmodSync(path.join(dir, 'run.sh'), 0o644);
      const before = stagedRaw(dir);
      const racing = new GitWorkspaceService({
        exec: wrapped((args) => {
          if (isCommand(args, 'add')) chmodSync(path.join(dir, 'run.sh'), 0o755);
        }),
        coordinator,
      });
      await expect(racing.commit(await selection(dir, ['run.sh']))).rejects.toMatchObject({
        code: 'GIT_INDEX_CHANGED',
      });
      expect(stagedRaw(dir)).toBe(before);
    });

    it('refuses a commit when the executable bit changes while the steps run', async () => {
      const dir = committed('safety-mode-steps');
      const head = git(dir, 'rev-parse', 'HEAD');
      write(dir, 'run.sh', 'echo hi\n');
      chmodSync(path.join(dir, 'run.sh'), 0o644);
      const editing = withStep(() => chmodSync(path.join(dir, 'run.sh'), 0o755));
      await expect(
        editing.commit(await selection(dir, ['run.sh']), {}, checks(dir)),
      ).rejects.toMatchObject({ code: 'GIT_INDEX_CHANGED' });
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    });

    it('commits a selected submodule by its commit and refuses it when that commit moves', async () => {
      const dir = committed('safety-gitlink');
      const sub = path.join(dir, 'sub');
      mkdirSync(sub);
      git(sub, 'init', '-q', '-b', 'main');
      write(sub, 'a.txt', 'a\n');
      git(sub, 'add', 'a.txt');
      git(sub, 'commit', '-q', '-m', 'chore: sub');
      git(dir, '-c', 'advice.addEmbeddedRepo=false', 'add', 'sub');
      git(dir, 'commit', '-q', '-m', 'chore: add sub');
      const advance = (content: string) => {
        write(sub, 'a.txt', content);
        git(sub, 'commit', '-q', '-am', 'chore: move');
      };

      advance('b\n');
      const head = git(dir, 'rev-parse', 'HEAD');
      const moving = withStep(() => advance('c\n'));
      await expect(
        moving.commit(await selection(dir, ['sub']), {}, checks(dir)),
      ).rejects.toMatchObject({ code: 'GIT_INDEX_CHANGED' });
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);

      const steady = withStep(() => undefined);
      const result = await steady.commit(await selection(dir, ['sub']), {}, checks(dir));
      expect(result.commit.status).toBe('succeeded');
      expect(git(dir, 'rev-parse', 'HEAD:sub')).toBe(git(sub, 'rev-parse', 'HEAD'));
    });

    it('uses the commit timeout for identity checks of large selections', async () => {
      const dir = committed('safety-timeouts');
      write(dir, 'new.txt', 'new\n');
      const seen = new Map<string, number>();
      const exec: GitExecutor = (args, options) => {
        seen.set(args[1]!, options.timeoutMs);
        return createGitExecutor({ env })(args, options);
      };
      const timed = new GitWorkspaceService({
        exec,
        coordinator,
        timeouts: { read: 1_111, commit: 99_999 },
      });
      const result = await timed.commit(await selection(dir, ['new.txt']));
      expect(result.commit.status).toBe('succeeded');
      expect(seen.get('hash-object')).toBe(99_999);
      expect(seen.get('ls-files')).toBe(99_999);
      expect(seen.get('status')).toBe(1_111);
    });

    it('refuses a commit when a selected file changes while the steps run', async () => {
      const dir = committed('safety-edit');
      write(dir, 'new.txt', 'reviewed\n');
      const head = git(dir, 'rev-parse', 'HEAD');
      const editing = withStep(() => write(dir, 'new.txt', 'changed by a step\n'));
      await expect(
        editing.commit(await selection(dir, ['new.txt']), {}, checks(dir)),
      ).rejects.toMatchObject({ code: 'GIT_INDEX_CHANGED' });
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
      expect(file(await tree(dir), 'new.txt')?.staged).toBeNull();
    });

    it('refuses a commit when a selected deletion is undone while the steps run', async () => {
      const dir = committed('safety-delete');
      git(dir, 'rm', '-q', '--cached', 'README.md');
      git(dir, 'commit', '-q', '-m', 'chore: untrack readme');
      write(dir, 'gone.txt', 'tracked\n');
      git(dir, 'add', 'gone.txt');
      git(dir, 'commit', '-q', '-m', 'chore: add gone');
      execFileSync('rm', [path.join(dir, 'gone.txt')]);
      const head = git(dir, 'rev-parse', 'HEAD');
      const restoring = withStep(() => write(dir, 'gone.txt', 'back\n'));
      await expect(
        restoring.commit(await selection(dir, ['gone.txt']), {}, checks(dir)),
      ).rejects.toMatchObject({ code: 'GIT_INDEX_CHANGED' });
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    });

    it('commits selected files whose names need quoting for Git', async () => {
      const dir = committed('safety-names');
      const names = ['quote"d.txt', 'back\\slash.txt', 'new\nline.txt', 'ação.txt'];
      for (const name of names) write(dir, name, `${name}\n`);
      const steady = withStep(() => undefined);
      const result = await steady.commit(await selection(dir, names), {}, checks(dir));
      expect(result.commit.status).toBe('succeeded');
      const committedNames = git(dir, 'show', '-z', '--name-only', '--format=', 'HEAD')
        .split('\0')
        .filter((name) => name !== '');
      expect(committedNames.sort()).toEqual([...names].sort());
    });

    it('lists staged files first, so many untracked files do not block commits', async () => {
      const dir = committed('safety-untracked');
      for (let i = 0; i < 2001; i += 1)
        write(dir, `untracked/${String(i).padStart(4, '0')}.txt`, '');
      write(dir, 'zz-staged.txt', 'staged\n');
      git(dir, 'add', 'zz-staged.txt');
      const state = await tree(dir);
      expect(state.truncated).toBe(true);
      expect(state.stagedTruncated).toBe(false);
      expect(state.files).toHaveLength(2000);
      expect(file(state, 'zz-staged.txt')?.staged).toBe('added');
      const result = await service.commit({
        repositoryRoot: dir,
        message: 'docs: one staged file',
        stage: [],
        unstage: [],
        expectedFingerprint: state.indexFingerprint,
        push: false,
      });
      expect(result.commit.status).toBe('succeeded');
      expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('zz-staged.txt');
    });

    it('refuses a selected file that the truncated list does not show', async () => {
      const dir = committed('safety-hidden-selection');
      for (const name of ['a.txt', 'b.txt', 'c.txt']) write(dir, name, `${name}\n`);
      const limited = new GitWorkspaceService({
        exec: createGitExecutor({ env }),
        coordinator,
        limits: { maxFiles: 2 },
      });
      const state = await limited.workingTree(dir);
      expect(state.truncated).toBe(true);
      await expect(
        limited.commit({
          repositoryRoot: dir,
          message: 'docs: hidden',
          stage: ['c.txt'],
          unstage: [],
          expectedFingerprint: state.indexFingerprint,
          push: false,
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        issues: [{ field: 'paths', message: expect.stringContaining('Too many') }],
      });
    });

    it('explains that pre-commit steps need ATLAS Control when no step runner exists', async () => {
      const dir = committed('safety-no-runner');
      write(dir, 'new.txt', 'new\n');
      const withoutRunner = new GitWorkspaceService({
        exec: createGitExecutor({ env }),
        coordinator,
      });
      await expect(
        withoutRunner.commit(await selection(dir, ['new.txt']), {}, checks(dir)),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        issues: [{ field: 'preCommitSteps', message: expect.stringContaining('ATLAS Control') }],
      });
    });

    it('lets a finishing commit complete on shutdown but does not start its push', async () => {
      const { origin, clone } = withRemote('safety-shutdown-push');
      write(clone, 'README.md', 'pushed?\n');
      git(clone, 'add', 'README.md');
      const remoteHead = git(origin, 'rev-parse', 'main');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let committing!: () => void;
      const commitStarted = new Promise<void>((resolve) => (committing = resolve));
      const engine = createEngine({
        dataDir: path.join(temp.dir, 'engine-data-push'),
        env,
        component: 'test',
        gitExecutor: wrapped(async (args) => {
          if (isCommand(args, 'commit')) {
            committing();
            await gate;
          }
        }),
      });
      const commit = engine.gitWorkspace.commit({
        repositoryRoot: clone,
        message: 'docs: shutdown',
        stage: [],
        unstage: [],
        expectedFingerprint: (await tree(clone)).indexFingerprint,
        push: true,
      });
      await commitStarted;
      const shutdown = engine.shutdown();
      release();
      const result = await commit;
      await shutdown;
      expect(result.commit.status).toBe('succeeded');
      expect(result.hash).toBe(git(clone, 'rev-parse', 'HEAD').trim());
      expect(result.push).toMatchObject({
        status: 'cancelled',
        summary: 'Cancelled because ATLAS is shutting down.',
      });
      expect(git(origin, 'rev-parse', 'main')).toBe(remoteHead);
    });

    it('cancels a running pre-commit step and closes cleanly on Engine shutdown', async () => {
      const dir = committed('safety-shutdown');
      write(dir, 'new.txt', 'new\n');
      const head = git(dir, 'rev-parse', 'HEAD');
      let started!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      let observed: AbortSignal | undefined;
      const engine = createEngine({
        dataDir: path.join(temp.dir, 'engine-data'),
        env,
        component: 'test',
        gitExecutor: createGitExecutor({ env }),
        preCommitRunner: {
          run: (_step, { signal }) =>
            new Promise((resolve) => {
              observed = signal;
              started();
              signal.addEventListener('abort', () =>
                resolve({ ...passed, status: 'cancelled', detail: 'cancelled' }),
              );
            }),
        },
      });
      const project = await engine.projects.create({ name: 'Shutdown', workspacePath: dir });
      await engine.projectGitSettings.set(project.id, {
        enforceConventionalCommits: true,
        preCommitSteps: [step],
      });
      const commit = engine.gitWorkspace.commit(
        await selection(dir, ['new.txt']),
        {},
        await engine.gitCommitChecks(dir),
      );
      await running;
      await engine.shutdown();
      expect(observed?.aborted).toBe(true);
      expect((await commit).commit.status).toBe('cancelled');
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
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

    it('validates the push before committing', async () => {
      const { clone } = withRemote('push-validation');
      git(clone, 'switch', '-q', '-c', 'feature/y');
      write(clone, 'y.txt', 'y\n');
      git(clone, 'add', 'y.txt');
      const head = git(clone, 'rev-parse', 'HEAD');
      const input = {
        repositoryRoot: clone,
        message: 'feat: y',
        stage: [],
        unstage: [],
        expectedFingerprint: (await tree(clone)).indexFingerprint,
        push: true,
      };
      for (const setUpstream of [
        { remote: 'nope', branch: 'feature/y' },
        { remote: 'origin', branch: 'bad..name' },
      ]) {
        await expect(service.commit({ ...input, setUpstream })).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
        });
      }
      await expect(service.commit(input)).rejects.toMatchObject({ code: 'GIT_NO_UPSTREAM' });
      git(clone, 'switch', '-q', '--detach');
      await expect(
        service.commit({
          ...input,
          expectedFingerprint: (await tree(clone)).indexFingerprint,
          setUpstream: { remote: 'origin', branch: 'feature/y' },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
      expect(operations.some((op) => op.kind === 'commit')).toBe(false);
    });

    it('returns the commit hash and reports the push failure when the push fails', async () => {
      const { clone } = withRemote('push-fails');
      git(clone, 'remote', 'set-url', 'origin', path.join(temp.dir, 'missing-remote.git'));
      write(clone, 'README.md', 'local\n');
      git(clone, 'add', 'README.md');
      const result = await service.commit({
        repositoryRoot: clone,
        message: 'docs: unpushed',
        stage: [],
        unstage: [],
        expectedFingerprint: (await tree(clone)).indexFingerprint,
        push: true,
      });
      expect(result.commit.status).toBe('succeeded');
      expect(result.hash).toBe(git(clone, 'rev-parse', 'HEAD').trim());
      expect(result.push).toMatchObject({
        kind: 'push',
        status: 'failed',
        error: { code: 'network' },
      });
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
