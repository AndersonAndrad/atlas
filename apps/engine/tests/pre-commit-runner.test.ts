import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreCommitStep } from '@atlas/contracts';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  ShellPreCommitRunner,
  preCommitStopTimeoutMs,
} from '../src/adapters/shell-pre-commit-runner.js';
import { ENGINE_SHUTDOWN_TIMEOUT_MS, GIT_SHUTDOWN_TIMEOUT_MS } from '../src/shutdown-timing.js';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('ShellPreCommitRunner', () => {
  let temp: ReturnType<typeof createTempDir>;
  let runner: ShellPreCommitRunner;
  const step = (command: string, overrides: Partial<PreCommitStep> = {}): PreCommitStep => ({
    name: 'step',
    command,
    mode: 'complete',
    timeoutSeconds: 10,
    readyAfterSeconds: 1,
    readyText: null,
    ...overrides,
  });
  const run = (value: PreCommitStep, signal = new AbortController().signal) =>
    runner.run(value, { cwd: temp.dir, signal });

  beforeEach(() => {
    temp = createTempDir();
    // A plain POSIX shell: the login flag is only used on macOS with the user's shell.
    runner = new ShellPreCommitRunner({
      platform: 'linux',
      shell: '/bin/sh',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', MARKER: 'from-env' },
      killGraceMs: 500,
    });
  });
  afterEach(() => temp.cleanup());

  it('passes when a command exits with 0 and reports its duration and output', async () => {
    const outcome = await run(step('echo "$MARKER" in "$(pwd)"; echo CI=$CI'));
    expect(outcome).toMatchObject({ status: 'passed', exitCode: 0, detail: 'exited with code 0' });
    expect(outcome.output).toContain(`from-env in ${temp.dir}`);
    expect(outcome.output).toContain('CI=1');
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fails with the exit code and keeps the output', async () => {
    const outcome = await run(step('echo "3 tests failed" >&2; exit 3'));
    expect(outcome).toMatchObject({ status: 'failed', exitCode: 3, detail: 'exited with code 3' });
    expect(outcome.output).toContain('3 tests failed');
  });

  it('stops commands that exceed their timeout', async () => {
    const outcome = await run(step('sleep 30', { timeoutSeconds: 1 }));
    expect(outcome).toMatchObject({ status: 'failed', detail: 'timed out after 1 s' });
    expect(outcome.durationMs).toBeLessThan(5000);
  });

  it('passes a start step that keeps running, then stops it and its children', async () => {
    const pidFile = path.join(temp.dir, 'child.pid');
    const outcome = await run(
      step(`sleep 30 & echo $! > "${pidFile}"; wait`, { mode: 'start', readyAfterSeconds: 1 }),
    );
    expect(outcome).toMatchObject({
      status: 'passed',
      detail: 'kept running for 1 s and was stopped',
    });
    const child = Number(readFileSync(pidFile, 'utf8').trim());
    // Signalled children exit (and are reaped) shortly after the root, not at the same instant.
    await expect.poll(() => isAlive(child)).toBe(false);
  });

  it('passes a start step as soon as it prints the ready text', async () => {
    const outcome = await run(
      step('echo starting; sleep 0.2; echo "Server ready on :3000"; sleep 30', {
        mode: 'start',
        readyText: 'ready on',
        readyAfterSeconds: 60,
        timeoutSeconds: 10,
      }),
    );
    expect(outcome.status).toBe('passed');
    expect(outcome.detail).toContain('printed "ready on"');
    expect(outcome.durationMs).toBeLessThan(5000);
  });

  it('fails a start step that exits with an error before it is ready', async () => {
    writeFileSync(path.join(temp.dir, 'server.sh'), 'echo "port in use" >&2\nexit 1\n');
    const outcome = await run(step('sh server.sh', { mode: 'start', readyAfterSeconds: 5 }));
    expect(outcome).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(outcome.output).toContain('port in use');
  });

  it('fails a start step that exits successfully before it is ready', async () => {
    expect(await run(step('true', { mode: 'start' }))).toMatchObject({
      status: 'failed',
      exitCode: 0,
      detail: 'exited before becoming ready',
    });
  });

  it('does not start an already cancelled command', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await run(step('echo ran > unexpected.txt'), controller.signal)).toMatchObject({
      status: 'cancelled',
    });
    expect(() => readFileSync(path.join(temp.dir, 'unexpected.txt'))).toThrow();
  });

  it('stops background descendants when the command exits', async () => {
    const outcome = await run(step('sleep 30 & echo $! > child.pid'));
    expect(outcome.status).toBe('passed');
    expect(outcome.durationMs).toBeLessThan(5000);
    const child = Number(readFileSync(path.join(temp.dir, 'child.pid'), 'utf8'));
    await expect.poll(() => isAlive(child)).toBe(false);
  });

  it('reports a missing shell without leaving a pending step', async () => {
    const missing = new ShellPreCommitRunner({
      platform: 'linux',
      shell: '/does-not-exist/atlas-shell',
      env: {},
    });
    expect(
      await missing.run(step('true'), { cwd: temp.dir, signal: new AbortController().signal }),
    ).toMatchObject({ status: 'failed', detail: 'the shell was not found' });
  });

  it('kills descendants that ignore SIGTERM after closing their output streams', async () => {
    writeFileSync(
      path.join(temp.dir, 'stubborn.sh'),
      'trap "" TERM\necho ready > ready\nwhile :; do sleep 30; done\n',
    );
    const outcome = await run(
      step(
        'sh stubborn.sh >/dev/null 2>&1 & echo $! > child.pid; ' +
          'while [ ! -f ready ]; do sleep 0.01; done; echo ready; wait',
        { mode: 'start', readyText: 'ready' },
      ),
    );
    expect(outcome.status).toBe('passed');
    const pid = Number(readFileSync(path.join(temp.dir, 'child.pid'), 'utf8'));
    await expect.poll(() => isAlive(pid)).toBe(false);
  });

  it('fails a start step that never prints the ready text', async () => {
    const outcome = await run(
      step('sleep 30', { mode: 'start', readyText: 'listening', timeoutSeconds: 1 }),
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      detail: 'did not print "listening" within 1 s',
    });
  });

  it('kills a step that ignores SIGTERM and keeps its output open', async () => {
    writeFileSync(
      path.join(temp.dir, 'stubborn.sh'),
      'trap "" TERM\n: > trapped\nwhile :; do sleep 1; done\n',
    );
    const outcome = await run(
      step(
        'sh stubborn.sh & echo $! > child.pid; ' +
          'while [ ! -f trapped ]; do sleep 0.01; done; echo ready; wait',
        { mode: 'start', readyText: 'ready' },
      ),
    );
    expect(outcome.status).toBe('passed');
    // Settles only once SIGKILL closed the pipes, after the 500 ms grace period.
    expect(outcome.durationMs).toBeGreaterThanOrEqual(400);
    expect(outcome.durationMs).toBeLessThan(2500);
    const pid = Number(readFileSync(path.join(temp.dir, 'child.pid'), 'utf8'));
    await expect.poll(() => isAlive(pid)).toBe(false);
  });

  it('redacts the output before limiting it, so a secret is not split from its key', async () => {
    // 64 KiB of filler after the secret: a plain tail would start with `WORD=…`.
    const outcome = await run(
      step(
        'printf "PASSWORD=fake-split-secret\\n"; ' +
          `head -c ${64 * 1024 - 20} /dev/zero | tr '\\0' x; exit 1`,
      ),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.output).not.toContain('fake-split-secret');
    expect(outcome.output.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('is cancelled by its abort signal', async () => {
    const controller = new AbortController();
    const pending = run(step('sleep 30'), controller.signal);
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toMatchObject({ status: 'cancelled', detail: 'cancelled' });
  });
});

describe('ShellPreCommitRunner on Windows', () => {
  type FakeProcess = ChildProcess & { stdout: PassThrough; stderr: PassThrough };
  const fakeProcess = (pid: number) =>
    Object.assign(new EventEmitter(), {
      pid,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    }) as unknown as FakeProcess;
  const step = (overrides: Partial<PreCommitStep> = {}): PreCommitStep => ({
    name: 'step',
    command: 'npm run "lint" && echo done',
    mode: 'complete',
    timeoutSeconds: 10,
    readyAfterSeconds: 1,
    readyText: null,
    ...overrides,
  });
  let root: FakeProcess;
  let killers: FakeProcess[];
  let spawnMock: ReturnType<typeof vi.fn>;
  let runner: ShellPreCommitRunner;
  const exitRoot = () => {
    root.emit('exit', 1, null);
    root.emit('close', 1, null);
  };
  const taskkillCalls = () => spawnMock.mock.calls.filter(([file]) => file === 'taskkill');

  beforeEach(() => {
    root = fakeProcess(4242);
    killers = [];
    spawnMock = vi.fn((file: string) => {
      if (file !== 'taskkill') return root;
      const killer = fakeProcess(5000 + killers.length);
      killers.push(killer);
      return killer;
    });
    runner = new ShellPreCommitRunner({
      platform: 'win32',
      shell: 'unused',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      killGraceMs: 50,
      spawn: spawnMock as unknown as typeof spawn,
    });
  });

  it('wraps the command in quotes like Node does for cmd with verbatim arguments', async () => {
    const pending = runner.run(step(), { cwd: 'C:\\repo', signal: new AbortController().signal });
    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', '"npm run "lint" && echo done"'],
      expect.objectContaining({ detached: false, windowsVerbatimArguments: true }),
    );
    root.emit('exit', 0, null);
    root.emit('close', 0, null);
    expect(await pending).toMatchObject({ status: 'passed', exitCode: 0 });
  });

  it('never runs taskkill once the root exited on its own, since its PID may be reused', async () => {
    const pending = runner.run(step(), { cwd: 'C:\\repo', signal: new AbortController().signal });
    root.emit('exit', 0, null);
    // Descendants keep the pipes open past the kill grace period.
    await new Promise((resolve) => setTimeout(resolve, 120));
    root.emit('close', 0, null);
    expect(await pending).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(taskkillCalls()).toHaveLength(0);
    expect(root.kill).not.toHaveBeenCalled();
  });

  it('does not run taskkill when the root exits with an error', async () => {
    const pending = runner.run(step(), { cwd: 'C:\\repo', signal: new AbortController().signal });
    exitRoot();
    expect(await pending).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(taskkillCalls()).toHaveLength(0);
  });

  it('runs taskkill on the tree before the root exits when aborted', async () => {
    const controller = new AbortController();
    const pending = runner.run(step(), { cwd: 'C:\\repo', signal: controller.signal });
    expect(taskkillCalls()).toHaveLength(0);
    controller.abort();
    expect(taskkillCalls()).toEqual([
      ['taskkill', ['/pid', '4242', '/t', '/f'], expect.objectContaining({ stdio: 'ignore' })],
    ]);
    killers[0]!.emit('exit', 0, null);
    exitRoot();
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(root.kill).not.toHaveBeenCalled();
  });

  it('runs taskkill on the tree before the root exits on timeout', async () => {
    const pending = runner.run(step({ timeoutSeconds: 0.05 }), {
      cwd: 'C:\\repo',
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(taskkillCalls()).toHaveLength(1));
    exitRoot();
    expect(await pending).toMatchObject({ status: 'failed', detail: 'timed out after 0.05 s' });
  });

  it('runs taskkill when a start step is stopped', async () => {
    const pending = runner.run(step({ mode: 'start', readyText: 'ready' }), {
      cwd: 'C:\\repo',
      signal: new AbortController().signal,
    });
    root.stdout.write('server ready\n');
    await vi.waitFor(() => expect(taskkillCalls()).toHaveLength(1));
    exitRoot();
    expect(await pending).toMatchObject({ status: 'passed' });
  });

  it('falls back to killing the root when taskkill fails or is missing', async () => {
    const controller = new AbortController();
    const pending = runner.run(step(), { cwd: 'C:\\repo', signal: controller.signal });
    controller.abort();
    expect(() => killers[0]!.emit('exit', 128, null)).not.toThrow();
    expect(root.kill).toHaveBeenCalledTimes(1);
    // The escalation runs taskkill again; this time it cannot start.
    await vi.waitFor(() => expect(taskkillCalls()).toHaveLength(2));
    killers[1]!.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect(root.kill).toHaveBeenCalledTimes(2);
    exitRoot();
    expect(await pending).toMatchObject({ status: 'cancelled' });
  });
});

describe('shutdown timing', () => {
  it('waits for Git operations longer than a cancelled step takes to stop', () => {
    expect(GIT_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(preCommitStopTimeoutMs());
    expect(ENGINE_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(GIT_SHUTDOWN_TIMEOUT_MS);
  });
});
