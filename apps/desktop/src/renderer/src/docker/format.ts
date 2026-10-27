import type {
  ContainerHealth,
  ContainerState,
  DockerConnectionState,
  DockerPort,
} from '@atlas/contracts';

export const CONTAINER_STATE_LABELS: Record<ContainerState, string> = {
  created: 'Created',
  running: 'Running',
  paused: 'Paused',
  restarting: 'Restarting',
  removing: 'Removing',
  exited: 'Stopped',
  dead: 'Dead',
};

const STATE_CLASSES: Record<ContainerState, string> = {
  created: 'text-muted-foreground',
  running: 'text-success',
  paused: 'text-warning',
  restarting: 'text-warning',
  removing: 'text-muted-foreground',
  exited: 'text-muted-foreground',
  dead: 'text-destructive',
};

export function containerStateClass(state: ContainerState): string {
  return STATE_CLASSES[state];
}

export const HEALTH_LABELS: Record<ContainerHealth, string | null> = {
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  starting: 'Starting',
  none: null,
};

export const CONNECTION_LABELS: Record<DockerConnectionState, string> = {
  CONNECTED: 'Docker connected',
  CLI_MISSING: 'Docker not installed',
  ENGINE_UNAVAILABLE: 'Docker not running',
  PERMISSION_DENIED: 'Docker access denied',
  CONNECTION_ERROR: 'Docker unreachable',
};

/** Hints shown while Docker cannot be used; ATLAS never installs or starts Docker. */
export const CONNECTION_HINTS: Record<DockerConnectionState, string> = {
  CONNECTED: '',
  CLI_MISSING:
    'Install Docker Desktop or Docker Engine, then check again. ATLAS works normally without it.',
  ENGINE_UNAVAILABLE:
    'Start Docker Desktop (or the Docker service). ATLAS reconnects by itself once it answers.',
  PERMISSION_DENIED:
    'Your user cannot use the Docker engine. On Linux, add it to the docker group and sign in again.',
  CONNECTION_ERROR:
    'Check the selected context and its network connection, or choose another context.',
};

/** "127.0.0.1:6380→6379/tcp", or "6379/tcp" for an exposed-only port. */
export function formatPort(port: DockerPort): string {
  const target = `${port.containerPort}/${port.protocol}`;
  if (port.hostPort === null) return target;
  const host =
    port.hostIp && port.hostIp !== '0.0.0.0' && port.hostIp !== '::' ? `${port.hostIp}:` : '';
  return `${host}${port.hostPort}→${target}`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'No limit';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}
