import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { DockerService } from '@atlas/docker';
import { LogBuffer } from '@atlas/preflight';
import { noopLogger } from '@atlas/shared';
import { createTempDir } from '../../../tests/support/temp.js';
import { DockerCliRunner } from '../src/adapters/docker-cli.js';
import { redactCredentials } from '@atlas/git';

const posix = process.platform !== 'win32';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe.skipIf(!posix)('DockerCliRunner', () => {
  let temp: ReturnType<typeof createTempDir>;
  let bin: string;
  let runner: DockerCliRunner;

  beforeEach(() => {
    temp = createTempDir();
    bin = path.join(temp.dir, 'bin');
    mkdirSync(bin);
    // A fake CLI: prints its arguments and environment, or behaves as told by $1.
    writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh
case "$1" in
  args) shift; printf '%s\\n' "$@" ;;
  env) env | sort ;;
  file) cat "$2"; echo "$2" > "${temp.dir}/file-path" ;;
  fail) echo "Error response from daemon: boom" >&2; exit 1 ;;
  slow) sleep 30 & echo $! > "${temp.dir}/child.pid"; wait ;;
  follow) echo first; sleep 30 ;;
esac
`,
    );
    chmodSync(path.join(bin, 'docker'), 0o755);
    runner = new DockerCliRunner({
      searchPath: async () => `${bin}:/usr/bin:/bin`,
      env: { HOME: temp.dir, DOCKER_CONFIG: '/cfg', SECRET_TOKEN: 'hunter2', PATH: '/nowhere' },
      platform: process.platform,
      killGraceMs: 200,
    });
  });
  afterEach(() => temp.cleanup());

  it('passes arguments as a list, never through a shell', async () => {
    expect(await runner.available()).toBe(true);
    const result = await runner.run(['args', '$(touch pwned)', 'a b', '; echo no']);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout.split('\n')).toEqual(['$(touch pwned)', 'a b', '; echo no', '']);
    expect(existsSync(path.join(temp.dir, 'pwned'))).toBe(false);
  });

  it('gives the CLI only the variables it needs', async () => {
    const { stdout } = await runner.run(['env']);
    expect(stdout).toContain('DOCKER_CONFIG=/cfg');
    expect(stdout).toContain('DOCKER_CLI_HINTS=false');
    expect(stdout).toContain(`PATH=${bin}:/usr/bin:/bin`);
    expect(stdout).not.toContain('hunter2');
  });

  it('reports failures and stops the whole tree on timeout', async () => {
    expect(await runner.run(['fail'])).toMatchObject({
      exitCode: 1,
      stderr: 'Error response from daemon: boom\n',
    });
    const slow = await runner.run(['slow'], { timeoutMs: 300 });
    expect(slow).toMatchObject({ exitCode: null, timedOut: true });
    const child = Number(readFileSync(path.join(temp.dir, 'child.pid'), 'utf8'));
    await waitFor(() => !isAlive(child));
  });

  it('writes private files only for the call and removes them', async () => {
    const output = await runner.withPrivateFile('A=1\n', (file) => runner.run(['file', file]));
    expect(output.stdout).toBe('A=1\n');
    const file = readFileSync(path.join(temp.dir, 'file-path'), 'utf8').trim();
    expect(existsSync(file)).toBe(false);
  });

  it('streams output until stopped', async () => {
    let output = '';
    const stream = runner.stream(['follow'], (_source, chunk) => {
      output += chunk;
    });
    await waitFor(() => output.includes('first'));
    stream.stop();
    await stream.done;
  });

  it('reports a missing CLI', async () => {
    const missing = new DockerCliRunner({
      searchPath: async () => path.join(temp.dir, 'empty'),
      env: {},
      platform: process.platform,
    });
    expect(await missing.available()).toBe(false);
  });
});

// Real Docker, only with ATLAS_DOCKER_TESTS=1 (PLAN-041 Q3): disposable containers named
// atlas-test-<uuid> from a local image; nothing else of the user's Docker is touched.
const realDocker = posix && process.env.ATLAS_DOCKER_TESTS === '1';
const IMAGE = process.env.ATLAS_DOCKER_TEST_IMAGE ?? 'redis:7';

describe.skipIf(!realDocker)('Docker integration (real engine)', { timeout: 120_000 }, () => {
  const tag = randomUUID();
  const name = `atlas-test-${tag}`;
  let service: DockerService;
  let context: string;

  beforeAll(async () => {
    service = new DockerService({
      runner: new DockerCliRunner({
        searchPath: async () => process.env.PATH ?? '',
        env: process.env,
        platform: process.platform,
      }),
      settings: { get: async () => null, set: async () => undefined },
      createLogLines: () => new LogBuffer(redactCredentials),
      redact: redactCredentials,
      homeDirectory: process.env.HOME ?? null,
      clock: { now: () => new Date() },
      generateId: randomUUID,
      logger: noopLogger,
    });
    const status = await service.status();
    expect(status.state).toBe('CONNECTED');
    context = status.context!;
  });
  afterAll(() => {
    // Only this run's containers, by their unique name.
    const ids = execFileSync('docker', ['ps', '-aq', '--filter', `name=${name}`], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    if (ids.length > 0) execFileSync('docker', ['rm', '-f', ...ids]);
    service.close();
  });

  it('creates, inspects, follows, measures, renames, stops and removes a container', async () => {
    const created = await service.create({
      context,
      image: IMAGE,
      name,
      env: [{ name: 'ATLAS_TEST_SECRET', value: 'hunter2' }],
      ports: [{ containerPort: 6379 }],
    });
    expect(created).toMatchObject({ name, state: 'running' });
    const ref = { context, containerId: created.id };

    const details = await service.container(ref);
    expect(details.envNames).toContain('ATLAS_TEST_SECRET');
    expect(JSON.stringify(details)).not.toContain('hunter2');
    expect(details.summary.ports[0]).toMatchObject({ hostIp: '127.0.0.1', containerPort: 6379 });

    const listed = await service.containers({ context });
    expect(listed.find((item) => item.id === created.id)?.name).toBe(name);

    const session = await service.openLogs('test', { ...ref, tail: 50 });
    await waitFor(() => service.readLogs({ sessionId: session, after: -1 }).lines.length > 0);
    expect(service.readLogs({ sessionId: session, after: -1 }).lines[0]!.text).toMatch(
      /^\d{4}-\d\d-\d\dT/,
    );
    service.closeLogs(session);

    const stats = await service.stats(ref);
    expect(stats.cpuPercent).not.toBeNull();
    expect(stats.memoryUsage).not.toBeNull();

    const terminal = await service.terminalCommand({ ...ref, confirmRoot: true });
    expect(terminal.command).toContain(`exec -it ${created.id}`);
    expect(['/bin/bash', '/bin/sh', '/bin/ash']).toContain(terminal.shell);

    await expect(service.remove(ref)).rejects.toMatchObject({ code: 'DOCKER_ACTION_INVALID' });
    expect((await service.lifecycle({ ...ref, action: 'pause' })).state).toBe('paused');
    expect((await service.lifecycle({ ...ref, action: 'unpause' })).state).toBe('running');
    expect((await service.rename({ ...ref, name: `${name}-renamed` })).name).toBe(
      `${name}-renamed`,
    );
    expect((await service.lifecycle({ ...ref, action: 'stop' })).state).toBe('exited');
    await service.remove(ref);
    await expect(service.container(ref)).rejects.toMatchObject({
      code: 'DOCKER_CONTAINER_NOT_FOUND',
    });
  });

  it('reports container events while watched', async () => {
    const changes: (string | null)[] = [];
    const watched = new DockerService({
      runner: new DockerCliRunner({
        searchPath: async () => process.env.PATH ?? '',
        env: process.env,
        platform: process.platform,
      }),
      settings: { get: async () => null, set: async () => undefined },
      createLogLines: () => new LogBuffer(redactCredentials),
      redact: redactCredentials,
      homeDirectory: null,
      clock: { now: () => new Date() },
      generateId: randomUUID,
      logger: noopLogger,
      onChange: (_context, id) => changes.push(id),
    });
    watched.watch('test', true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const created = await watched.create({
      context,
      image: IMAGE,
      name: `${name}-events`,
      start: false,
    });
    await waitFor(() => changes.includes(created.id));
    await watched.remove({ context, containerId: created.id });
    watched.close();
  });
});
