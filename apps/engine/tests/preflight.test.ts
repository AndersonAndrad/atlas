import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreflightCheck, PreflightRun } from '@atlas/contracts';
import type { CheckExecution, CheckOutcome } from '@atlas/preflight';
import { createTempDir } from '../../../tests/support/temp.js';
import {
  FakeMirrorFactory,
  FakePtySpawner,
  FakeShellProvider,
} from '../../../tests/support/fake-terminal.js';
import { createEngine, type Engine } from '../src/engine.js';
import { ShellPreflightExecutor, actArguments } from '../src/adapters/preflight-executor.js';
import { GitSourceStateReader } from '../src/adapters/preflight-source.js';
import {
  FilePreflightLogStore,
  NodeWorkspaceFileAccess,
} from '../src/adapters/preflight-storage.js';
import { ActDockerTools } from '../src/adapters/preflight-tools.js';

const posix = process.platform !== 'win32';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (condition: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const ACT = {
  event: 'push' as const,
  matrix: ['os:ubuntu-24.04'],
  platforms: [{ label: 'ubuntu-24.04', image: 'catthehacker/ubuntu:act-24.04' }],
  containerArchitecture: 'linux/amd64' as const,
  cpus: 2,
  memoryMb: 4096,
};

describe.skipIf(!posix)('ShellPreflightExecutor', () => {
  let temp: ReturnType<typeof createTempDir>;
  let bin: string;
  let executor: ShellPreflightExecutor;

  const run = (
    invocation: CheckExecution['invocation'],
    options: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {},
  ) => {
    let output = '';
    const outcome = executor.run({
      invocation,
      cwd: temp.dir,
      env: options.env ?? {},
      timeoutMs: options.timeoutMs ?? 10_000,
      signal: options.signal ?? new AbortController().signal,
      onOutput: (_stream, chunk) => {
        output += chunk;
      },
    });
    return outcome.then((result: CheckOutcome) => ({ ...result, output }));
  };

  beforeEach(() => {
    temp = createTempDir();
    bin = path.join(temp.dir, 'bin');
    mkdirSync(bin);
    executor = new ShellPreflightExecutor({
      platform: 'linux',
      shell: '/bin/sh',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: temp.dir, SECRET_IN_TERMINAL: 'hunter2' },
      searchPath: async () => `${bin}:/usr/bin:/bin`,
      dataDir: path.join(temp.dir, 'data'),
      killGraceMs: 300,
    });
  });
  afterEach(() => temp.cleanup());

  it('reports the exit code and streams the output, with the check variables and CI=1', async () => {
    const passed = await run(
      { kind: 'shell', command: 'echo "$MODE $CI"; printf "é\\n" >&2' },
      { env: { MODE: 'strict' } },
    );
    expect(passed).toMatchObject({ kind: 'exited', exitCode: 0 });
    expect(passed.output).toContain('strict 1');
    expect(passed.output).toContain('é');
    const failed = await run({ kind: 'shell', command: 'exit 3' });
    expect(failed).toMatchObject({ kind: 'exited', exitCode: 3, detail: 'exited with code 3' });
  });

  it('stops the whole process tree on timeout and on cancel', async () => {
    const pidFile = path.join(temp.dir, 'child.pid');
    const timedOut = await run(
      { kind: 'shell', command: `sleep 30 & echo $! > ${pidFile}; wait` },
      { timeoutMs: 300 },
    );
    expect(timedOut.kind).toBe('timed-out');
    const child = Number(readFileSync(pidFile, 'utf8'));
    await waitFor(() => !isAlive(child));

    const controller = new AbortController();
    const cancelled = run(
      { kind: 'shell', command: `sleep 30 & echo $! > ${pidFile}; wait` },
      {
        signal: controller.signal,
      },
    );
    await waitFor(
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== String(child),
    );
    controller.abort();
    expect((await cancelled).kind).toBe('cancelled');
    await waitFor(() => !isAlive(Number(readFileSync(pidFile, 'utf8'))));
  });

  it('quotes package script names instead of letting the shell interpret them', async () => {
    writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "%s|" "$@"\n');
    chmodSync(path.join(bin, 'npm'), 0o755);
    const marker = path.join(temp.dir, 'pwned');
    const outcome = await run({
      kind: 'package-script',
      manager: 'npm',
      script: `lint'; touch ${marker}; echo '`,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toBe(`run|lint'; touch ${marker}; echo '|`);
    expect(existsSync(marker)).toBe(false);
    expect(await executor.hasTool('npm')).toBe(true);
    expect(await executor.hasTool('definitely-not-a-tool')).toBe(false);
  });

  it('runs act without a shell, with a minimal environment and empty secret files', async () => {
    writeFileSync(
      path.join(bin, 'act'),
      '#!/bin/sh\nfor arg in "$@"; do echo "arg:$arg"; done\necho "secret:${SECRET_IN_TERMINAL:-unset}"\n',
    );
    chmodSync(path.join(bin, 'act'), 0o755);
    const outcome = await run(
      { kind: 'act', workflowPath: '.github/workflows/ci.yml', job: 'test', settings: ACT },
      { env: { MODE: 'a b' } },
    );
    expect(outcome.exitCode).toBe(0);
    const args = outcome.output
      .split('\n')
      .filter((line) => line.startsWith('arg:'))
      .map((line) => line.slice(4));
    const empty = path.join(temp.dir, 'data', 'preflight', 'act-empty');
    expect(args).toEqual(
      actArguments('.github/workflows/ci.yml', 'test', ACT, { MODE: 'a b' }, empty),
    );
    expect(args).toEqual(
      expect.arrayContaining([
        '--container-daemon-socket',
        '-',
        '--secret-file',
        empty,
        'MODE=a b',
      ]),
    );
    expect(args.slice(0, 5)).toEqual(['push', '-W', '.github/workflows/ci.yml', '-j', 'test']);
    expect(args).toContain('--cpus=2 --memory=4096m');
    expect(readFileSync(empty, 'utf8')).toBe('');
    expect(outcome.output).toContain('secret:unset');
  });

  it('reports a missing act as a start failure', async () => {
    const outcome = await run({
      kind: 'act',
      workflowPath: '.github/workflows/ci.yml',
      job: null,
      settings: ACT,
    });
    expect(outcome).toMatchObject({ kind: 'start-failed', detail: 'act was not found' });
  });
});

describe('ActDockerTools', () => {
  let temp: ReturnType<typeof createTempDir>;
  beforeEach(() => {
    temp = createTempDir();
  });
  afterEach(() => temp.cleanup());

  it.skipIf(!posix)('reports versions, missing tools and a stopped Docker engine', async () => {
    const bin = path.join(temp.dir, 'bin');
    mkdirSync(bin);
    let now = new Date('2026-10-23T12:00:00Z');
    let dockerRunning = true;
    let probes = 0;
    const tools = new ActDockerTools({
      platform: 'linux',
      env: { HOME: temp.dir },
      home: temp.dir,
      searchPath: async () => bin,
      now: () => now,
      probe: async (file, args) => {
        probes += 1;
        if (path.basename(file) === 'act') return 'act version 0.2.80\n';
        if (!dockerRunning) throw new Error('Cannot connect to the Docker daemon');
        expect(args).toEqual(['version', '--format', '{{.Server.Version}}']);
        return '28.1.1\n';
      },
    });
    expect(await tools.status(false)).toMatchObject({
      act: { available: false, detail: expect.stringMatching(/not installed/) },
      docker: { available: false, detail: 'not installed' },
    });
    for (const name of ['act', 'docker']) {
      writeFileSync(path.join(bin, name), '#!/bin/sh\n');
      chmodSync(path.join(bin, name), 0o755);
    }
    expect((await tools.status(false)).act.available).toBe(false);
    expect(await tools.status(true)).toMatchObject({
      act: { available: true, detail: '0.2.80' },
      docker: { available: true, detail: '28.1.1' },
    });
    dockerRunning = false;
    const before = probes;
    await tools.status(false);
    expect(probes).toBe(before);
    now = new Date('2026-10-23T12:01:00Z');
    expect((await tools.status(false)).docker).toEqual({
      available: false,
      detail: 'the Docker engine is not running',
    });
  });

  it('lists act configuration files that could add options or secrets', async () => {
    const workspace = path.join(temp.dir, 'w');
    mkdirSync(workspace);
    writeFileSync(path.join(temp.dir, '.actrc'), '-s X=1\n');
    writeFileSync(path.join(workspace, '.actrc'), '');
    const tools = new ActDockerTools({
      platform: 'linux',
      env: {},
      home: temp.dir,
      searchPath: async () => '',
    });
    expect(await tools.actConfigFiles(workspace)).toEqual(['~/.actrc', '~/w/.actrc']);
  });
});

describe('GitSourceStateReader', () => {
  let temp: ReturnType<typeof createTempDir>;
  const git = (...args: string[]) =>
    spawnSync('git', args, {
      cwd: temp.dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    });
  beforeEach(() => {
    temp = createTempDir();
  });
  afterEach(() => temp.cleanup());

  it('changes with HEAD, staged, unstaged and untracked changes, and not with ignored files', async () => {
    const reader = new GitSourceStateReader(process.env);
    expect(await reader.read(temp.dir)).toBeNull();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'a@example.com');
    git('config', 'user.name', 'A');
    writeFileSync(path.join(temp.dir, '.gitignore'), 'dist/\n');
    writeFileSync(path.join(temp.dir, 'a.txt'), 'one\n');
    const unborn = await reader.read(temp.dir);
    expect(unborn).toMatchObject({ revision: null, branch: 'main' });
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const committed = (await reader.read(temp.dir))!;
    expect(committed.revision).toMatch(/^[0-9a-f]{40}$/);

    const seen = new Set([unborn!.fingerprint, committed.fingerprint]);
    writeFileSync(path.join(temp.dir, 'a.txt'), 'two\n');
    const unstaged = (await reader.read(temp.dir))!.fingerprint;
    git('add', 'a.txt');
    const staged = (await reader.read(temp.dir))!.fingerprint;
    writeFileSync(path.join(temp.dir, 'new.txt'), 'x\n');
    const untracked = (await reader.read(temp.dir))!.fingerprint;
    writeFileSync(path.join(temp.dir, 'new.txt'), 'y\n');
    const untrackedEdited = (await reader.read(temp.dir))!.fingerprint;
    for (const value of [unstaged, staged, untracked, untrackedEdited]) {
      expect(seen.has(value)).toBe(false);
      seen.add(value);
    }
    mkdirSync(path.join(temp.dir, 'dist'));
    writeFileSync(path.join(temp.dir, 'dist', 'out.js'), 'x');
    expect((await reader.read(temp.dir))!.fingerprint).toBe(untrackedEdited);
    // Reading the state is stable.
    expect((await reader.read(path.join(temp.dir)))!.fingerprint).toBe(untrackedEdited);
  });
});

describe('Preflight storage adapters', () => {
  let temp: ReturnType<typeof createTempDir>;
  beforeEach(() => {
    temp = createTempDir();
  });
  afterEach(() => temp.cleanup());

  it.skipIf(!posix)('never reads files outside the workspace, even through links', async () => {
    const workspace = path.join(temp.dir, 'w');
    mkdirSync(path.join(workspace, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(temp.dir, 'secret.txt'), 'secret');
    writeFileSync(path.join(workspace, 'package.json'), '{}');
    symlinkSync(path.join(temp.dir, 'secret.txt'), path.join(workspace, 'link.txt'));
    const files = new NodeWorkspaceFileAccess().files(workspace);
    expect(await files.readText('package.json', 100)).toBe('{}');
    expect(await files.readText('package.json', 1)).toBeNull();
    expect(await files.readText('../secret.txt', 100)).toBeNull();
    expect(await files.readText('link.txt', 100)).toBeNull();
    expect(await files.exists('link.txt')).toBe(false);
    expect(await files.list('.github/workflows')).toEqual([]);
    const access = new NodeWorkspaceFileAccess();
    mkdirSync(path.join(workspace, 'apps'));
    symlinkSync(temp.dir, path.join(workspace, 'escape'));
    expect(await access.folderInside(workspace, 'apps')).toBe(path.join(workspace, 'apps'));
    expect(await access.folderInside(workspace, '')).toBe(workspace);
    expect(await access.folderInside(workspace, 'escape')).toBeNull();
    expect(await access.folderInside(workspace, 'missing')).toBeNull();
    expect(await access.folderInside(workspace, 'package.json')).toBeNull();
  });

  it('writes, reads and removes logs by run id only', async () => {
    const store = new FilePreflightLogStore(path.join(temp.dir, 'logs'));
    const runId = '00000000-0000-4000-8000-000000000001';
    expect(await store.read(runId, 0)).toBeNull();
    await store.write(runId, 0, { firstSeq: 3, lines: [{ seq: 3, stream: 'out', text: 'hi' }] });
    expect(await store.read(runId, 0)).toEqual({
      firstSeq: 3,
      lines: [{ seq: 3, stream: 'out', text: 'hi' }],
    });
    await store.remove(runId);
    expect(await store.read(runId, 0)).toBeNull();
    await expect(store.write('../escape', 0, { firstSeq: 0, lines: [] })).rejects.toThrow();
  });
});

describe.skipIf(!posix)('Engine Preflight', { timeout: 30_000 }, () => {
  let temp: ReturnType<typeof createTempDir>;
  let engine: Engine;
  let workspace: string;

  const check = (
    id: string,
    command: string,
    overrides: Partial<PreflightCheck> = {},
  ): PreflightCheck => ({
    id,
    name: id,
    type: 'COMMAND',
    category: 'CUSTOM',
    workingDirectory: '',
    command,
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
    ...overrides,
  });

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

  const finished = async (runId: string): Promise<PreflightRun> => {
    let run = await engine.preflight.run(runId);
    for (let attempt = 0; attempt < 400 && run.status === 'RUNNING'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = await engine.preflight.run(runId);
    }
    return run;
  };

  beforeEach(async () => {
    temp = createTempDir();
    workspace = path.join(temp.dir, 'workspace');
    mkdirSync(workspace);
    engine = open(path.join(temp.dir, 'data'));
    await engine.initialize();
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('runs checks in a project, keeps history and logs, and survives a restart', async () => {
    const project = await engine.projects.create({ name: 'W', workspacePath: workspace });
    const preflight = await engine.preflight.openProject(project.id);
    await engine.preflight.saveConfig(preflight.id, {
      checks: [
        check('ok', 'echo GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
        check('fail', 'echo broken >&2; exit 4', { required: false }),
      ],
      profiles: [{ id: 'all', name: 'All', checkIds: ['ok', 'fail'], concurrency: 2 }],
    });
    const selection = { workspaceId: preflight.id, profileId: 'all', checkIds: null };
    const plan = await engine.preflight.plan(selection);
    const run = await engine.preflight.start({
      ...selection,
      authorizations: plan.checks.map((item) => ({ checkId: item.checkId, digest: item.digest })),
    });
    const done = await finished(run.id);
    expect(done.results.map((result) => [result.status, result.exitCode])).toEqual([
      ['PASSED', 0],
      ['FAILED', 4],
    ]);
    expect(done).toMatchObject({
      status: 'FAILED',
      requiredOutcome: 'PASSED',
      sourceRevision: null,
    });
    const output = await engine.preflight.output({ runId: run.id, position: 0, after: -1 });
    expect(output.lines.map((line) => line.text).join('\n')).not.toContain('ghp_abcdef');
    expect(
      (await engine.preflight.output({ runId: run.id, position: 1, after: -1 })).lines,
    ).toContainEqual(expect.objectContaining({ stream: 'err', text: 'broken' }));

    await engine.shutdown();
    engine = open(path.join(temp.dir, 'data'));
    await engine.initialize();
    const [summary] = await engine.preflight.runs({ workspaceId: preflight.id });
    expect(summary).toMatchObject({
      id: run.id,
      status: 'FAILED',
      counts: { PASSED: 1, FAILED: 1 },
    });
    expect(
      (await engine.preflight.output({ runId: run.id, position: 1, after: -1 })).complete,
    ).toBe(true);
    expect(
      (await engine.preflight.plan(selection)).checks.every((item) => item.authorization === null),
    ).toBe(true);
  });

  it('cancels a running check and marks runs interrupted by an Engine stop', async () => {
    const preflight = await engine.preflight.addFolder(workspace, true);
    await engine.preflight.saveConfig(preflight.id, {
      checks: [check('slow', 'sleep 30'), check('next', 'true')],
      profiles: [],
    });
    const selection = { workspaceId: preflight.id, profileId: null, checkIds: ['slow', 'next'] };
    const plan = await engine.preflight.plan(selection);
    const authorizations = plan.checks.map((item) => ({
      checkId: item.checkId,
      digest: item.digest,
    }));
    const run = await engine.preflight.start({ ...selection, authorizations });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await engine.preflight.run(run.id)).results[0]!.status === 'RUNNING') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await engine.preflight.cancel(run.id);
    const cancelled = await finished(run.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.results.map((result) => result.status)).toEqual(['CANCELLED', 'CANCELLED']);

    // A run left RUNNING by a crashed Engine is closed on the next start.
    const second = await engine.preflight.start({ ...selection, authorizations });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const db = path.join(temp.dir, 'data');
    const { openDatabase } = await import('@atlas/persistence');
    const raw = openDatabase({ filePath: path.join(db, 'atlas.db') });
    raw.prepare("UPDATE preflight_runs SET status = 'RUNNING' WHERE id = ?").run(run.id);
    raw.close();
    await engine.shutdown();
    engine = open(db);
    await engine.initialize();
    expect((await engine.preflight.run(run.id)).status).toBe('CANCELLED');
    expect((await engine.preflight.run(second.id)).status).toBe('CANCELLED');
  });
});
