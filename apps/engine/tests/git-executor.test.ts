import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitCommandError } from '@atlas/git';
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

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!gitAvailable)('createGitExecutor', () => {
  let temp: ReturnType<typeof createTempDir>;
  let env: Record<string, string>;
  let dir: string;

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' } });
  const hook = (script: string) => {
    const file = path.join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(file, `#!/bin/sh\n${script}\n`);
    chmodSync(file, 0o755);
  };

  beforeEach(() => {
    temp = createTempDir();
    const home = path.join(temp.dir, 'home');
    mkdirSync(home);
    writeFileSync(
      path.join(home, '.gitconfig'),
      '[user]\n\tname = Ana Dev\n\temail = ana@example.com\n',
    );
    env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home };
    dir = path.join(temp.dir, 'repo');
    mkdirSync(dir);
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(10_000));
    git('add', 'big.txt');
    git('commit', '-q', '-m', 'chore: big');
  });
  afterEach(() => temp.cleanup());

  it('fails instead of truncating when output exceeds the hard limit', async () => {
    const exec = createGitExecutor({ env, outputLimitBytes: 1000 });
    const failure = await exec(['show', 'HEAD:big.txt'], { cwd: dir, timeoutMs: 10_000 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GitCommandError);
    expect((failure as GitCommandError).kind).toBe('output-too-large');
  });

  it('truncates only when the caller asks for it and never reports exit code 0', async () => {
    const exec = createGitExecutor({ env, outputLimitBytes: 1000 });
    const result = await exec(['show', 'HEAD:big.txt'], {
      cwd: dir,
      timeoutMs: 10_000,
      maxOutputBytes: 100,
    });
    expect(result).toMatchObject({ truncated: true, exitCode: -1 });
    expect(result.stdout).toHaveLength(100);
  });

  it.skipIf(process.platform === 'win32')(
    'reports a git process killed by a signal as a failure',
    async () => {
      hook('kill -9 $PPID');
      writeFileSync(path.join(dir, 'a.txt'), 'a\n');
      git('add', 'a.txt');
      const exec = createGitExecutor({ env });
      await expect(
        exec(['commit', '-q', '-m', 'test: killed'], { cwd: dir, timeoutMs: 10_000 }),
      ).rejects.toMatchObject({ kind: 'failed', exitCode: null });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'stops hook processes together with git on timeout',
    async () => {
      const pidFile = path.join(temp.dir, 'hook.pid');
      hook(`sleep 30 &\necho $! > '${pidFile}'\nwait`);
      writeFileSync(path.join(dir, 'a.txt'), 'a\n');
      git('add', 'a.txt');
      const exec = createGitExecutor({ env });
      const pending = exec(['commit', '-q', '-m', 'test: slow hook'], {
        cwd: dir,
        timeoutMs: 1_000,
      });
      await expect(pending).rejects.toMatchObject({ kind: 'timeout' });
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      for (let i = 0; i < 50 && isAlive(pid); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(isAlive(pid)).toBe(false);
    },
  );
});
