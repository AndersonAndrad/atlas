import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackgroundJob, JobStatus, PreflightCheck, TerminalEvent } from '@atlas/contracts';
import { isFinalJobStatus } from '@atlas/contracts';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createEngine, createEngineDispatcher, type Engine } from '../src/index.js';
import { commandJobDangers, commandJobResult } from '../src/jobs/command-executor.js';
import { preflightJobResult } from '../src/jobs/preflight-executor.js';

const posix = process.platform !== 'win32';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('command job helpers', () => {
  it('asks for confirmation for local and external side effects', () => {
    expect(commandJobDangers('npm test')).toEqual([]);
    expect(commandJobDangers('rm -rf dist')).toEqual(['deletes files recursively']);
    expect(commandJobDangers('git reset --hard HEAD~1')).toEqual(['discards Git changes']);
    expect(commandJobDangers('git push --force origin main')).toEqual([
      'pushes to a Git remote',
      'force-pushes to a Git remote',
    ]);
    expect(commandJobDangers('sudo make install')).toEqual(['runs with administrator rights']);
    expect(commandJobDangers('npm publish')).toEqual(['publishes a package']);
  });

  it('completes only on exit code 0', () => {
    expect(commandJobResult({ kind: 'exited', exitCode: 0, detail: 'exited' })).toEqual({
      status: 'COMPLETED',
      exitCode: 0,
    });
    expect(
      commandJobResult({ kind: 'exited', exitCode: 2, detail: 'exited with code 2' }),
    ).toMatchObject({ status: 'FAILED', exitCode: 2 });
    expect(commandJobResult({ kind: 'timed-out', exitCode: null, detail: 'x' }).status).toBe(
      'FAILED',
    );
    expect(commandJobResult({ kind: 'start-failed', exitCode: null, detail: 'x' }).status).toBe(
      'FAILED',
    );
    expect(commandJobResult({ kind: 'cancelled', exitCode: null, detail: 'x' }).status).toBe(
      'CANCELLED',
    );
  });

  it('completes a Preflight job only when the run passed', () => {
    const run = (status: 'PASSED' | 'FAILED' | 'INCOMPLETE' | 'CANCELLED') =>
      ({ status, results: [] }) as unknown as Parameters<typeof preflightJobResult>[0];
    expect(preflightJobResult(run('PASSED')).status).toBe('COMPLETED');
    expect(preflightJobResult(run('FAILED')).status).toBe('FAILED');
    expect(preflightJobResult(run('INCOMPLETE')).status).toBe('FAILED');
    expect(preflightJobResult(run('CANCELLED')).status).toBe('CANCELLED');
  });
});

