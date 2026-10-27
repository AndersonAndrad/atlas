import {
  CONTAINER_STATES,
  type ContainerAction,
  type ContainerHealth,
  type ContainerState,
  type DockerConnectionState,
  type DockerContainerDetails,
  type DockerContainerStats,
  type DockerContainerSummary,
  type DockerContextSummary,
  type DockerEndpointType,
  type DockerMount,
  type DockerPort,
} from '@atlas/contracts';

// Pure readers of the Docker CLI's JSON output (Docker CLI 23 or newer). Every field is
// read defensively: a missing field becomes null, never an invented value.

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : null;

/** `--format json` prints one JSON object per line (or one array); malformed lines are skipped. */
export function parseJsonLines(output: string): Json[] {
  const trimmed = output.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) {
    try {
      const value = JSON.parse(trimmed) as unknown;
      return Array.isArray(value) ? value.filter(isObject) : [];
    } catch {
      return [];
    }
  }
  const items: Json[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as unknown;
      if (isObject(value)) items.push(value);
    } catch {
      // Not JSON (e.g. a warning line): ignored.
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Connection and contexts
// ---------------------------------------------------------------------------

/** What a failed Docker call means for the connection (FR-1301). */
export function classifyConnectionError(stderr: string): DockerConnectionState {
  if (/permission denied/i.test(stderr)) return 'PERMISSION_DENIED';
  if (
    /cannot connect to the docker daemon|failed to connect to the docker api|is the docker daemon running|error during connect|docker_engine.*(cannot find|not found)|no such file or directory/i.test(
      stderr,
    )
  ) {
    return 'ENGINE_UNAVAILABLE';
  }
  return 'CONNECTION_ERROR';
}

export interface DockerVersionInfo {
  clientVersion: string | null;
  serverVersion: string | null;
  apiVersion: string | null;
  platform: string | null;
}

/** `docker version --format json`; `Server` is null when the engine is unreachable. */
export function parseVersion(output: string): DockerVersionInfo | null {
  const [value] = parseJsonLines(output);
  if (value === undefined) return null;
  const client = isObject(value.Client) ? value.Client : {};
  const server = isObject(value.Server) ? value.Server : null;
  const platform = server && isObject(server.Platform) ? text(server.Platform.Name) : null;
  return {
    clientVersion: text(client.Version),
    serverVersion: server ? text(server.Version) : null,
    apiVersion: server ? text(server.ApiVersion) : null,
    platform,
  };
}

/** Endpoint type and host without user, password or port (FR-1302). */
export function describeEndpoint(endpoint: string | null): {
  endpointType: DockerEndpointType;
  remote: boolean;
  host: string | null;
} {
  if (endpoint === null) return { endpointType: 'other', remote: false, host: null };
  const scheme = /^([a-z]+):\/\//i.exec(endpoint)?.[1]?.toLowerCase();
  if (scheme === 'unix') return { endpointType: 'unix', remote: false, host: null };
  if (scheme === 'npipe') return { endpointType: 'npipe', remote: false, host: null };
  if (scheme === 'tcp' || scheme === 'ssh') {
    let host: string | null;
    try {
      host = new URL(endpoint.replace(/^tcp:/i, 'http:')).hostname.replace(/^\[|\]$/g, '');
    } catch {
      host = null;
    }
    const local = host !== null && ['localhost', '127.0.0.1', '::1'].includes(host);
    return {
      endpointType: scheme,
      remote: scheme === 'ssh' || !local,
      host,
    };
  }
  return { endpointType: 'other', remote: true, host: null };
}

/** `docker context ls --format json`. Metadata and TLS material are never read. */
export function parseContexts(output: string): DockerContextSummary[] {
  return parseJsonLines(output)
    .filter((item) => text(item.Name) !== null)
    .map((item) => ({
      name: text(item.Name)!,
      description: (text(item.Description) ?? '').slice(0, 120),
      ...describeEndpoint(text(item.DockerEndpoint)),
      dockerCurrent: item.Current === true,
      error: text(item.Error)?.slice(0, 200) ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/** Actions valid in a state (FR-1305); removal never applies to a running container. */
export function containerActions(state: ContainerState): ContainerAction[] {
  switch (state) {
    case 'created':
      return ['start', 'rename', 'remove'];
    case 'running':
      return ['stop', 'restart', 'pause', 'rename', 'terminal'];
    case 'paused':
      return ['unpause', 'stop', 'rename'];
    case 'restarting':
      return ['stop', 'rename'];
    case 'exited':
      return ['start', 'restart', 'rename', 'remove'];
    case 'dead':
      return ['remove'];
    case 'removing':
      return [];
  }
}

function containerState(value: unknown): ContainerState {
  const state = typeof value === 'string' ? value.toLowerCase() : '';
  return (CONTAINER_STATES as readonly string[]).includes(state)
    ? (state as ContainerState)
    : 'dead';
}

function healthOf(item: Json, status: string): ContainerHealth {
  const reported = text(item.HealthStatus)?.toLowerCase();
  if (reported === 'healthy' || reported === 'unhealthy' || reported === 'starting') {
    return reported;
  }
  if (reported === 'none') return 'none';
  if (/\(unhealthy\)/i.test(status)) return 'unhealthy';
  if (/\(healthy\)/i.test(status)) return 'healthy';
  if (/\(health: starting\)/i.test(status)) return 'starting';
  return 'none';
}

const PROTOCOLS = new Set(['tcp', 'udp', 'sctp']);
const MAX_PORTS = 200;

/**
 * `docker ps` ports, e.g. "0.0.0.0:8000-8001->8000-8001/tcp, [::]:6379->6379/tcp, 9000/tcp".
 * IPv4 and IPv6 entries for the same mapping are reported once.
 */
export function parsePorts(value: string | null): DockerPort[] {
  if (value === null) return [];
  const ports: DockerPort[] = [];
  const seen = new Set<string>();
  const add = (port: DockerPort) => {
    const key = `${port.hostPort}:${port.containerPort}/${port.protocol}`;
    if (seen.has(key) || ports.length >= MAX_PORTS) return;
    seen.add(key);
    ports.push(port);
  };
  for (const entry of value.split(/,\s*/)) {
    const match = /^(?:(.*):(\d+)(?:-(\d+))?->)?(\d+)(?:-(\d+))?\/(\w+)$/.exec(entry.trim());
    if (match === null) continue;
    const [, hostIp, hostStart, hostEnd, containerStart, containerEnd, protocol] = match;
    if (!PROTOCOLS.has(protocol!)) continue;
    const first = Number(containerStart);
    const count = containerEnd === undefined ? 1 : Number(containerEnd) - first + 1;
    for (let offset = 0; offset < count && offset < MAX_PORTS; offset += 1) {
      add({
        hostIp: hostIp === undefined ? null : hostIp.replace(/^\[|\]$/g, ''),
        hostPort:
          hostStart === undefined
            ? null
            : hostEnd === undefined
              ? Number(hostStart)
              : Number(hostStart) + offset,
        containerPort: first + offset,
        protocol: protocol as DockerPort['protocol'],
      });
    }
  }
  return ports;
}

/** A label of `docker ps`'s comma-separated `Labels` text. */
function label(labels: string | null, name: string): string | null {
  if (labels === null) return null;
  const escaped = name.replace(/[.]/g, '\\.');
  return new RegExp(`(?:^|,)${escaped}=([^,]*)`).exec(labels)?.[1] || null;
}

/** One line of `docker ps -a --no-trunc --format json`. */
export function parseContainerSummary(item: Json): DockerContainerSummary | null {
  const id = text(item.ID);
  if (id === null || !/^[a-f0-9]{12,64}$/.test(id)) return null;
  const state = containerState(item.State);
  const status = text(item.Status) ?? state;
  const labels = text(item.Labels);
  return {
    id,
    shortId: id.slice(0, 12),
    name: (text(item.Names) ?? id.slice(0, 12)).split(',')[0]!.replace(/^\//, ''),
    image: text(item.Image) ?? '',
    state,
    status,
    health: healthOf(item, status),
    ports: parsePorts(text(item.Ports)),
    createdAt: text(item.CreatedAt) ?? '',
    composeProject: label(labels, 'com.docker.compose.project'),
    composeService: label(labels, 'com.docker.compose.service'),
    actions: containerActions(state),
  };
}

export function parseContainerList(output: string): DockerContainerSummary[] {
  return parseJsonLines(output)
    .map(parseContainerSummary)
    .filter((item): item is DockerContainerSummary => item !== null);
}

const NANOSECONDS = 1_000_000_000;

function inspectPorts(networkSettings: Json, exposed: Json): DockerPort[] {
  const ports: DockerPort[] = [];
  const seen = new Set<string>();
  const published = isObject(networkSettings.Ports) ? networkSettings.Ports : {};
  for (const key of new Set([...Object.keys(published), ...Object.keys(exposed)])) {
    const match = /^(\d+)\/(\w+)$/.exec(key);
    if (match === null || !PROTOCOLS.has(match[2]!)) continue;
    const bindings = Array.isArray(published[key]) ? (published[key] as unknown[]) : [];
    const base = { containerPort: Number(match[1]), protocol: match[2] as DockerPort['protocol'] };
    if (bindings.length === 0) {
      ports.push({ ...base, hostIp: null, hostPort: null });
      continue;
    }
    for (const binding of bindings.filter(isObject)) {
      const hostPort = Number(text(binding.HostPort));
      const unique = `${hostPort}:${key}`;
      if (seen.has(unique)) continue;
      seen.add(unique);
      ports.push({
        ...base,
        hostIp: text(binding.HostIp),
        hostPort: Number.isInteger(hostPort) && hostPort > 0 ? hostPort : null,
      });
    }
  }
  return ports;
}

/** Whether a container user is root: empty (image default), root or uid 0. */
export function isRootUser(user: string): boolean {
  const name = user.split(':')[0]!.trim();
  return name === '' || name === 'root' || name === '0';
}

/**
 * `docker inspect --type container --format json`, mapped to what the UI shows (FR-1306).
 * Environment values never leave this function; commands pass through `redact`.
 */
export function parseContainerDetails(
  output: string,
  redact: (value: string) => string,
): DockerContainerDetails | null {
  const [item] = parseJsonLines(output);
  if (item === undefined) return null;
  const state = isObject(item.State) ? item.State : {};
  const config = isObject(item.Config) ? item.Config : {};
  const host = isObject(item.HostConfig) ? item.HostConfig : {};
  const network = isObject(item.NetworkSettings) ? item.NetworkSettings : {};
  const health = isObject(state.Health) ? state.Health : null;
  const check = isObject(config.Healthcheck) ? config.Healthcheck : null;
  const labels = isObject(config.Labels) ? config.Labels : {};
  const id = text(item.Id);
  if (id === null) return null;
  const containerStatus = containerState(state.Status);
  const status = text(state.Status) ?? containerStatus;
  const healthStatus = text(health?.Status);
  const user = text(config.User) ?? '';
  const restart = isObject(host.RestartPolicy) ? host.RestartPolicy : {};
  const summary: DockerContainerSummary = {
    id,
    shortId: id.slice(0, 12),
    name: (text(item.Name) ?? id.slice(0, 12)).replace(/^\//, ''),
    image: text(config.Image) ?? '',
    state: containerStatus,
    status,
    health:
      healthStatus === 'healthy' || healthStatus === 'unhealthy' || healthStatus === 'starting'
        ? healthStatus
        : 'none',
    ports: inspectPorts(network, isObject(config.ExposedPorts) ? config.ExposedPorts : {}),
    createdAt: text(item.Created) ?? '',
    composeProject: text(labels['com.docker.compose.project']),
    composeService: text(labels['com.docker.compose.service']),
    actions: containerActions(containerStatus),
  };
  const redactAll = (values: string[] | null) =>
    values === null || values.length === 0 ? null : values.map((value) => redact(value));
  const nanoCpus = num(host.NanoCpus);
  const memory = num(host.Memory);
  const pids = num(host.PidsLimit);
  return {
    summary,
    imageId: text(item.Image) ?? '',
    entrypoint: redactAll(strings(config.Entrypoint)),
    command: redactAll(strings(config.Cmd)),
    workingDir: text(config.WorkingDir),
    user,
    runsAsRoot: isRootUser(user),
    privileged: host.Privileged === true,
    networkMode: text(host.NetworkMode) ?? 'default',
    restartPolicy: {
      name: text(restart.Name) ?? 'no',
      maximumRetryCount: num(restart.MaximumRetryCount) ?? 0,
    },
    restartCount: num(item.RestartCount) ?? 0,
    exitCode: containerStatus === 'running' ? null : num(state.ExitCode),
    error: text(state.Error),
    oomKilled: state.OOMKilled === true,
    startedAt: zeroTime(text(state.StartedAt)),
    finishedAt: zeroTime(text(state.FinishedAt)),
    mounts: (Array.isArray(item.Mounts) ? item.Mounts : [])
      .filter(isObject)
      .map((mount): DockerMount => ({
        type: text(mount.Type) ?? 'unknown',
        source: (text(mount.Type) === 'volume' ? text(mount.Name) : text(mount.Source)) ?? '',
        destination: text(mount.Destination) ?? '',
        readOnly: mount.RW === false,
      })),
    networks: Object.entries(isObject(network.Networks) ? network.Networks : {})
      .filter((entry): entry is [string, Json] => isObject(entry[1]))
      .map(([name, value]) => ({
        name,
        ipAddress: text(value.IPAddress),
        gateway: text(value.Gateway),
      })),
    healthcheck:
      check === null || strings(check.Test) === null
        ? null
        : {
            test: strings(check.Test)!.map((value) => redact(value)),
            intervalSeconds:
              num(check.Interval) === null ? null : num(check.Interval)! / NANOSECONDS,
            retries: num(check.Retries),
          },
    healthLog: (Array.isArray(health?.Log) ? (health.Log as unknown[]) : [])
      .filter(isObject)
      .flatMap((entry) => {
        const exitCode = num(entry.ExitCode);
        const at = text(entry.End) ?? text(entry.Start);
        return exitCode === null || at === null ? [] : [{ exitCode, at }];
      })
      .slice(-5),
    limits: {
      memoryBytes: memory !== null && memory > 0 ? memory : null,
      cpus: nanoCpus !== null && nanoCpus > 0 ? nanoCpus / NANOSECONDS : null,
      pidsLimit: pids !== null && pids > 0 ? pids : null,
    },
    envNames: (strings(config.Env) ?? []).map((entry) => entry.split('=', 1)[0]!).filter(Boolean),
  };
}

/** Docker reports "0001-01-01T00:00:00Z" for times that never happened. */
function zeroTime(value: string | null): string | null {
  return value === null || value.startsWith('0001-') ? null : value;
}

const percent = (value: unknown) => {
  const parsed = Number.parseFloat(String(value ?? '').replace('%', ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const reported = (value: unknown) => {
  const result = text(value);
  return result === null || result === '--' ? null : result;
};

/** `docker stats --no-stream --format json <id>` (FR-1309). */
export function parseStats(output: string, at: string): DockerContainerStats | null {
  const [item] = parseJsonLines(output);
  if (item === undefined) return null;
  const [usage, limit] = (reported(item.MemUsage) ?? '').split(/\s*\/\s*/);
  const pids = Number.parseInt(String(item.PIDs ?? ''), 10);
  return {
    cpuPercent: reported(item.CPUPerc) === null ? null : percent(item.CPUPerc),
    memoryUsage: reported(usage),
    memoryLimit: reported(limit),
    memoryPercent: reported(item.MemPerc) === null ? null : percent(item.MemPerc),
    networkIO: reported(item.NetIO),
    blockIO: reported(item.BlockIO),
    pids: Number.isInteger(pids) ? pids : null,
    at,
  };
}

/** A container id of a `docker events --format json` line; null for other events. */
export function parseContainerEvent(line: string): string | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isObject(value) || value.Type !== 'container') return null;
    const actor = isObject(value.Actor) ? value.Actor : {};
    const id = text(actor.ID);
    return id !== null && /^[a-f0-9]{12,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The first line of a Docker error, without the daemon prefix. */
export function dockerErrorMessage(stderr: string): string {
  const line =
    stderr
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item !== '') ?? '';
  return line.replace(/^Error( response from daemon)?:\s*/i, '').slice(0, 300);
}
