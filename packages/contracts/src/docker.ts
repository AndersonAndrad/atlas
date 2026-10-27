import { z } from 'zod';

// ---------------------------------------------------------------------------
// Docker & Container Manager (SDD-013 Milestone A, PLAN-041)
// ---------------------------------------------------------------------------

/** What ATLAS could establish about Docker (FR-1301). */
export const DOCKER_CONNECTION_STATES = [
  'CONNECTED',
  'CLI_MISSING',
  'ENGINE_UNAVAILABLE',
  'PERMISSION_DENIED',
  'CONNECTION_ERROR',
] as const;
export type DockerConnectionState = (typeof DOCKER_CONNECTION_STATES)[number];

export type DockerEndpointType = 'unix' | 'npipe' | 'tcp' | 'ssh' | 'other';

/** A Docker context without credentials or TLS material (FR-1302). */
export interface DockerContextSummary {
  name: string;
  description: string;
  endpointType: DockerEndpointType;
  /** Not on this computer: ssh, or tcp to another host. */
  remote: boolean;
  /** Host of a tcp or ssh endpoint, without user or port; null for local sockets. */
  host: string | null;
  /** Docker's own current context (outside ATLAS). */
  dockerCurrent: boolean;
  /** Docker could not read the context. */
  error: string | null;
}

export interface DockerContextList {
  contexts: DockerContextSummary[];
  /** The context chosen in ATLAS; null follows Docker's current context. */
  selected: string | null;
  /** The context ATLAS uses now. */
  effective: string | null;
}

export interface DockerStatus {
  state: DockerConnectionState;
  /** The context checked. */
  context: string | null;
  remote: boolean;
  clientVersion: string | null;
  serverVersion: string | null;
  apiVersion: string | null;
  /** E.g. "Docker Desktop 4.81.0". */
  platform: string | null;
  composeVersion: string | null;
  /** Short and safe to show. */
  message: string;
  checkedAt: string;
}

export const CONTAINER_STATES = [
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
] as const;
export type ContainerState = (typeof CONTAINER_STATES)[number];

export type ContainerHealth = 'healthy' | 'unhealthy' | 'starting' | 'none';

/** Lifecycle actions; which ones apply depends on the state (FR-1305). */
export const CONTAINER_LIFECYCLE_ACTIONS = [
  'start',
  'stop',
  'restart',
  'pause',
  'unpause',
] as const;
export type ContainerLifecycleAction = (typeof CONTAINER_LIFECYCLE_ACTIONS)[number];
export type ContainerAction = ContainerLifecycleAction | 'rename' | 'remove' | 'terminal';

export interface DockerPort {
  /** Null when the port is only exposed, not published. */
  hostIp: string | null;
  hostPort: number | null;
  containerPort: number;
  protocol: 'tcp' | 'udp' | 'sctp';
}

export interface DockerContainerSummary {
  id: string;
  shortId: string;
  name: string;
  image: string;
  state: ContainerState;
  /** Docker's own words, e.g. "Up 4 weeks (healthy)". */
  status: string;
  health: ContainerHealth;
  ports: DockerPort[];
  createdAt: string;
  /** From Compose labels, when present. */
  composeProject: string | null;
  composeService: string | null;
  /** Actions valid in the current state. */
  actions: ContainerAction[];
}

export interface DockerMount {
  type: string;
  /** Host path of a bind mount, or the volume name. */
  source: string;
  destination: string;
  readOnly: boolean;
}

export interface DockerContainerDetails {
  summary: DockerContainerSummary;
  imageId: string;
  /** Redacted; null when the image default is used. */
  entrypoint: string[] | null;
  command: string[] | null;
  workingDir: string | null;
  /** "" means the image default, usually root. */
  user: string;
  runsAsRoot: boolean;
  privileged: boolean;
  networkMode: string;
  restartPolicy: { name: string; maximumRetryCount: number };
  restartCount: number;
  exitCode: number | null;
  error: string | null;
  oomKilled: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  mounts: DockerMount[];
  networks: { name: string; ipAddress: string | null; gateway: string | null }[];
  healthcheck: { test: string[]; intervalSeconds: number | null; retries: number | null } | null;
  /** Health check runs reported by Docker: exit codes and times only. */
  healthLog: { exitCode: number; at: string }[];
  limits: {
    memoryBytes: number | null;
    cpus: number | null;
    pidsLimit: number | null;
  };
  /** Names only; values never leave the Engine (FR-1306). */
  envNames: string[];
}

