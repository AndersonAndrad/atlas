import { containerCreationRisks, splitCommandLine } from '@atlas/contracts';
import {
  DockerService,
  classifyConnectionError,
  containerActions,
  describeEndpoint,
  dockerErrorMessage,
  isRootUser,
  parseContainerDetails,
  parseContainerEvent,
  parseContainerList,
  parseContexts,
  parsePorts,
  parseStats,
  parseVersion,
  type DockerCliResult,
  type DockerLogLines,
  type DockerRunner,
} from '@atlas/docker';
import { noopLogger } from '@atlas/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Fixtures captured from Docker Desktop 4.81 (Docker 29.6.1, API 1.55).
const ID = 'b0d2b0f1072688cb23d7beb159c6274d422ba483f6bcb0500f5a88b0a1f15cb7';
const VERSION = JSON.stringify({
  Client: { Version: '29.6.1', ApiVersion: '1.55', Context: 'desktop-linux' },
  Server: {
    Platform: { Name: 'Docker Desktop 4.81.0 (232925)' },
    Version: '29.6.1',
    ApiVersion: '1.55',
  },
});
const VERSION_NO_SERVER = JSON.stringify({ Client: { Version: '29.6.1' }, Server: null });
const CONTEXTS = [
  {
    Current: false,
    Description: 'Current DOCKER_HOST based configuration',
    DockerEndpoint: 'unix:///var/run/docker.sock',
    Error: '',
    Name: 'default',
  },
  {
    Current: true,
    Description: 'Docker Desktop',
    DockerEndpoint: 'unix:///Users/ana/.docker/run/docker.sock',
    Error: '',
    Name: 'desktop-linux',
  },
  {
    Current: false,
    Description: 'Build server',
    DockerEndpoint: 'ssh://deploy@build.example.com:2222',
    Error: '',
    Name: 'build',
  },
]
  .map((item) => JSON.stringify(item))
  .join('\n');