describe.skipIf(!posix)('Engine background jobs (SDD-012 Milestone A)', { timeout: 40_000 }, () => {
  let temp: ReturnType<typeof createTempDir>;
  let engine: Engine;
  let workspace: string;
  let projectId: string;
  let events: TerminalEvent[];

  const open = (dataDir: string) =>
    createEngine({
      dataDir,
      env: { ...process.env, SHELL: '/bin/sh' },
      terminals: {
        spawner: new FakePtySpawner(),
        mirrors: new FakeMirrorFactory(),
        shells: new FakeShellProvider(),
      },
    });

  const start = async (dataDir: string) => {
    engine = open(dataDir);
    await engine.initialize();
    events = [];
    engine.terminals!.onEvent((event) => events.push(event));
  };

  const finished = async (jobId: string): Promise<BackgroundJob> => {
    let job = (await engine.jobs.get(jobId)).job;
    await waitFor(async () => {
      job = (await engine.jobs.get(jobId)).job;
      return isFinalJobStatus(job.status);
    });
    return job;
  };

  const command = (text: string, extra: Record<string, unknown> = {}) =>
    engine.jobs.create({ type: 'COMMAND', projectId, command: text, ...extra }, 'desktop');

  const output = async (jobId: string) =>
    (await engine.jobs.output({ jobId, after: -1 })).lines.map((line) => line.text).join('\n');

  const statusOf = async (jobId: string): Promise<JobStatus> =>
    (await engine.jobs.get(jobId)).job.status;

  beforeEach(async () => {
    temp = createTempDir();
    workspace = path.join(temp.dir, 'workspace');
    mkdirSync(workspace);
    await start(path.join(temp.dir, 'data'));
    projectId = (await engine.projects.create({ name: 'Payments', workspacePath: workspace })).id;
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('runs a command in the project folder with a redacted log and a notification (Scenario B)', async () => {
    const job = await command(
      'pwd; echo "token GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"; echo warn >&2',
    );
    expect(job).toMatchObject({ status: 'QUEUED', type: 'COMMAND', projectId });
    const done = await finished(job.id);
    expect(done).toMatchObject({ status: 'COMPLETED', exitCode: 0, errorSummary: null });
    const log = await output(job.id);
    expect(log).toContain(path.basename(workspace));
    expect(log).toContain('warn');
    expect(log).not.toContain('ghp_abcdef');
    // The log was saved to a file and survives the end of the job.
    expect(
      readFileSync(path.join(temp.dir, 'data', 'jobs', 'logs', job.id, '1.json'), 'utf8'),
    ).not.toContain('ghp_abcdef');
    await waitFor(async () => (await engine.notifications.list()).items.length > 0);
    expect((await engine.notifications.list()).items[0]).toMatchObject({
      type: 'SUCCESS',
      category: 'BACKGROUND_TASK',
      title: 'Background job completed',
      projectId,
      sourceName: 'Payments',
      action: { type: 'background-job', jobId: job.id },
    });
    // Clients follow the job through events.
    expect(
      events
        .filter((event) => event.type === 'jobs' && event.job.id === job.id)
        .map((event) => (event.type === 'jobs' ? event.job.status : null)),
    ).toEqual(expect.arrayContaining(['RUNNING', 'COMPLETED']));
  });

  it('fails on a non-zero exit code and retries as a new attempt', async () => {
    const job = await command('echo first >&2; exit 3');
    const failed = await finished(job.id);
    expect(failed).toMatchObject({
      status: 'FAILED',
      exitCode: 3,
      errorSummary: 'The command exited with code 3.',
    });
    await waitFor(async () => (await engine.notifications.list()).items.length > 0);
    expect((await engine.notifications.list()).items[0]).toMatchObject({
      type: 'ERROR',
      title: 'Background job failed',
    });
    await engine.jobs.retry(job.id);
    await finished(job.id);
    const details = await engine.jobs.get(job.id);
    expect(details.attempts.map((attempt) => [attempt.attempt, attempt.exitCode])).toEqual([
      [1, 3],
      [2, 3],
    ]);
    expect(await engine.jobs.output({ jobId: job.id, attempt: 1, after: -1 })).toMatchObject({
      complete: true,
    });
  });

  it('asks for confirmation before queueing a destructive command', async () => {
    await expect(command('rm -rf build')).rejects.toMatchObject({
      code: 'JOB_CONFIRMATION_REQUIRED',
      issues: [{ field: 'confirmDangerous', message: 'deletes files recursively' }],
    });
    expect((await engine.jobs.list({})).jobs).toEqual([]);
    const job = await command('rm -rf build', { confirmDangerous: true });
    expect(job.payload).toMatchObject({ confirmedDangerous: true });
    expect((await finished(job.id)).status).toBe('COMPLETED');
  });

  it('cancels a running command with its whole process tree', async () => {
    const pidFile = path.join(temp.dir, 'child.pid');
    const job = await command(`sleep 30 & echo $! > ${pidFile}; wait`);
    await waitFor(async () => {
      try {
        return readFileSync(pidFile, 'utf8').trim() !== '';
      } catch {
        return false;
      }
    });
    const child = Number(readFileSync(pidFile, 'utf8'));
    expect(engine.backgroundWork().backgroundJobs).toBe(1);
    const asked = await engine.jobs.cancel(job.id);
    expect(asked.cancelRequested).toBe(true);
    expect(await finished(job.id)).toMatchObject({ status: 'CANCELLED' });
    await waitFor(() => !isAlive(child));
    // A job the user cancelled is not reported.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await engine.notifications.list()).items).toEqual([]);
  });

  it('queues beyond the limits and starts the next job when one finishes (Scenario D)', async () => {
    await engine.jobs.updateSettings({ maxConcurrentJobs: 1 });
    const flag = path.join(temp.dir, 'release');
    const first = await command(`while [ ! -e ${flag} ]; do sleep 0.05; done`);
    const second = await command('echo second');
    await waitFor(async () => (await statusOf(first.id)) === 'RUNNING');
    expect(await statusOf(second.id)).toBe('QUEUED');
    expect(engine.jobs.summary()).toEqual({ running: 1, queued: 1, waitingApproval: 0 });
    mkdirSync(flag);
    expect((await finished(second.id)).status).toBe('COMPLETED');
    expect((await finished(first.id)).status).toBe('COMPLETED');
  });

  it('refuses commands of removed projects and unavailable folders', async () => {
    await engine.removeProject(projectId);
    await expect(command('echo hi')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    const other = await engine.projects.create({ name: 'Gone', workspacePath: workspace });
    projectId = other.id;
    rmSync(workspace, { recursive: true });
    await expect(command('echo hi')).rejects.toMatchObject({ code: 'PROJECT_PATH_UNAVAILABLE' });
  });

  it('keeps tokens typed in a command out of its title and notifications', async () => {
    const job = await command('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 true');
    expect(job.title).not.toContain('ghp_abcdef');
    await finished(job.id);
    await waitFor(async () => (await engine.notifications.list()).items.length > 0);
    expect(JSON.stringify((await engine.notifications.list()).items)).not.toContain('ghp_abcdef');
  });

  it('keeps the log of a starting job open until output can arrive', async () => {
    const job = await command('sleep 1; echo late');
    await waitFor(async () => (await statusOf(job.id)) === 'RUNNING');
    const first = await engine.jobs.output({ jobId: job.id, after: -1 });
    expect(first.complete).toBe(false);
    await finished(job.id);
    expect(await output(job.id)).toContain('late');
  });

  it('marks a job left running by an Engine that stopped as interrupted (Scenario C)', async () => {
    const job = await command('sleep 30');
    await waitFor(async () => (await statusOf(job.id)) === 'RUNNING');
    // A crash leaves the row RUNNING; simulate it after a clean stop.
    await engine.shutdown();
    const { openDatabase } = await import('@atlas/persistence');
    const raw = openDatabase({ filePath: path.join(temp.dir, 'data', 'atlas.db') });
    raw.prepare("UPDATE background_jobs SET status = 'RUNNING' WHERE id = ?").run(job.id);
    raw.close();
    await start(path.join(temp.dir, 'data'));
    const details = await engine.jobs.get(job.id);
    expect(details.job).toMatchObject({
      status: 'INTERRUPTED',
      errorSummary: 'ATLAS stopped before the job finished.',
      capabilities: { retry: true, cancel: false },
    });
    expect(details.history.at(-1)).toMatchObject({ status: 'INTERRUPTED' });
    // Nothing was started again.
    expect(engine.jobs.summary()).toEqual({ running: 0, queued: 0, waitingApproval: 0 });
    await waitFor(async () => (await engine.notifications.list()).items.length > 0);
    expect((await engine.notifications.list()).items[0]).toMatchObject({
      type: 'WARNING',
      title: 'Background job interrupted',
    });
  });

  describe('Preflight jobs', () => {
    const check = (id: string, text: string): PreflightCheck => ({
      id,
      name: id,
      type: 'COMMAND',
      category: 'CUSTOM',
      workingDirectory: '',
      command: text,
      packageManager: null,
      script: null,
      workflowPath: null,
      workflowJob: null,
      act: null,
      required: true,
      enabled: true,
      timeoutSeconds: 30,
      executionTriggers: ['MANUAL'],
      dependsOn: [],
      exclusive: false,
      requiredTools: [],
      env: {},
    });

    const setupPreflight = async (checks: PreflightCheck[]) => {
      const preflight = await engine.preflight.openProject(projectId);
      await engine.preflight.saveConfig(preflight.id, {
        checks,
        profiles: [{ id: 'all', name: 'All', checkIds: checks.map((c) => c.id), concurrency: 1 }],
      });
      const selection = { workspaceId: preflight.id, profileId: 'all', checkIds: null };
      const plan = await engine.preflight.plan(selection);
      return {
        preflight,
        selection,
        authorizations: plan.checks.map((item) => ({
          checkId: item.checkId,
          digest: item.digest,
        })),
      };
    };

    it('runs a profile in the background through Preflight (Scenario A)', async () => {
      const { preflight, selection, authorizations } = await setupPreflight([
        check('lint', 'echo lint'),
        check('test', 'echo test'),
      ]);
      await expect(
        engine.jobs.create(
          { type: 'PREFLIGHT', selection: { ...selection, authorizations: [] } },
          'desktop',
        ),
      ).rejects.toMatchObject({ code: 'PREFLIGHT_AUTHORIZATION_REQUIRED' });
      const job = await engine.jobs.create(
        { type: 'PREFLIGHT', selection: { ...selection, authorizations } },
        'desktop',
      );
      expect(job).toMatchObject({ title: 'Preflight: All', description: 'Payments', projectId });
      const done = await finished(job.id);
      expect(done).toMatchObject({
        status: 'COMPLETED',
        executionReference: { type: 'preflight-run', workspaceId: preflight.id },
        capabilities: { logs: false },
      });
      const runId = done.executionReference!.runId;
      expect((await engine.preflight.run(runId)).status).toBe('PASSED');
      // Preflight reports the run itself; the job adds no second notification.
      await waitFor(async () => (await engine.notifications.list()).items.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await engine.notifications.list()).items.map((item) => item.category)).toEqual([
        'PREFLIGHT',
      ]);
      expect(await engine.jobs.output({ jobId: job.id, after: -1 }).catch((e) => e.code)).toBe(
        'VALIDATION_FAILED',
      );
    });

    it('waits for the workspace and cancels the run with the job', async () => {
      const { selection, authorizations } = await setupPreflight([check('slow', 'sleep 30')]);
      const first = await engine.jobs.create(
        { type: 'PREFLIGHT', selection: { ...selection, authorizations } },
        'desktop',
      );
      const second = await engine.jobs.create(
        { type: 'PREFLIGHT', selection: { ...selection, authorizations } },
        'desktop',
      );
      await waitFor(async () => (await engine.jobs.get(first.id)).job.executionReference !== null);
      expect(await statusOf(second.id)).toBe('QUEUED');
      // Only the job's own run counts: it is already a Preflight run.
      expect(engine.backgroundWork()).toMatchObject({ preflightRuns: 1, backgroundJobs: 1 });
      await engine.jobs.cancel(second.id);
      await engine.jobs.cancel(first.id);
      const cancelled = await finished(first.id);
      expect(cancelled.status).toBe('CANCELLED');
      expect((await engine.preflight.run(cancelled.executionReference!.runId)).status).toBe(
        'CANCELLED',
      );
    });

    it('never reuses one-time authorizations on a retry', async () => {
      // The check looks like a publish: Preflight asks for it on every run.
      const { selection, authorizations } = await setupPreflight([
        check('publish', 'echo npm publish --dry-run; exit 1'),
      ]);
      const job = await engine.jobs.create(
        { type: 'PREFLIGHT', selection: { ...selection, authorizations } },
        'desktop',
      );
      expect(await finished(job.id)).toMatchObject({
        status: 'FAILED',
        errorSummary: '1 check failed.',
      });
      const retried = await engine.jobs.retry(job.id);
      expect(retried.payload).toMatchObject({ authorizations: [] });
      expect(await finished(job.id)).toMatchObject({
        status: 'FAILED',
        errorSummary: expect.stringContaining('authorization'),
      });
      // The check did not run a second time.
      expect((await engine.preflight.runs({ workspaceId: selection.workspaceId })).length).toBe(1);
    });
  });

  it('is read-only for the command-line client', async () => {
    const dispatcher = createEngineDispatcher(engine);
    expect(await dispatcher.call('jobs.list', [{}], 'cli')).toEqual({ jobs: [], nextBefore: null });
    await expect(
      dispatcher.call('jobs.create', [{ type: 'COMMAND', projectId, command: 'ls' }], 'cli'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(dispatcher.call('jobs.cancel', [projectId], 'cli')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const job = (await dispatcher.call(
      'jobs.create',
      [{ type: 'COMMAND', projectId, command: 'true' }],
      'desktop',
    )) as BackgroundJob;
    expect(job.origin).toBe('desktop');
    await finished(job.id);
  });
});