/** Docker-reported usage; null when Docker did not report it (FR-1309). */
export interface DockerContainerStats {
  cpuPercent: number | null;
  memoryUsage: string | null;
  memoryLimit: string | null;
  memoryPercent: number | null;
  networkIO: string | null;
  blockIO: string | null;
  pids: number | null;
  at: string;
}

export const DockerContextNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,127}$/, 'Invalid Docker context name.');
export const ContainerIdSchema = z
  .string()
  .regex(/^[a-f0-9]{12,64}$/, 'Invalid container identifier.');
export const ContainerNameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/,
    'Use letters, digits, ".", "_" or "-", starting with a letter or digit.',
  );
/** A container user: name, uid, or user:group. */
export const ContainerUserSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}(:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63})?$/, 'Invalid user.');

/** Every request names the context it was made for, so it never reaches another engine. */
const ContainerRef = {
  context: DockerContextNameSchema,
  containerId: ContainerIdSchema,
};

export const SelectDockerContextSchema = z.strictObject({
  /** Null follows Docker's current context again. */
  name: DockerContextNameSchema.nullable(),
});
export type SelectDockerContextInput = z.input<typeof SelectDockerContextSchema>;

export const DockerContextRefSchema = z.strictObject({ context: DockerContextNameSchema });
export type DockerContextRef = z.input<typeof DockerContextRefSchema>;

export const ContainerRefSchema = z.strictObject(ContainerRef);
export type ContainerRef = z.input<typeof ContainerRefSchema>;

export const ContainerLifecycleSchema = z.strictObject({
  ...ContainerRef,
  action: z.enum(CONTAINER_LIFECYCLE_ACTIONS),
});
export type ContainerLifecycleInput = z.input<typeof ContainerLifecycleSchema>;

export const RenameContainerSchema = z.strictObject({ ...ContainerRef, name: ContainerNameSchema });
export type RenameContainerInput = z.input<typeof RenameContainerSchema>;

export const DOCKER_LOG_TAIL_MAX = 5000;
export const OpenContainerLogsSchema = z.strictObject({
  ...ContainerRef,
  /** Recent lines before following (FR-1307). */
  tail: z.number().int().min(0).max(DOCKER_LOG_TAIL_MAX).default(500),
});
export type OpenContainerLogsInput = z.input<typeof OpenContainerLogsSchema>;

export const DockerLogSessionIdSchema = z.uuid({ message: 'Invalid log session.' });
export const ReadContainerLogsSchema = z.strictObject({
  sessionId: DockerLogSessionIdSchema,
  after: z.number().int().min(-1),
  limit: z.number().int().min(1).max(5000).optional(),
});
export type ReadContainerLogsInput = z.input<typeof ReadContainerLogsSchema>;

export const OpenContainerTerminalSchema = z.strictObject({
  ...ContainerRef,
  /** Null uses the container's user. */
  user: ContainerUserSchema.nullable().default(null),
  /** Required when the shell would run as root (FR-1308). */
  confirmRoot: z.boolean().default(false),
});
export type OpenContainerTerminalInput = z.input<typeof OpenContainerTerminalSchema>;

// Container creation (FR-1310) ------------------------------------------------