const PS_LINE = {
  Command: '"docker-entrypoint.s…"',
  CreatedAt: '2026-08-12 01:21:42 -0300 -03',
  HealthStatus: 'none',
  ID,
  Image: 'redis:8.2.1',
  Labels:
    'com.docker.compose.project=shop,com.docker.compose.service=cache,desktop.docker.io/ports/6379/tcp=:6379',
  Names: 'redis',
  Ports: '0.0.0.0:6379->6379/tcp, [::]:6379->6379/tcp',
  State: 'running',
  Status: 'Up 4 weeks',
};
const INSPECT = JSON.stringify([
  {
    Id: ID,
    Name: '/redis',
    Created: '2026-08-12T04:21:42.120387594Z',
    State: {
      Status: 'running',
      Running: true,
      OOMKilled: false,
      ExitCode: 0,
      Error: '',
      StartedAt: '2026-09-24T01:57:50.196377003Z',
      FinishedAt: '0001-01-01T00:00:00Z',
      Health: { Status: 'healthy', Log: [{ ExitCode: 0, End: '2026-10-26T10:00:00Z' }] },
    },
    Image: 'sha256:abc',
    RestartCount: 2,
    HostConfig: {
      NetworkMode: 'bridge',
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      Privileged: false,
      Memory: 268435456,
      NanoCpus: 1500000000,
      PidsLimit: null,
    },
    Mounts: [
      { Type: 'volume', Name: 'redis-data', Source: '/var/lib/x', Destination: '/data', RW: true },
      { Type: 'bind', Source: '/srv/conf', Destination: '/etc/redis', RW: false },
    ],
    Config: {
      User: '',
      Env: ['PATH=/usr/bin', 'REDIS_PASSWORD=hunter2'],
      Cmd: [
        'redis-server',
        '--requirepass',
        'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      ],
      Entrypoint: ['docker-entrypoint.sh'],
      Image: 'redis:8.2.1',
      WorkingDir: '/data',
      ExposedPorts: { '6379/tcp': {}, '16379/tcp': {} },
      Labels: { 'com.docker.compose.project': 'shop' },
      Healthcheck: { Test: ['CMD', 'redis-cli', 'ping'], Interval: 30000000000, Retries: 3 },
    },
    NetworkSettings: {
      Ports: {
        '6379/tcp': [
          { HostIp: '0.0.0.0', HostPort: '6379' },
          { HostIp: '::', HostPort: '6379' },
        ],
        '16379/tcp': null,
      },
      Networks: { bridge: { IPAddress: '172.17.0.2', Gateway: '172.17.0.1' } },
    },
  },
]);
const STATS = JSON.stringify({
  BlockIO: '26.2MB / 65.5kB',
  CPUPerc: '0.38%',
  MemPerc: '0.17%',
  MemUsage: '13.52MiB / 7.75GiB',
  NetIO: '1.32MB / 2.13MB',
  PIDs: '6',
});
const redact = (value: string) => value.replace(/ghp_[A-Za-z0-9]+/g, '[REDACTED]');

describe('Docker CLI output', () => {
  it('reads versions and tells an unreachable engine apart', () => {
    expect(parseVersion(VERSION)).toEqual({
      clientVersion: '29.6.1',
      serverVersion: '29.6.1',
      apiVersion: '1.55',
      platform: 'Docker Desktop 4.81.0 (232925)',
    });
    expect(parseVersion(VERSION_NO_SERVER)?.serverVersion).toBeNull();
    expect(parseVersion('not json')).toBeNull();
    expect(
      classifyConnectionError(
        'failed to connect to the docker API at unix:///x.sock; check if the path is correct and if the daemon is running',
      ),
    ).toBe('ENGINE_UNAVAILABLE');
    expect(
      classifyConnectionError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'),
    ).toBe('ENGINE_UNAVAILABLE');
    expect(
      classifyConnectionError(
        'permission denied while trying to connect to the Docker daemon socket',
      ),
    ).toBe('PERMISSION_DENIED');
    expect(classifyConnectionError('tls: bad certificate')).toBe('CONNECTION_ERROR');
  });

  it('lists contexts without users, ports or metadata, marking remote ones', () => {
    expect(parseContexts(CONTEXTS)).toEqual([
      expect.objectContaining({ name: 'default', endpointType: 'unix', remote: false }),
      expect.objectContaining({ name: 'desktop-linux', dockerCurrent: true, host: null }),
      {
        name: 'build',
        description: 'Build server',
        endpointType: 'ssh',
        remote: true,
        host: 'build.example.com',
        dockerCurrent: false,
        error: null,
      },
    ]);
    expect(describeEndpoint('tcp://127.0.0.1:2375')).toEqual({
      endpointType: 'tcp',
      remote: false,
      host: '127.0.0.1',
    });
    expect(describeEndpoint('tcp://10.0.0.5:2376').remote).toBe(true);
    expect(describeEndpoint('npipe:////./pipe/docker_engine').remote).toBe(false);
  });

  it('reads containers with ports, health, Compose labels and valid actions', () => {
    const [container] = parseContainerList(
      [JSON.stringify(PS_LINE), 'WARNING: not json', JSON.stringify({ ID: 'nope' })].join('\n'),
    );
    expect(container).toEqual({
      id: ID,
      shortId: ID.slice(0, 12),
      name: 'redis',
      image: 'redis:8.2.1',
      state: 'running',
      status: 'Up 4 weeks',
      health: 'none',
      ports: [{ hostIp: '0.0.0.0', hostPort: 6379, containerPort: 6379, protocol: 'tcp' }],
      createdAt: '2026-08-12 01:21:42 -0300 -03',
      composeProject: 'shop',
      composeService: 'cache',
      actions: ['stop', 'restart', 'pause', 'rename', 'terminal'],
    });
    const [old] = parseContainerList(
      JSON.stringify({ ...PS_LINE, HealthStatus: undefined, Status: 'Up 1 hour (unhealthy)' }),
    );
    expect(old?.health).toBe('unhealthy');
  });

  it('parses port ranges and exposed-only ports', () => {
    expect(parsePorts('0.0.0.0:8000-8001->8000-8001/tcp, 9000/udp')).toEqual([
      { hostIp: '0.0.0.0', hostPort: 8000, containerPort: 8000, protocol: 'tcp' },
      { hostIp: '0.0.0.0', hostPort: 8001, containerPort: 8001, protocol: 'tcp' },
      { hostIp: null, hostPort: null, containerPort: 9000, protocol: 'udp' },
    ]);
    expect(parsePorts('')).toEqual([]);
  });

  it('offers only actions valid for each state; never removal of a running container', () => {
    expect(containerActions('running')).not.toContain('remove');
    expect(containerActions('paused')).toEqual(['unpause', 'stop', 'rename']);
    expect(containerActions('exited')).toContain('remove');
    expect(containerActions('removing')).toEqual([]);
  });

  it('maps details without environment values and redacts commands', () => {
    const details = parseContainerDetails(INSPECT, redact)!;
    expect(details.envNames).toEqual(['PATH', 'REDIS_PASSWORD']);
    expect(JSON.stringify(details)).not.toContain('hunter2');
    expect(details.command).toEqual(['redis-server', '--requirepass', 'GITHUB_TOKEN=[REDACTED]']);
    expect(details).toMatchObject({
      user: '',
      runsAsRoot: true,
      restartPolicy: { name: 'unless-stopped' },
      restartCount: 2,
      finishedAt: null,
      exitCode: null,
      limits: { memoryBytes: 268435456, cpus: 1.5, pidsLimit: null },
      healthcheck: { test: ['CMD', 'redis-cli', 'ping'], intervalSeconds: 30, retries: 3 },
      healthLog: [{ exitCode: 0, at: '2026-10-26T10:00:00Z' }],
      summary: { name: 'redis', health: 'healthy', composeProject: 'shop' },
    });
    expect(details.mounts).toEqual([
      { type: 'volume', source: 'redis-data', destination: '/data', readOnly: false },
      { type: 'bind', source: '/srv/conf', destination: '/etc/redis', readOnly: true },
    ]);
    expect(details.summary.ports).toEqual([
      { hostIp: '0.0.0.0', hostPort: 6379, containerPort: 6379, protocol: 'tcp' },
      { hostIp: null, hostPort: null, containerPort: 16379, protocol: 'tcp' },
    ]);
  });

  it('reads Docker-reported usage and never invents missing values', () => {
    expect(parseStats(STATS, 'now')).toEqual({
      cpuPercent: 0.38,
      memoryUsage: '13.52MiB',
      memoryLimit: '7.75GiB',
      memoryPercent: 0.17,
      networkIO: '1.32MB / 2.13MB',
      blockIO: '26.2MB / 65.5kB',
      pids: 6,
      at: 'now',
    });
    expect(
      parseStats(JSON.stringify({ CPUPerc: '--', MemUsage: '-- / --', PIDs: '--' }), 'now'),
    ).toMatchObject({ cpuPercent: null, memoryUsage: null, pids: null, networkIO: null });
  });

  it('reads container events and error messages', () => {
    expect(
      parseContainerEvent(JSON.stringify({ Type: 'container', Action: 'start', Actor: { ID } })),
    ).toBe(ID);
    expect(parseContainerEvent(JSON.stringify({ Type: 'network', Actor: { ID } }))).toBeNull();
    expect(parseContainerEvent('{')).toBeNull();
    expect(dockerErrorMessage('Error response from daemon: No such container: x\n')).toBe(
      'No such container: x',
    );
    expect(isRootUser('0:0')).toBe(true);
    expect(isRootUser('node')).toBe(false);
  });
});

describe('container creation helpers', () => {
  const base = { binds: [], ports: [], network: undefined };
  it('warns about host networking, the Docker socket, broad mounts and open ports', () => {
    expect(containerCreationRisks(base, '/Users/ana')).toEqual([]);
    expect(
      containerCreationRisks(
        {
          network: 'host',
          binds: [
            { source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly: false },
            { source: '/Users/ana/', target: '/home', readOnly: true },
            { source: '/Users/ana/projects/app', target: '/app', readOnly: false },
          ],
          ports: [{ hostIp: '0.0.0.0', hostPort: 80, containerPort: 80, protocol: 'tcp' }],
        },
        '/Users/ana',
      ),
    ).toEqual([
      'uses the host network: every port of the container is open on this computer',
      'mounts the Docker socket: the container can control Docker and this computer',
      "mounts /Users/ana, giving it broad access to this computer's files",
      'publishes ports to the network, not only to this computer',
    ]);
  });

  it('warns about system subfolders and credential folders, not project folders', () => {
    const risks = (source: string) =>
      containerCreationRisks(
        { network: undefined, ports: [], binds: [{ source, target: '/x', readOnly: true }] },
        '/Users/ana',
      );
    expect(risks('/etc/ssh')).toEqual([
      "mounts /etc/ssh, giving it broad access to this computer's files",
    ]);
    expect(risks('/Users/ana/.ssh/')).toEqual([
      'mounts /Users/ana/.ssh, which may hold credentials',
    ]);
    expect(risks('/Users/ana/.aws/credentials')).toHaveLength(1);
    expect(risks('/var/run/docker.sock')[0]).toContain('Docker socket');
    expect(risks('/Users/ana/projects/app')).toEqual([]);
    expect(risks('/Users/ana/.sshkeys-not')).toEqual([]);
    expect(risks('/etcetera')).toEqual([]);
  });

  it('splits a command line without expanding anything', () => {
    expect(splitCommandLine(`sh -c "echo $HOME; ls" '' x`)).toEqual([
      'sh',
      '-c',
      'echo $HOME; ls',
      '',
      'x',
    ]);
    expect(splitCommandLine('   ')).toEqual([]);
  });
});

/** A scripted Docker CLI: each call answers from `handler`. */
class FakeRunner implements DockerRunner {
  calls: string[][] = [];
  files: string[] = [];
  installed = true;
  streams: {
    args: string[];
    emit(chunk: string): void;
    end(code: number): void;
    stopped: boolean;
  }[] = [];
  constructor(public handler: (args: string[]) => Partial<DockerCliResult>) {}
  async available() {
    return this.installed;
  }
  async run(args: readonly string[]) {
    this.calls.push([...args]);
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...this.handler([...args]) };
  }
  async withPrivateFile<T>(content: string, use: (file: string) => Promise<T>) {
    this.files.push(content);
    return use('/tmp/private/values');
  }
  stream(args: readonly string[], onData: (stream: 'out' | 'err', chunk: string) => void) {
    let resolve!: (code: number | null) => void;
    const done = new Promise<number | null>((settle) => {
      resolve = settle;
    });
    const entry = {
      args: [...args],
      stopped: false,
      emit: (chunk: string) => onData('out', chunk),
      end: (code: number) => resolve(code),
    };
    this.streams.push(entry);
    return {
      done,
      stop: () => {
        entry.stopped = true;
        resolve(null);
      },
    };
  }
}

