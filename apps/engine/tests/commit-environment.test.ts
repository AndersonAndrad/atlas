import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  captureLoginShellEnvironment,
  parseEnvironmentOutput,
} from '../src/adapters/login-shell-environment.js';
import { ShellEnvironment, withoutDevToolingVariables } from '../src/adapters/shell-environment.js';
import { gitEnvironment } from '../src/git/git-runner.js';
import { createEngine, type Engine } from '../src/index.js';

const zsh = '/bin/zsh';
const available = process.platform !== 'win32' && existsSync(zsh);

describe('development variables of ATLAS itself (PLAN-018)', () => {
  const devEnv = { NODE_ENV: 'development', NODE_ENV_ELECTRON_VITE: 'development', PATH: '/bin' };

  it('are dropped only when ATLAS runs under its development tooling', () => {
    expect(withoutDevToolingVariables(devEnv)).toEqual({ PATH: '/bin' });
    expect(withoutDevToolingVariables({ NODE_ENV: 'production', PATH: '/bin' })).toEqual({
      NODE_ENV: 'production',
      PATH: '/bin',
    });
    expect(gitEnvironment(devEnv).NODE_ENV).toBeUndefined();
    const shells = new ShellEnvironment({ env: devEnv, platform: 'darwin', appVersion: '1' });
    expect(shells.shellEnvironment()).not.toHaveProperty('NODE_ENV');
    expect(shells.shellEnvironment()).not.toHaveProperty('NODE_ENV_ELECTRON_VITE');
  });

  it('parses a shell environment after anything its start-up files printed', () => {
    const output =
      'Welcome!\n__ATLAS_ENVIRONMENT__\nPATH=/usr/bin\0MULTI=a\nb\0SHLVL=2\0_=/usr/bin/env\0' +
      'ELECTRON_RUN_AS_NODE=1\0NODE_ENV=development\0NODE_ENV_ELECTRON_VITE=development\0';
    expect(parseEnvironmentOutput(output)).toEqual({ PATH: '/usr/bin', MULTI: 'a\nb' });
    expect(parseEnvironmentOutput('no marker')).toBeNull();
  });
});

describe.skipIf(!available)('commits use a fresh shell environment (PLAN-018)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let home: string;
  let engine: Engine;
  let dir: string;
  const env = () => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    ZDOTDIR: home,
    SHELL: zsh,
    GIT_CONFIG_NOSYSTEM: '1',
    // As when ATLAS is started with `pnpm dev`.
    NODE_ENV: 'development',
    NODE_ENV_ELECTRON_VITE: 'development',
  });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env: env(), encoding: 'utf8' });
  const rc = (value: string, extra = '') =>
    writeFileSync(path.join(home, '.zshrc'), `export ATLAS_TEST_VALUE=${value}\n${extra}`);

  beforeEach(async () => {
    temp = createTempDir();
    home = path.join(temp.dir, 'home');
    mkdirSync(home);
    rc('one');
    dir = path.join(temp.dir, 'repo');
    mkdirSync(dir);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Ana');
    git('config', 'user.email', 'ana@example.com');
    writeFileSync(path.join(dir, 'README.md'), '# repo\n');
    git('add', '.');
    git('commit', '-qm', 'chore: init');
    // A hook records what Git hooks see.
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(
      hook,
      `#!/bin/sh\nprintf '%s|%s\\n' "$ATLAS_TEST_VALUE" "\${NODE_ENV:-unset}" >> "${path.join(temp.dir, 'hook.txt')}"\n`,
    );
    chmodSync(hook, 0o755);
    engine = createEngine({
      dataDir: path.join(temp.dir, 'data'),
      component: 'test',
      env: env(),
      terminals: {
        spawner: new FakePtySpawner(),
        mirrors: new FakeMirrorFactory(),
        shells: new FakeShellProvider(),
      },
    });
    await engine.initialize();
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

  it('gives checks and hooks the environment a new terminal would have, read at each commit', async () => {
    const project = await engine.projects.create({ name: 'repo', workspacePath: dir });
    const out = path.join(temp.dir, 'step.txt');
    await engine.projectGitSettings.set(project.id, {
      enforceConventionalCommits: true,
      preCommitSteps: [
        {
          name: 'env',
          command: `printf '%s|%s\\n' "$ATLAS_TEST_VALUE" "\${NODE_ENV:-unset}" >> "${out}"`,
          mode: 'complete',
          timeoutSeconds: 30,
          readyAfterSeconds: 2,
          readyText: null,
        },
      ],
    });

    const first = await commit('a.txt');
    expect(first.commit.status).toBe('succeeded');
    // The profile changes while ATLAS is running; the next commit sees it.
    rc('two');
    const second = await commit('b.txt');
    expect(second.commit.status).toBe('succeeded');
    expect(second.commit.summary).not.toContain('could not be read');

    expect(readFileSync(out, 'utf8')).toBe('one|unset\ntwo|unset\n');
    expect(readFileSync(path.join(temp.dir, 'hook.txt'), 'utf8')).toBe('one|unset\ntwo|unset\n');
  });

  it('keeps a NODE_ENV the user sets in the shell profile', async () => {
    rc('three', 'export NODE_ENV=production\n');
    const result = await commit('c.txt');
    expect(result.commit.status).toBe('succeeded');
    expect(readFileSync(path.join(temp.dir, 'hook.txt'), 'utf8')).toBe('three|production\n');
  });

  it('gives up on slow start-up files and lets callers fall back', async () => {
    rc('slow', 'sleep 5\n');
    const started = Date.now();
    await expect(
      captureLoginShellEnvironment({
        shell: zsh,
        platform: process.platform,
        env: env(),
        cwd: dir,
        timeoutMs: 300,
      }),
    ).rejects.toThrow('took too long');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
