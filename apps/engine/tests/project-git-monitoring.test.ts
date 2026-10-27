import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir } from '../../../tests/support/temp.js';
import { createEngine, type Engine } from '../src/index.js';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

/** Per-project Git monitoring wired through the Engine with real repositories (SDD-024). */
describe.skipIf(!gitAvailable)('project Git monitoring in the Engine', () => {
  let temp: ReturnType<typeof createTempDir>;
  let env: Record<string, string>;
  let engine: Engine;
  const dataDir = () => path.join(temp.dir, 'engine-data');
  const start = () => createEngine({ dataDir: dataDir(), env, component: 'test' });

  const repository = (name: string) => {
    const dir = path.join(temp.dir, name);
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' } });
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'README.md'), 'one\n');
    git('add', '.');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
    writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
    return dir;
  };

  beforeEach(() => {
    temp = createTempDir();
    const home = path.join(temp.dir, 'home');
    mkdirSync(home);
    env = { PATH: process.env.PATH ?? '', HOME: home };
    engine = start();
  });

  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('follows the new-project default and never runs Git to list states', async () => {
    const monitored = await engine.createProject({ name: 'On', workspacePath: repository('on') });
    await engine.gitPreferences.update({ monitorNewProjects: false });
    const paused = await engine.createProject({ name: 'Off', workspacePath: repository('off') });

    const states = new Map(
      (await engine.projectGitMonitor.states()).map((state) => [state.projectId, state]),
    );
    expect(states.get(monitored.id)).toMatchObject({ monitoringEnabled: true, freshness: 'none' });
    expect(states.get(paused.id)).toMatchObject({ monitoringEnabled: false, snapshot: null });
  });

  it('refreshes a disabled project on request and keeps the snapshot across restarts', async () => {
    const project = await engine.createProject({ name: 'Repo', workspacePath: repository('r') });
    await engine.projectGitMonitor.setMonitoring(project.id, false);

    const { state, status } = await engine.projectGitMonitor.refresh(project.id);
    expect(status.state).toBe('repository');
    expect(state).toMatchObject({
      monitoringEnabled: false,
      freshness: 'cached',
      snapshot: {
        state: 'repository',
        branch: 'main',
        upstream: null,
        ahead: null,
        changes: { untracked: 1, total: 1 },
      },
    });

    await engine.shutdown();
    engine = start();
    expect(await engine.projectGitMonitor.state(project.id)).toMatchObject({
      monitoringEnabled: false,
      freshness: 'cached',
      refreshedAt: state.refreshedAt,
      snapshot: { changes: { untracked: 1 } },
    });
  });

  it('stores a snapshot from an explicit project read and a folder without Git', async () => {
    const plain = path.join(temp.dir, 'plain');
    mkdirSync(plain);
    const repo = await engine.createProject({ name: 'Repo', workspacePath: repository('read') });
    const folder = await engine.createProject({ name: 'Plain', workspacePath: plain });

    expect((await engine.projectGit(repo.id)).state).toBe('repository');
    expect((await engine.projectGitMonitor.state(repo.id)).snapshot?.state).toBe('repository');
    await engine.projectGitMonitor.refresh(folder.id);
    expect((await engine.projectGitMonitor.state(folder.id)).snapshot).toEqual({
      state: 'not-repository',
    });
  });

  it('drops the snapshot when the folder changes and when the project is removed', async () => {
    const project = await engine.createProject({ name: 'Move', workspacePath: repository('a') });
    await engine.projectGitMonitor.refresh(project.id);
    await engine.updateProject(project.id, { workspacePath: repository('b') });
    expect((await engine.projectGitMonitor.state(project.id)).snapshot).toBeNull();

    await engine.projectGitMonitor.refresh(project.id);
    await engine.removeProject(project.id);
    await expect(engine.projectGitMonitor.state(project.id)).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    // Renaming keeps the snapshot.
    const other = await engine.createProject({ name: 'Keep', workspacePath: repository('c') });
    await engine.projectGitMonitor.refresh(other.id);
    await engine.updateProject(other.id, { name: 'Kept' });
    expect((await engine.projectGitMonitor.state(other.id)).snapshot).not.toBeNull();
  });

  describe('pending commits (SDD-024 Task 02)', () => {
    const run = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        env: { ...env, GIT_CONFIG_NOSYSTEM: '1' },
        encoding: 'utf8',
      }).trim();
    const commit = (dir: string, message: string) => {
      writeFileSync(path.join(dir, `${message.replace(/\W+/g, '-').slice(0, 60)}.txt`), message);
      run(dir, 'add', '.');
      run(dir, 'commit', '-q', '-m', message);
    };
    /** A clone tracking `origin/main` of a bare remote, with identity configured. */
    const tracked = (name: string) => {
      const origin = path.join(temp.dir, `${name}-origin.git`);
      run(temp.dir, 'init', '-q', '--bare', '-b', 'main', origin);
      const seed = path.join(temp.dir, `${name}-seed`);
      run(temp.dir, 'clone', '-q', origin, seed);
      for (const dir of [seed]) {
        run(dir, 'config', 'user.name', 'Ana Dev');
        run(dir, 'config', 'user.email', 'ana@example.com');
      }
      commit(seed, 'chore: initial');
      run(seed, 'push', '-q', 'origin', 'HEAD:main');
      const clone = path.join(temp.dir, name);
      run(temp.dir, 'clone', '-q', origin, clone);
      run(clone, 'config', 'user.name', 'Ana Dev');
      run(clone, 'config', 'user.email', 'ana@example.com');
      return { origin, seed, clone };
    };
    const pending = async (projectId: string) => {
      const { state } = await engine.projectGitMonitor.refresh(projectId);
      return state.snapshot?.state === 'repository' ? state.snapshot : null;
    };

    it('lists three unpushed commits newest first and nothing for a clean branch', async () => {
      const { clone } = tracked('three');
      const project = await engine.createProject({ name: 'Three', workspacePath: clone });
      expect((await pending(project.id))?.pending).toEqual({ state: 'ok', commits: [], total: 0 });

      commit(clone, 'feat: one');
      commit(clone, 'feat: two');
      commit(clone, 'fix: three');
      const snapshot = await pending(project.id);
      expect(snapshot?.pending?.state).toBe('ok');
      expect(snapshot?.pending?.total).toBe(3);
      expect(snapshot?.pending?.commits.map((item) => item.subject)).toEqual([
        'fix: three',
        'feat: two',
        'feat: one',
      ]);
      expect(snapshot?.pending?.commits[0]).toMatchObject({
        author: 'Ana Dev',
        hash: run(clone, 'rev-parse', 'HEAD'),
        shortHash: run(clone, 'rev-parse', '--short', 'HEAD'),
      });
      expect(snapshot?.upstream).toBe('origin/main');

      // Persisted: a new Engine reads the same list without running Git.
      await engine.shutdown();
      engine = start();
      const stored = (await engine.projectGitMonitor.state(project.id)).snapshot;
      expect(stored?.state === 'repository' ? stored.pending?.commits : null).toHaveLength(3);
    });

    it('lists only local commits when the branches diverged', async () => {
      const { clone, seed } = tracked('diverged');
      commit(seed, 'feat: remote only');
      run(seed, 'push', '-q', 'origin', 'HEAD:main');
      commit(clone, 'feat: local only');
      run(clone, 'fetch', '-q');
      const project = await engine.createProject({ name: 'Diverged', workspacePath: clone });
      const snapshot = await pending(project.id);
      expect(snapshot).toMatchObject({ ahead: 1, behind: 1 });
      expect(snapshot?.pending?.commits.map((item) => item.subject)).toEqual(['feat: local only']);
    });

    it('reports missing, deleted and detached cases and never mixes branches', async () => {
      const { clone } = tracked('states');
      const project = await engine.createProject({ name: 'States', workspacePath: clone });
      commit(clone, 'feat: on main');
      expect((await pending(project.id))?.pending?.commits).toHaveLength(1);

      run(clone, 'switch', '-q', '-c', 'topic');
      commit(clone, 'feat: on topic');
      const topic = await pending(project.id);
      expect(topic).toMatchObject({ branch: 'topic', upstream: null });
      expect(topic?.pending).toEqual({ state: 'no-upstream', commits: [], total: null });

      run(clone, 'switch', '-q', '--detach', 'HEAD');
      expect((await pending(project.id))?.pending?.state).toBe('detached');

      run(clone, 'switch', '-q', 'topic');
      run(clone, 'push', '-q', '-u', 'origin', 'topic');
      run(clone, 'push', '-q', 'origin', '--delete', 'topic');
      run(clone, 'fetch', '-q', '--prune');
      expect((await pending(project.id))?.pending?.state).toBe('upstream-gone');

      run(clone, 'switch', '-q', 'main');
      const main = await pending(project.id);
      expect(main?.branch).toBe('main');
      expect(main?.pending?.commits.map((item) => item.subject)).toEqual(['feat: on main']);
    });

    it('bounds very long subjects so the stored list always fits', async () => {
      const { clone } = tracked('long');
      for (let index = 1; index <= 50; index += 1)
        commit(clone, `feat: ${index} ${'x'.repeat(6000)}`);
      const project = await engine.createProject({ name: 'Long', workspacePath: clone });
      const snapshot = await pending(project.id);
      expect(snapshot?.pending?.commits).toHaveLength(50);
      expect(snapshot?.pending?.commits[0]?.subject).toHaveLength(500);
    });

    it('reports a repository without commits', async () => {
      const dir = path.join(temp.dir, 'unborn');
      mkdirSync(dir);
      run(dir, 'init', '-q', '-b', 'main');
      const project = await engine.createProject({ name: 'Unborn', workspacePath: dir });
      expect((await pending(project.id))?.pending?.state).toBe('unborn');
    });

    it('keeps 50 commits and loads more on request', async () => {
      const { clone } = tracked('many');
      for (let index = 1; index <= 55; index += 1) commit(clone, `feat: ${index}`);
      const project = await engine.createProject({ name: 'Many', workspacePath: clone });
      const snapshot = await pending(project.id);
      expect(snapshot?.pending?.total).toBe(55);
      expect(snapshot?.pending?.commits).toHaveLength(50);
      const page = await engine.projectGitMonitor.pendingCommitsPage(project.id, 50);
      expect(page.commits.map((item) => item.subject)).toEqual([
        'feat: 5',
        'feat: 4',
        'feat: 3',
        'feat: 2',
        'feat: 1',
      ]);
    });

    it('empties the list after a successful push and keeps it when the push is rejected or a pre-push hook fails', async () => {
      const { clone, seed } = tracked('push');
      const project = await engine.createProject({ name: 'Push', workspacePath: clone });
      commit(clone, 'feat: to push');
      expect((await pending(project.id))?.pending?.commits).toHaveLength(1);

      // A failing pre-push hook stops the push.
      const hook = path.join(clone, '.git', 'hooks', 'pre-push');
      writeFileSync(hook, '#!/bin/sh\necho blocked >&2\nexit 1\n', { mode: 0o755 });
      expect((await engine.gitWorkspace.push(clone)).status).toBe('failed');
      expect((await pending(project.id))?.pending?.commits).toHaveLength(1);
      rmSync(hook);

      // Rejected: the remote moved on (non-fast-forward); ATLAS never forces.
      commit(seed, 'feat: remote moved');
      run(seed, 'push', '-q', 'origin', 'HEAD:main');
      expect((await engine.gitWorkspace.push(clone)).status).toBe('failed');
      expect((await pending(project.id))?.pending?.commits).toHaveLength(1);

      run(clone, 'pull', '-q', '--rebase');
      expect((await engine.gitWorkspace.push(clone)).status).toBe('succeeded');
      expect((await pending(project.id))?.pending).toEqual({ state: 'ok', commits: [], total: 0 });
    });
  });
});