class Lines implements DockerLogLines {
  lines: { seq: number; stream: 'out' | 'err' | 'atlas'; text: string }[] = [];
  complete = false;
  append(stream: 'out' | 'err', chunk: string) {
    for (const text of chunk.split('\n').filter(Boolean)) {
      this.lines.push({ seq: this.lines.length, stream, text });
    }
  }
  note(text: string) {
    this.lines.push({ seq: this.lines.length, stream: 'atlas', text });
  }
  finish() {
    this.complete = true;
  }
  read(after: number, limit: number) {
    return this.lines.slice(after + 1, after + 1 + limit);
  }
  get firstSeq() {
    return 0;
  }
  get count() {
    return this.lines.length;
  }
}

function setup(handler: (args: string[]) => Partial<DockerCliResult> = () => ({})) {
  const runner = new FakeRunner((args) => {
    const command = args[0] === '--context' ? args.slice(2) : args;
    if (command[0] === 'context') return { stdout: CONTEXTS };
    return handler(command);
  });
  const settings = new Map<string, string>();
  const changes: [string, string | null][] = [];
  const audit: Record<string, unknown>[] = [];
  let next = 0;
  const service = new DockerService({
    runner,
    settings: {
      get: async (key) => settings.get(key) ?? null,
      set: async (key, value) => void settings.set(key, value),
    },
    createLogLines: () => new Lines(),
    redact,
    homeDirectory: '/Users/ana',
    clock: { now: () => new Date('2026-10-26T12:00:00Z') },
    generateId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
    logger: {
      ...noopLogger,
      info: (message, context) => {
        if (message === 'Docker container action') audit.push(context ?? {});
      },
    },
    onChange: (context, id) => changes.push([context, id]),
  });
  return { runner, service, settings, changes, audit };
}