export const RESTART_POLICIES = ['no', 'on-failure', 'always', 'unless-stopped'] as const;
const PathText = z
  .string()
  .trim()
  .min(1, 'Enter a path.')
  .max(1024)
  .refine((value) => !/[,"\n\r\0]/.test(value), 'Paths cannot contain commas or quotes.');
const ContainerPath = PathText.refine(
  (value) => value.startsWith('/'),
  'Use an absolute path inside the container.',
);
const Port = z.number().int().min(1).max(65535);

export const ImageReferenceSchema = z
  .string()
  .trim()
  .min(1, 'Enter an image.')
  .max(255)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/, 'Invalid image reference.');

export const CreateContainerSchema = z.strictObject({
  context: DockerContextNameSchema,
  image: ImageReferenceSchema,
  name: ContainerNameSchema.optional(),
  /** Overrides the image entrypoint (one executable). */
  entrypoint: z.string().trim().min(1).max(1000).optional(),
  /** Arguments after the image, already split. */
  command: z.array(z.string().max(1000)).max(50).default([]),
  ports: z
    .array(
      z.strictObject({
        /** 127.0.0.1 keeps the port on this computer; 0.0.0.0 opens it to the network. */
        hostIp: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
        /** Null lets Docker choose. */
        hostPort: Port.nullable().default(null),
        containerPort: Port,
        protocol: z.enum(['tcp', 'udp']).default('tcp'),
      }),
    )
    .max(50)
    .default([]),
  env: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Invalid variable name.'),
        /** One line: Docker's env files cannot hold line breaks. */
        value: z
          .string()
          .max(10_000)
          .refine((value) => !/[\r\n\0]/.test(value), 'Values cannot contain line breaks.'),
      }),
    )
    .max(100)
    .default([]),
  binds: z
    .array(
      z.strictObject({
        source: PathText.refine(
          (value) => value.startsWith('/') || /^[A-Za-z]:\\/.test(value),
          'Use an absolute path on this computer.',
        ),
        target: ContainerPath,
        readOnly: z.boolean().default(false),
      }),
    )
    .max(20)
    .default([]),
  volumes: z
    .array(
      z.strictObject({
        name: z
          .string()
          .trim()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/, 'Invalid volume name.'),
        target: ContainerPath,
        readOnly: z.boolean().default(false),
      }),
    )
    .max(20)
    .default([]),
  /** A network name, or bridge (default), host or none. */
  network: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/, 'Invalid network name.')
    .optional(),
  restartPolicy: z.enum(RESTART_POLICIES).default('no'),
  /** Starts the container after creating it. */
  start: z.boolean().default(true),
  /** Required when ATLAS warns about the configuration. */
  confirmRisks: z.boolean().default(false),
});
export type CreateContainerInput = z.input<typeof CreateContainerSchema>;
export type CreateContainerRequest = z.output<typeof CreateContainerSchema>;

/** Folders whose contents (at any depth) belong to the system. */
const SYSTEM_PATHS = [
  '/etc',
  '/var',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/root',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/private/etc',
  '/private/var',
  '/System',
  '/Library',
];
/** Folders holding every user's files; mounting them whole is broad access. */
const USER_ROOTS = ['/', '/Users', '/home', '/private'];
/** Credential folders in the home folder (keys, cloud and cluster logins, Docker). */
const CREDENTIAL_FOLDERS = ['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.config'];

const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * Why a container configuration needs an explicit confirmation (FR-1310). Shared by the
 * form and the Engine, which decides.
 */
export function containerCreationRisks(
  input: Pick<CreateContainerRequest, 'binds' | 'network' | 'ports'>,
  homeDirectory: string | null,
): string[] {
  const risks = new Set<string>();
  if (input.network === 'host') {
    risks.add('uses the host network: every port of the container is open on this computer');
  }
  const home = homeDirectory?.replace(/\/+$/, '') || null;
  for (const bind of input.binds) {
    const source = bind.source.replace(/\/+$/, '') || '/';
    if (/docker\.sock$|docker_engine$/i.test(source)) {
      risks.add('mounts the Docker socket: the container can control Docker and this computer');
    } else if (
      USER_ROOTS.includes(source) ||
      source === home ||
      SYSTEM_PATHS.some((folder) => inside(source, folder))
    ) {
      risks.add(`mounts ${source}, giving it broad access to this computer's files`);
    } else if (
      home !== null &&
      CREDENTIAL_FOLDERS.some((folder) => inside(source, `${home}/${folder}`))
    ) {
      risks.add(`mounts ${source}, which may hold credentials`);
    }
  }
  if (input.ports.some((port) => port.hostIp === '0.0.0.0')) {
    risks.add('publishes ports to the network, not only to this computer');
  }
  return [...risks];
}

/** Splits a command line into arguments: spaces separate, quotes group. No expansion. */
export function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of line) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}
