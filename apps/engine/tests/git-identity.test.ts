import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identityOverrides } from '@atlas/git';
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

describe('identityOverrides', () => {
  it('reports variables that change the identity of terminal commits', () => {
    expect(
      identityOverrides({
        PATH: '/bin',
        GIT_AUTHOR_NAME: 'Bot',
        EMAIL: 'me@example.com',
        GIT_CONFIG_GLOBAL: '/tmp/other',
        GIT_COMMITTER_EMAIL: '',
      }),
    ).toEqual([
      { variable: 'GIT_AUTHOR_NAME', value: 'Bot', affects: 'name' },
      { variable: 'EMAIL', value: 'me@example.com', affects: 'email' },
      { variable: 'GIT_CONFIG_GLOBAL', value: null, affects: 'configuration' },
    ]);
  });
});

/** Global and project identity in Git's own configuration (SDD-024 Task 03), real Git. */
describe.skipIf(!gitAvailable)('Git identity', () => {
  let temp: ReturnType<typeof createTempDir>;
  let home: string;
  let env: Record<string, string>;
  let engine: Engine;
  let repo: string;
  let projectId: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    }).trim();

  beforeEach(async () => {
    temp = createTempDir();
    home = path.join(temp.dir, 'home');
    mkdirSync(home);
    env = { PATH: process.env.PATH ?? '', HOME: home };
    repo = path.join(temp.dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    engine = createEngine({ dataDir: path.join(temp.dir, 'data'), env, component: 'test' });
    projectId = (await engine.createProject({ name: 'Repo', workspacePath: repo })).id;
  });

  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('reads and writes the global identity with its file', async () => {
    expect(await engine.gitIdentity.global()).toEqual({ name: null, email: null });
    const saved = await engine.gitIdentity.setGlobal({
      name: '  Ana Dev ',
      email: 'ana@example.com',
    });
    expect(saved).toEqual({
      name: { value: 'Ana Dev', scope: 'global', origin: path.join(home, '.gitconfig') },
      email: { value: 'ana@example.com', scope: 'global', origin: path.join(home, '.gitconfig') },
    });
    expect(git(home, 'config', '--global', 'user.name')).toBe('Ana Dev');
  });

  it('inherits, overrides locally and restores inheritance in the project repository', async () => {
    await engine.gitIdentity.setGlobal({ name: 'Ana Dev', email: 'ana@example.com' });
    const inherited = await engine.projectGitIdentity(projectId);
    expect(inherited).toMatchObject({
      repositoryRoot: repo,
      effective: {
        name: { value: 'Ana Dev', scope: 'global' },
        email: { value: 'ana@example.com', scope: 'global' },
      },
      local: { name: null, email: null },
    });

    const overridden = await engine.setProjectGitIdentity(projectId, {
      name: 'Ana (Work)',
      email: 'ana@company.example',
    });
    expect(overridden.effective.name).toEqual({
      value: 'Ana (Work)',
      scope: 'local',
      origin: '.git/config',
    });
    expect(overridden.local).toEqual({ name: 'Ana (Work)', email: 'ana@company.example' });
    // Written to this repository only.
    expect(git(repo, 'config', '--local', 'user.email')).toBe('ana@company.example');
    expect(git(home, 'config', '--global', 'user.email')).toBe('ana@example.com');
    // Commits made in the repository use it; nothing existing was changed.
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: first');
    expect(git(repo, 'log', '-1', '--format=%an <%ae>')).toBe('Ana (Work) <ana@company.example>');
    const head = git(repo, 'rev-parse', 'HEAD');

    const restored = await engine.setProjectGitIdentity(projectId, { name: null });
    expect(restored.local).toEqual({ name: null, email: 'ana@company.example' });
    expect(restored.effective.name).toMatchObject({ value: 'Ana Dev', scope: 'global' });
    // Removing an override that is not there is not an error.
    await engine.setProjectGitIdentity(projectId, { name: null, email: null });
    expect((await engine.projectGitIdentity(projectId)).local).toEqual({ name: null, email: null });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('follows conditional includes as Git resolves them', async () => {
    const work = path.join(home, '.gitconfig-work');
    writeFileSync(work, '[user]\n\tname = Ana at Work\n\temail = ana@work.example\n');
    writeFileSync(
      path.join(home, '.gitconfig'),
      `[user]\n\tname = Ana Dev\n\temail = ana@example.com\n[includeIf "gitdir:${repo}/"]\n\tpath = ${work}\n`,
    );
    const identity = await engine.projectGitIdentity(projectId);
    expect(identity.effective).toEqual({
      name: { value: 'Ana at Work', scope: 'global', origin: work },
      email: { value: 'ana@work.example', scope: 'global', origin: work },
    });
    // Outside that repository the plain global value applies.
    expect((await engine.gitIdentity.global()).name?.value).toBe('Ana Dev');
  });

  it('validates values and refuses projects without a repository', async () => {
    for (const input of [
      { name: '', email: 'a@b.c' },
      { name: 'Ana <x>', email: 'a@b.c' },
      { name: 'Ana\nEve', email: 'a@b.c' },
      { name: 'Ana', email: 'a b@c' },
      { name: 'Ana', email: '' },
    ]) {
      await expect(engine.gitIdentity.setGlobal(input)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    await expect(engine.setProjectGitIdentity(projectId, {})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    // Values that look like options are stored as text, never read as Git options.
    const tricky = await engine.setProjectGitIdentity(projectId, {
      name: '--file=/tmp/elsewhere',
      email: '-x@example.com',
    });
    expect(tricky.local).toEqual({ name: '--file=/tmp/elsewhere', email: '-x@example.com' });
    expect(git(repo, 'config', '--local', '--get', '--', 'user.name')).toBe(
      '--file=/tmp/elsewhere',
    );
    // An address without "@" is valid for Git; the window only warns about it.
    expect(
      (await engine.setProjectGitIdentity(projectId, { email: 'ana' })).effective.email?.value,
    ).toBe('ana');

    const plain = path.join(temp.dir, 'plain');
    mkdirSync(plain);
    const folder = await engine.createProject({ name: 'Plain', workspacePath: plain });
    await expect(engine.projectGitIdentity(folder.id)).rejects.toMatchObject({
      code: 'GIT_REPOSITORY_UNAVAILABLE',
    });
    await expect(engine.setProjectGitIdentity(folder.id, { name: 'Ana' })).rejects.toMatchObject({
      code: 'GIT_REPOSITORY_UNAVAILABLE',
    });
    await expect(
      engine.projectGitIdentity('00000000-0000-4000-8000-0000000000ff'),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('reports Git failures without changing anything', async () => {
    // A broken global file: Git refuses to read or write it.
    const global = path.join(home, '.gitconfig');
    writeFileSync(global, '[broken\n');
    await expect(
      engine.gitIdentity.setGlobal({ name: 'Ana', email: 'ana@example.com' }),
    ).rejects.toMatchObject({ code: 'GIT_CONFIG_FAILED' });
    expect(readFileSync(global, 'utf8')).toBe('[broken\n');
    writeFileSync(global, '');

    // A broken repository configuration makes the repository unreadable for Git.
    const config = path.join(repo, '.git', 'config');
    const original = readFileSync(config, 'utf8');
    writeFileSync(config, `${original}\n[broken\n`);
    await expect(engine.setProjectGitIdentity(projectId, { name: 'Ana' })).rejects.toMatchObject({
      code: 'GIT_REPOSITORY_UNAVAILABLE',
    });
    expect(readFileSync(config, 'utf8')).toContain('[broken');
    writeFileSync(config, original);
    // Without a terminal environment, shell variables are reported as not checked.
    expect((await engine.projectGitIdentity(projectId)).environmentChecked).toBe(false);
  });
});