const inspectWith = (state: string, user = '') =>
  JSON.stringify([
    { ...JSON.parse(INSPECT)[0], State: { Status: state }, Config: { User: user, Image: 'x' } },
  ]);

afterEach(() => {
  vi.useRealTimers();
});

describe('DockerService (SDD-013 Milestone A)', () => {
  it('reports each connection state without requiring Docker', async () => {
    const missing = setup();
    missing.runner.installed = false;
    expect(await missing.service.status()).toMatchObject({ state: 'CLI_MISSING', context: null });

    const down = setup((args) =>
      args[0] === 'version'
        ? {
            exitCode: 1,
            stdout: VERSION_NO_SERVER,
            stderr: 'failed to connect to the docker API at unix:///x.sock',
          }
        : {},
    );
    expect(await down.service.status()).toMatchObject({
      state: 'ENGINE_UNAVAILABLE',
      context: 'desktop-linux',
      clientVersion: '29.6.1',
    });

    const up = setup((args) =>
      args[0] === 'version'
        ? { stdout: VERSION }
        : args[0] === 'compose'
          ? { stdout: 'v5.2.0\n' }
          : {},
    );
    expect(await up.service.status()).toMatchObject({
      state: 'CONNECTED',
      serverVersion: '29.6.1',
      composeVersion: 'v5.2.0',
      remote: false,
    });
    // Every call names the context it was made for.
    expect(up.runner.calls.find((call) => call.includes('version'))?.slice(0, 2)).toEqual([
      '--context',
      'desktop-linux',
    ]);
  });

  it("selects a context in ATLAS without changing Docker's own", async () => {
    const { service, runner } = setup();
    expect((await service.contexts()).effective).toBe('desktop-linux');
    const list = await service.selectContext({ name: 'build' });
    expect(list).toMatchObject({ selected: 'build', effective: 'build' });
    expect(runner.calls.some((call) => call.includes('use'))).toBe(false);
    await expect(service.selectContext({ name: 'gone' })).rejects.toMatchObject({
      code: 'DOCKER_CONTEXT_NOT_FOUND',
    });
    expect((await service.selectContext({ name: null })).effective).toBe('desktop-linux');
  });

  it('refuses requests for contexts that do not exist', async () => {
    const { service } = setup();
    await expect(service.containers({ context: 'other' })).rejects.toMatchObject({
      code: 'DOCKER_CONTEXT_NOT_FOUND',
    });
    await expect(service.containers({ context: '-H tcp://x' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('runs lifecycle actions only when valid, and audits them without values', async () => {
    let state = 'running';
    const { service, runner, audit } = setup((args) => {
      if (args[0] === 'inspect') return { stdout: inspectWith(state) };
      if (args[0] === 'stop') state = 'exited';
      return {};
    });
    const stopped = await service.lifecycle({
      context: 'desktop-linux',
      containerId: ID,
      action: 'stop',
    });
    expect(stopped.state).toBe('exited');
    expect(runner.calls.some((call) => call.join(' ').endsWith(`stop ${ID}`))).toBe(true);
    await expect(
      service.lifecycle({ context: 'desktop-linux', containerId: ID, action: 'pause' }),
    ).rejects.toMatchObject({ code: 'DOCKER_ACTION_INVALID' });
    expect(audit).toEqual([
      {
        action: 'stop',
        context: 'desktop-linux',
        containerId: ID.slice(0, 12),
        outcome: 'succeeded',
      },
    ]);
  });

  it('removes only stopped containers and never their volumes', async () => {
    let state = 'running';
    const { service, runner } = setup((args) =>
      args[0] === 'inspect' ? { stdout: inspectWith(state) } : {},
    );
    await expect(
      service.remove({ context: 'desktop-linux', containerId: ID }),
    ).rejects.toMatchObject({ code: 'DOCKER_ACTION_INVALID' });
    state = 'exited';
    await service.remove({ context: 'desktop-linux', containerId: ID });
    const rm = runner.calls.find((call) => call.includes('rm'))!;
    expect(rm).toEqual(['--context', 'desktop-linux', 'rm', ID]);
  });

  it('turns Docker failures into safe errors', async () => {
    const { service } = setup((args) =>
      args[0] === 'inspect'
        ? { exitCode: 1, stderr: 'Error response from daemon: No such container: x' }
        : {},
    );
    await expect(
      service.container({ context: 'desktop-linux', containerId: ID }),
    ).rejects.toMatchObject({ code: 'DOCKER_CONTAINER_NOT_FOUND' });
    const refused = setup((args) =>
      args[0] === 'inspect'
        ? { stdout: inspectWith('exited') }
        : args[0] === 'rename'
          ? { exitCode: 1, stderr: 'Error response from daemon: Conflict. The name is in use' }
          : {},
    );
    await expect(
      refused.service.rename({ context: 'desktop-linux', containerId: ID, name: 'cache' }),
    ).rejects.toMatchObject({
      code: 'DOCKER_COMMAND_FAILED',
      issues: [{ message: 'Conflict. The name is in use' }],
    });
  });

  it('creates containers with values in a private env file and confirmation for risks', async () => {
    const { service, runner } = setup((args) =>
      args[0] === 'create'
        ? { stdout: `${ID}\n` }
        : args[0] === 'inspect'
          ? { stdout: inspectWith('running') }
          : {},
    );
    const request = {
      context: 'desktop-linux',
      image: 'redis:7',
      name: 'cache',
      command: ['redis-server', '--appendonly', 'yes'],
      ports: [{ containerPort: 6379, hostPort: 6380 }],
      env: [{ name: 'REDIS_PASSWORD', value: 'hunter2' }],
      volumes: [{ name: 'cache-data', target: '/data' }],
      restartPolicy: 'unless-stopped' as const,
    };
    await service.create(request);
    const create = runner.calls.find((call) => call.includes('create'))!;
    expect(create).toEqual([
      '--context',
      'desktop-linux',
      'create',
      '--pull',
      'never',
      '--name',
      'cache',
      '--publish',
      '127.0.0.1:6380:6379/tcp',
      '--mount',
      'type=volume,source=cache-data,target=/data',
      '--restart',
      'unless-stopped',
      '--env-file',
      '/tmp/private/values',
      '--',
      'redis:7',
      'redis-server',
      '--appendonly',
      'yes',
    ]);
    expect(create.join(' ')).not.toContain('hunter2');
    expect(runner.files).toEqual(['REDIS_PASSWORD=hunter2\n']);
    expect(runner.calls.some((call) => call.includes('start'))).toBe(true);

    await expect(
      service.create({ context: 'desktop-linux', image: 'nginx', network: 'host' }),
    ).rejects.toMatchObject({ code: 'DOCKER_CONFIRMATION_REQUIRED' });
    await expect(
      service.create({
        context: 'desktop-linux',
        image: 'x',
        env: [
          { name: 'A', value: '1' },
          { name: 'A', value: '2' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.create({ context: 'desktop-linux', image: '-v /:/host' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.create({
        context: 'desktop-linux',
        image: 'x',
        env: [{ name: 'A', value: 'a\nB=1' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('opens a shell that exists, asks before root, and builds a safe command', async () => {
    const { service } = setup((args) => {
      if (args[0] === 'inspect') return { stdout: inspectWith('running') };
      if (args[0] === 'exec') return { exitCode: args.includes('/bin/bash') ? 126 : 0 };
      return {};
    });
    const ref = { context: 'desktop-linux', containerId: ID };
    await expect(service.terminalCommand(ref)).rejects.toMatchObject({
      code: 'DOCKER_CONFIRMATION_REQUIRED',
      issues: [{ field: 'confirmRoot' }],
    });
    expect(await service.terminalCommand({ ...ref, confirmRoot: true })).toEqual({
      command: `docker --context desktop-linux exec -it ${ID} /bin/ash`,
      title: 'redis (container)',
      shell: '/bin/ash',
      user: 'root (image default)',
    });
    expect(await service.terminalCommand({ ...ref, user: 'redis' })).toMatchObject({
      command: `docker --context desktop-linux exec -it --user redis ${ID} /bin/ash`,
    });
    const none = setup((args) =>
      args[0] === 'inspect'
        ? { stdout: inspectWith('running', 'node') }
        : args[0] === 'exec'
          ? { exitCode: 126 }
          : {},
    );
    await expect(none.service.terminalCommand(ref)).rejects.toMatchObject({
      code: 'DOCKER_SHELL_UNAVAILABLE',
    });
    const stopped = setup((args) =>
      args[0] === 'inspect' ? { stdout: inspectWith('exited') } : {},
    );
    await expect(
      stopped.service.terminalCommand({ ...ref, confirmRoot: true }),
    ).rejects.toMatchObject({ code: 'DOCKER_ACTION_INVALID' });
  });

  it('follows logs in bounded sessions that close with their window or when idle', async () => {
    const { service, runner } = setup((args) =>
      args[0] === 'inspect' ? { stdout: inspectWith('running') } : {},
    );
    const ref = { context: 'desktop-linux', containerId: ID };
    const session = await service.openLogs('window-1', ref);
    const stream = runner.streams[0]!;
    expect(stream.args).toEqual([
      '--context',
      'desktop-linux',
      'logs',
      '--follow',
      '--timestamps',
      '--tail',
      '500',
      ID,
    ]);
    stream.emit('2026-10-26T10:00:00Z ready\n');
    expect(service.readLogs({ sessionId: session, after: -1 })).toMatchObject({
      lines: [{ text: '2026-10-26T10:00:00Z ready' }],
      complete: false,
    });
    service.detach('window-1');
    expect(stream.stopped).toBe(true);
    expect(service.readLogs({ sessionId: session, after: 0 }).complete).toBe(true);

    for (let n = 0; n < 9; n += 1) await service.openLogs('window-2', ref);
    expect(runner.streams.filter((item) => !item.stopped)).toHaveLength(8);
  });

  it('watches events only while someone watches, coalescing and reconnecting', async () => {
    vi.useFakeTimers();
    const { service, runner, changes } = setup();
    service.watch('window-1', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.streams).toHaveLength(1);
    const events = runner.streams[0]!;
    const line = JSON.stringify({ Type: 'container', Action: 'die', Actor: { ID } });
    events.emit(`${line}\n${line}\n`);
    await vi.advanceTimersByTimeAsync(300);
    expect(changes).toEqual([['desktop-linux', ID]]);
    // The stream ended on its own (Docker stopped): reported, then retried.
    events.end(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(changes.at(-1)).toEqual(['desktop-linux', null]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(runner.streams).toHaveLength(2);
    service.watch('window-1', false);
    expect(runner.streams[1]!.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.streams).toHaveLength(2);
    service.close();
  });
});
