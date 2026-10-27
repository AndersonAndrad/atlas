import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackgroundJob } from '@atlas/contracts';
import { isFinalJobStatus } from '@atlas/contracts';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createEngine, type Engine } from '../src/index.js';
import { gitJobResult } from '../src/jobs/git-executor.js';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version']);
    return process.platform !== 'win32';
  } catch {
    return false;
  }
})();

const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('gitJobResult', () => {
  const operation = (status: 'succeeded' | 'failed' | 'cancelled') =>
    ({
      status,
      summary: status === 'cancelled' ? 'Cancelled.' : null,
      error: status === 'failed' ? { code: 'rejected', message: 'Rejected.', output: '' } : null,
    }) as unknown as Parameters<typeof gitJobResult>[0];
  it('maps the Git operation outcome to the job outcome', () => {
    expect(gitJobResult(operation('succeeded'))).toEqual({ status: 'COMPLETED' });
    expect(gitJobResult(operation('failed'))).toEqual({
      status: 'FAILED',
      errorSummary: 'Rejected.',
    });
    expect(gitJobResult(operation('cancelled')).status).toBe('CANCELLED');
  });
});

/** Push, pull and fetch submitted as background jobs (SDD-025 Task 01), with real Git. */
describe.skipIf(!gitAvailable)('Git background jobs', { timeout: 60_000 }, () => {
  let temp: ReturnType<typeof createTempDir>;
  let engine: Engine;
  let env: Record<string, string>;
  let clone: string;
  let seed: string;
  let projectId: string;

  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' })
      .toString()
      .trim();
  const commit = (dir: string, message: string) => {
    writeFileSync(path.join(dir, `${message.replace(/\W+/g, '-')}.txt`), message);
    run(dir, 'add', '.');
    run(dir, 'commit', '-q', '-m', message);
  };

  const open = () =>
    createEngine({
      dataDir: path.join(temp.dir, 'data'),
      env: { ...env, SHELL: '/bin/sh' },
      terminals: {
        spawner: new FakePtySpawner(),
        mirrors: new FakeMirrorFactory(),
        shells: new FakeShellProvider(),
      },
    });

  const finished = async (jobId: string): Promise<BackgroundJob> => {
    let job = (await engine.jobs.get(jobId)).job;
    await waitFor(async () => {
      job = (await engine.jobs.get(jobId)).job;
      return isFinalJobStatus(job.status);
    });
    return job;
  };
  const gitJob = (input: Record<string, unknown>) =>
    engine.jobs.create({ type: 'GIT', repositoryRoot: clone, ...input }, 'desktop');
  const notificationTitles = async () =>
    (await engine.notifications.list()).items.map((item) => `${item.category}:${item.title}`);

  beforeEach(async () => {
    temp = createTempDir();
    const home = path.join(temp.dir, 'home');
    mkdirSync(home);
    env = { PATH: process.env.PATH ?? '', HOME: home };
    const origin = path.join(temp.dir, 'origin.git');
    run(temp.dir, 'init', '-q', '--bare', '-b', 'main', origin);
    seed = path.join(temp.dir, 'seed');
    run(temp.dir, 'clone', '-q', origin, seed);
    clone = path.join(temp.dir, 'clone');
    for (const dir of [seed]) {
      run(dir, 'config', 'user.name', 'Ana Dev');
      run(dir, 'config', 'user.email', 'ana@example.com');
    }
    commit(seed, 'chore: initial');
    run(seed, 'push', '-q', 'origin', 'HEAD:main');
    run(temp.dir, 'clone', '-q', origin, clone);
    run(clone, 'config', 'user.name', 'Ana Dev');
    run(clone, 'config', 'user.email', 'ana@example.com');
    engine = open();
    await engine.initialize();
    projectId = (await engine.createProject({ name: 'Web', workspacePath: clone })).id;
  });

  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('accepts a push at once, runs it in the Engine and keeps its Git log as output', async () => {
    commit(clone, 'feat: background push');
    const job = await gitJob({ action: 'push' });
    expect(job).toMatchObject({
      type: 'GIT',
      projectId,
      title: 'Push main → origin/main',
      capabilities: { retry: false },
    });
    const done = await finished(job.id);
    expect(done).toMatchObject({
      status: 'COMPLETED',
      executionReference: { type: 'git-operation', repositoryRoot: clone },
      capabilities: { retry: false, logs: true },
    });
    expect(run(seed, 'ls-remote', 'origin', 'main')).toContain(run(clone, 'rev-parse', 'HEAD'));
    const output = (await engine.jobs.output({ jobId: job.id, after: -1 })).lines
      .map((line) => line.text)
      .join('\n');
    expect(output).toMatch(/\$ git .*push --progress/);
    // The Git operation is listed with the other Git operations too.
    const reference = done.executionReference;
    expect(
      engine.gitOperations
        .list()
        .some((item) => reference?.type === 'git-operation' && item.id === reference.operationId),
    ).toBe(true);
    // One notification: the Git operation's; the job adds none.
    await waitFor(async () => (await notificationTitles()).length > 0);
    expect(
      (await notificationTitles()).filter((title) => title.startsWith('BACKGROUND_TASK')),
    ).toEqual([]);
  });

  it('refuses invalid submissions before accepting anything', async () => {
    run(clone, 'switch', '-q', '--detach', 'HEAD');
    await expect(gitJob({ action: 'push' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(gitJob({ action: 'pull', mode: 'ff-only' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(gitJob({ action: 'fetch', remote: 'nope' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      engine.jobs.create(
        { type: 'GIT', action: 'fetch', repositoryRoot: path.join(temp.dir, 'seed') },
        'desktop',
      ),
    ).rejects.toMatchObject({ code: 'GIT_REPOSITORY_UNAVAILABLE' });
    expect((await engine.jobs.list({})).jobs).toEqual([]);
  });

  it('reports a rejected push and a failing pre-push hook as failed jobs', async () => {
    commit(clone, 'feat: local');
    const hook = path.join(clone, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, '#!/bin/sh\necho blocked by policy >&2\nexit 1\n', { mode: 0o755 });
    const blocked = await finished((await gitJob({ action: 'push' })).id);
    expect(blocked.status).toBe('FAILED');
    expect(blocked.errorSummary).not.toBeNull();
    const output = (await engine.jobs.output({ jobId: blocked.id, after: -1 })).lines
      .map((line) => line.text)
      .join('\n');
    expect(output).toContain('blocked by policy');

    writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    commit(seed, 'feat: remote moved');
    run(seed, 'push', '-q', 'origin', 'HEAD:main');
    run(clone, 'fetch', '-q');
    const rejected = await finished((await gitJob({ action: 'push' })).id);
    expect(rejected.status).toBe('FAILED');
    // Never retried, never forced.
    await expect(engine.jobs.retry(rejected.id)).rejects.toMatchObject({
      code: 'JOB_TRANSITION_INVALID',
    });
  });

  it('runs pull and fetch, refuses duplicates and cancels a queued job', async () => {
    commit(seed, 'feat: upstream');
    run(seed, 'push', '-q', 'origin', 'HEAD:main');
    // A slow pre-push hook keeps a push running while the other jobs are submitted.
    commit(clone, 'feat: slow');
    writeFileSync(path.join(clone, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nsleep 2\nexit 1\n', {
      mode: 0o755,
    });
    const push = await gitJob({ action: 'push' });
    await expect(gitJob({ action: 'push' })).rejects.toMatchObject({
      code: 'JOB_TRANSITION_INVALID',
    });
    const fetch = await gitJob({ action: 'fetch' });
    // Same repository: it waits for the push and can be cancelled while queued.
    expect((await engine.jobs.get(fetch.id)).job.status).toBe('QUEUED');
    expect((await engine.jobs.cancel(fetch.id)).status).toBe('CANCELLED');
    // A running push cannot be stopped safely.
    await waitFor(async () => (await engine.jobs.get(push.id)).job.status === 'RUNNING');
    expect((await engine.jobs.get(push.id)).job.capabilities.cancel).toBe(false);
    await finished(push.id);

    expect((await finished((await gitJob({ action: 'fetch' })).id)).status).toBe('COMPLETED');
    run(clone, 'reset', '-q', '--hard', 'origin/main');
    commit(seed, 'feat: more');
    run(seed, 'push', '-q', 'origin', 'HEAD:main');
    run(clone, 'fetch', '-q');
    expect((await finished((await gitJob({ action: 'pull', mode: 'ff-only' })).id)).status).toBe(
      'COMPLETED',
    );
    expect(run(clone, 'log', '-1', '--format=%s')).toBe('feat: more');
  });

  it('marks a push still running when ATLAS quits as interrupted', async () => {
    commit(clone, 'feat: at shutdown');
    writeFileSync(path.join(clone, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nsleep 30\n', {
      mode: 0o755,
    });
    const job = await gitJob({ action: 'push' });
    await waitFor(async () => (await engine.jobs.get(job.id)).job.executionReference !== null);
    await engine.shutdown();
    engine = open();
    await engine.initialize();
    expect((await engine.jobs.get(job.id)).job).toMatchObject({
      status: 'INTERRUPTED',
      errorSummary: 'ATLAS quit while the job was running.',
    });
  });
});
