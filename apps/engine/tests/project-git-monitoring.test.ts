import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
});
