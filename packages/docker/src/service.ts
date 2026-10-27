import {
  ContainerLifecycleSchema,
  ContainerRefSchema,
  CreateContainerSchema,
  DockerContextRefSchema,
  DockerLogSessionIdSchema,
  OpenContainerLogsSchema,
  OpenContainerTerminalSchema,
  ReadContainerLogsSchema,
  RenameContainerSchema,
  SelectDockerContextSchema,
  containerCreationRisks,
  parseInput,
  type ContainerAction,
  type DockerContainerDetails,
  type DockerContainerStats,
  type DockerContainerSummary,
  type DockerContextList,
  type DockerContextSummary,
  type DockerStatus,
  type PreflightOutputPage,
} from '@atlas/contracts';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import {
  classifyConnectionError,
  dockerErrorMessage,
  isRootUser,
  parseContainerDetails,
  parseContainerEvent,
  parseContainerList,
  parseContexts,
  parseStats,
  parseVersion,
} from './parse.js';
import type {
  DockerCliResult,
  DockerCliStream,
  DockerLogLines,
  DockerRunner,
  KeyValueStore,
} from './ports.js';

export const DOCKER_CONTEXT_KEY = 'docker.context';
const QUERY_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 10_000;
const CONTEXT_CACHE_MS = 10_000;
const COMPOSE_CACHE_MS = 5 * 60_000;
/** Log sessions kept at once; the oldest is closed first. */
export const MAX_LOG_SESSIONS = 8;
/** A log session nobody read for this long is closed. */
export const LOG_SESSION_IDLE_MS = 60_000;
/** Shells tried in a container, in order (FR-1308): no image is assumed to have Bash. */
export const CONTAINER_SHELLS = ['/bin/bash', '/bin/ash', '/bin/sh', '/busybox/sh'] as const;
const EVENT_FLUSH_MS = 300;
const RECONNECT_DELAYS_MS = [2000, 5000, 10_000, 30_000];

export interface DockerServiceOptions {
  runner: DockerRunner;
  settings: KeyValueStore;
  /** A bounded, redacted line buffer for a followed log. */
  createLogLines: () => DockerLogLines;
  /** Removes credentials from shown text. */
  redact: (text: string) => string;
  /** The user's home folder, for warnings about broad bind mounts. */
  homeDirectory: string | null;
  clock: { now(): Date };
  generateId: () => string;
  logger: Logger;
  /** Containers of `context` may have changed; null `containerId` is a connection change. */
  onChange?: (context: string, containerId: string | null) => void;
}

interface LogSession {
  id: string;
  subscriber: string;
  lines: DockerLogLines;
  stream: DockerCliStream;
  lastRead: number;
}

/** What to type in an ATLAS terminal to open a shell in a container. */
export interface ContainerTerminalCommand {
  command: string;
  title: string;
  shell: string;
  user: string;
}

/**
 * Docker through the Docker CLI (SDD-013 Milestone A). Docker stays the source of truth:
 * nothing about containers is stored. Every request names its context and the CLI gets
 * it with `--context`, so ATLAS never changes Docker's own current context. Mutations
 * are logged without values (audit).
 */
export class DockerService {
  private contextCache: { at: number; contexts: DockerContextSummary[] } | null = null;
  private composeCache: { at: number; version: string | null } | null = null;
  private readonly sessions = new Map<string, LogSession>();
  private readonly watchers = new Set<string>();
  private events: { context: string; stream: DockerCliStream } | null = null;
  private pendingEvents = new Set<string>();
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly options: DockerServiceOptions) {}

  // -------------------------------------------------------------------------
  // Connection and contexts (FR-1301–FR-1303)
  // -------------------------------------------------------------------------

  async status(): Promise<DockerStatus> {
    const checkedAt = this.now();
    const base = {
      clientVersion: null,
      serverVersion: null,
      apiVersion: null,
      platform: null,
      composeVersion: null,
      checkedAt,
    };
    if (!(await this.options.runner.available())) {
      return {
        ...base,
        state: 'CLI_MISSING',
        context: null,
        remote: false,
        message: 'The Docker CLI was not found on the PATH.',
      };
    }
    let list: DockerContextList | null = null;
    try {
      list = await this.contexts(true);
    } catch (error) {
      this.options.logger.debug('Docker contexts could not be listed', {
        error: describeError(error),
      });
    }
    const context = list?.effective ?? null;
    const remote = list?.contexts.find((item) => item.name === context)?.remote ?? false;
    const result = await this.options.runner.run(
      [...this.contextArgs(context), 'version', '--format', 'json'],
      { timeoutMs: STATUS_TIMEOUT_MS },
    );
    const version = parseVersion(result.stdout);
    const versions = {
      clientVersion: version?.clientVersion ?? null,
      serverVersion: version?.serverVersion ?? null,
      apiVersion: version?.apiVersion ?? null,
      platform: version?.platform ?? null,
    };
    if (result.exitCode === 0 && version?.serverVersion) {
      return {
        ...base,
        ...versions,
        composeVersion: await this.composeVersion(context),
        state: 'CONNECTED',
        context,
        remote,
        message: `Connected to Docker ${version.serverVersion}.`,
      };
    }
    const state = result.timedOut ? 'CONNECTION_ERROR' : classifyConnectionError(result.stderr);
    return {
      ...base,
      ...versions,
      state,
      context,
      remote,
      message: {
        CONNECTED: '',
        CLI_MISSING: '',
        ENGINE_UNAVAILABLE: 'The Docker engine is not running or cannot be reached.',
        PERMISSION_DENIED: 'Permission to use the Docker engine was denied.',
        CONNECTION_ERROR: result.timedOut
          ? 'Docker did not answer in time.'
          : this.options.redact(dockerErrorMessage(result.stderr)) ||
            'Docker could not be reached.',
      }[state],
    };
  }

  async contexts(refresh = false): Promise<DockerContextList> {
    const contexts = await this.listContexts(refresh);
    const selected = await this.selectedContext();
    const chosen = selected !== null && contexts.some((item) => item.name === selected);
    return {
      contexts,
      selected: chosen ? selected : null,
      effective: chosen
        ? selected
        : (contexts.find((item) => item.dockerCurrent)?.name ?? contexts[0]?.name ?? null),
    };
  }

  /** ATLAS's own choice (FR-1302); Docker's current context is not changed. */
  async selectContext(input: unknown): Promise<DockerContextList> {
    const { name } = parseInput(SelectDockerContextSchema, input);
    if (name !== null) await this.requireContext(name, true);
    await this.options.settings.set(DOCKER_CONTEXT_KEY, JSON.stringify(name));
    this.options.logger.info('Docker context selected in ATLAS', { context: name ?? 'default' });
    const list = await this.contexts();
    // Events follow the context in use.
    if (this.watchers.size > 0) this.restartEvents();
    return list;
  }

  // -------------------------------------------------------------------------
  // Containers (FR-1304–FR-1306)
  // -------------------------------------------------------------------------

  async containers(input: unknown): Promise<DockerContainerSummary[]> {
    const { context } = parseInput(DockerContextRefSchema, input);
    await this.requireContext(context);
    const result = await this.docker(context, ['ps', '-a', '--no-trunc', '--format', 'json']);
    return parseContainerList(result.stdout).sort((a, b) => a.name.localeCompare(b.name));
  }

  async container(input: unknown): Promise<DockerContainerDetails> {
    const ref = parseInput(ContainerRefSchema, input);
    await this.requireContext(ref.context);
    return this.inspect(ref.context, ref.containerId);
  }

  async lifecycle(input: unknown): Promise<DockerContainerSummary> {
    const { context, containerId, action } = parseInput(ContainerLifecycleSchema, input);
    await this.requireContext(context);
    const current = await this.inspect(context, containerId);
    this.requireAction(current.summary.actions, action);
    await this.mutate(context, containerId, action, [action, current.summary.id]);
    return (await this.inspect(context, current.summary.id)).summary;
  }

  async rename(input: unknown): Promise<DockerContainerSummary> {
    const { context, containerId, name } = parseInput(RenameContainerSchema, input);
    await this.requireContext(context);
    const current = await this.inspect(context, containerId);
    this.requireAction(current.summary.actions, 'rename');
    await this.mutate(context, containerId, 'rename', ['rename', current.summary.id, name]);
    return (await this.inspect(context, current.summary.id)).summary;
  }

  /** Removes a stopped container; its volumes are never removed (FR-1305). */
  async remove(input: unknown): Promise<void> {
    const { context, containerId } = parseInput(ContainerRefSchema, input);
    await this.requireContext(context);
    const current = await this.inspect(context, containerId);
    this.requireAction(current.summary.actions, 'remove');
    await this.mutate(context, containerId, 'remove', ['rm', current.summary.id]);
  }

  /**
   * Creates (and by default starts) a container from a local image (FR-1310). Risky
   * options need `confirmRisks`; privileged mode is not offered. Environment values go
   * through a private `--env-file`, never the command line or the CLI's own environment.
   */
  async create(input: unknown): Promise<DockerContainerSummary> {
    const request = parseInput(CreateContainerSchema, input);
    await this.requireContext(request.context);
    const risks = containerCreationRisks(request, this.options.homeDirectory);
    if (risks.length > 0 && !request.confirmRisks) {
      throw new AtlasError('DOCKER_CONFIRMATION_REQUIRED', undefined, {
        issues: risks.map((message) => ({ field: 'confirmRisks', message })),
      });
    }
    const names = new Set<string>();
    for (const variable of request.env) {
      if (names.has(variable.name)) {
        throw new AtlasError('VALIDATION_FAILED', undefined, {
          issues: [{ field: 'env', message: `${variable.name} is set twice.` }],
        });
      }
      names.add(variable.name);
    }
    const args = ['create', '--pull', 'never'];
    if (request.name) args.push('--name', request.name);
    if (request.entrypoint) args.push('--entrypoint', request.entrypoint);
    for (const port of request.ports) {
      const host = port.hostPort === null ? '' : String(port.hostPort);
      args.push('--publish', `${port.hostIp}:${host}:${port.containerPort}/${port.protocol}`);
    }
    for (const bind of request.binds) {
      args.push(
        '--mount',
        `type=bind,source=${bind.source},target=${bind.target}${bind.readOnly ? ',readonly' : ''}`,
      );
    }
    for (const volume of request.volumes) {
      args.push(
        '--mount',
        `type=volume,source=${volume.name},target=${volume.target}${volume.readOnly ? ',readonly' : ''}`,
      );
    }
    if (request.network) args.push('--network', request.network);
    args.push('--restart', request.restartPolicy);
    const run = (envFile: string | null) =>
      this.docker(
        request.context,
        [
          ...args,
          ...(envFile === null ? [] : ['--env-file', envFile]),
          // Ends option parsing: the image and its arguments are never read as options.
          '--',
          request.image,
          ...request.command,
        ],
        { timeoutMs: ACTION_TIMEOUT_MS },
      );
    const created =
      request.env.length === 0
        ? await run(null)
        : await this.options.runner.withPrivateFile(
            request.env.map((variable) => `${variable.name}=${variable.value}\n`).join(''),
            run,
          );
    const id = created.stdout.trim().split(/\r?\n/).at(-1) ?? '';
    if (!/^[a-f0-9]{12,64}$/.test(id)) {
      throw new AtlasError('DOCKER_COMMAND_FAILED', 'Docker did not report the new container.');
    }
    this.audit('create', request.context, id, 'succeeded');
    if (request.start) await this.mutate(request.context, id, 'start', ['start', id]);
    return (await this.inspect(request.context, id)).summary;
  }

  /** Docker-reported usage of a running container (FR-1309). */
  async stats(input: unknown): Promise<DockerContainerStats> {
    const { context, containerId } = parseInput(ContainerRefSchema, input);
    await this.requireContext(context);
    const result = await this.docker(context, [
      'stats',
      '--no-stream',
      '--format',
      'json',
      containerId,
    ]);
    const stats = parseStats(result.stdout, this.now());
    if (stats === null) throw new AtlasError('DOCKER_COMMAND_FAILED', 'Docker reported no usage.');
    return stats;
  }

  // -------------------------------------------------------------------------
  // Logs (FR-1307)
  // -------------------------------------------------------------------------

  async openLogs(subscriber: string, input: unknown): Promise<string> {
    const { context, containerId, tail } = parseInput(OpenContainerLogsSchema, input);
    await this.requireContext(context);
    const details = await this.inspect(context, containerId);
    while (this.sessions.size >= MAX_LOG_SESSIONS) {
      this.closeSession(this.sessions.keys().next().value!);
    }
    const id = this.options.generateId();
    const lines = this.options.createLogLines();
    const stream = this.options.runner.stream(
      [
        '--context',
        context,
        'logs',
        '--follow',
        '--timestamps',
        '--tail',
        String(tail),
        details.summary.id,
      ],
      (source, chunk) => lines.append(source, chunk),
    );
    void stream.done.then((code) => {
      if (!lines.complete) {
        lines.note(
          code === 0 ? 'The log stream ended.' : 'The log stream stopped; reopen the logs.',
        );
        lines.finish();
      }
    });
    this.sessions.set(id, { id, subscriber, lines, stream, lastRead: Date.now() });
    this.idleTimer ??= setInterval(() => this.closeIdleSessions(), LOG_SESSION_IDLE_MS / 2);
    this.idleTimer.unref?.();
    return id;
  }

  readLogs(input: unknown): PreflightOutputPage {
    const query = parseInput(ReadContainerLogsSchema, input);
    const session = this.sessions.get(query.sessionId);
    if (session === undefined) {
      return { lines: [], next: query.after, complete: true, truncatedBefore: false };
    }
    session.lastRead = Date.now();
    const { lines } = session;
    const page = lines.read(query.after, query.limit ?? 1000);
    const next = page.at(-1)?.seq ?? Math.max(query.after, lines.firstSeq - 1);
    return {
      lines: page,
      next,
      complete: lines.complete && next >= lines.count - 1,
      truncatedBefore: query.after + 1 < lines.firstSeq,
    };
  }

  closeLogs(sessionId: unknown): void {
    this.closeSession(parseInput(DockerLogSessionIdSchema, sessionId));
  }

  // -------------------------------------------------------------------------
  // Live updates (FR-1312)
  // -------------------------------------------------------------------------

  /** Container events for a window; the stream runs only while someone watches. */
  watch(subscriber: string, enabled: boolean): void {
    if (enabled) this.watchers.add(subscriber);
    else this.watchers.delete(subscriber);
    if (this.watchers.size === 0) this.stopEvents();
    else if (this.events === null && this.reconnectTimer === null) void this.startEvents();
  }

  /** Stops what a window that went away was using. */
  detach(subscriber: string): void {
    this.watch(subscriber, false);
    for (const session of [...this.sessions.values()]) {
      if (session.subscriber === subscriber) this.closeSession(session.id);
    }
  }

  // -------------------------------------------------------------------------
  // Terminals (FR-1308)
  // -------------------------------------------------------------------------

  /**
   * What to type in an ATLAS terminal to open a shell in a running container: the first
   * shell that exists, as the container's user (or `user`). Root needs `confirmRoot`.
   */
  async terminalCommand(input: unknown): Promise<ContainerTerminalCommand> {
    const request = parseInput(OpenContainerTerminalSchema, input);
    await this.requireContext(request.context);
    const details = await this.inspect(request.context, request.containerId);
    this.requireAction(details.summary.actions, 'terminal');
    const user = request.user ?? details.user;
    if (isRootUser(user) && !request.confirmRoot) {
      throw new AtlasError('DOCKER_CONFIRMATION_REQUIRED', undefined, {
        issues: [
          {
            field: 'confirmRoot',
            message: 'The shell would run as root inside the container.',
          },
        ],
      });
    }
    const userArgs = request.user === null ? [] : ['--user', request.user];
    let shell: string | null = null;
    for (const candidate of CONTAINER_SHELLS) {
      const probe = await this.options.runner.run(
        [
          '--context',
          request.context,
          'exec',
          ...userArgs,
          details.summary.id,
          candidate,
          '-c',
          'exit 0',
        ],
        { timeoutMs: QUERY_TIMEOUT_MS },
      );
      if (probe.exitCode === 0) {
        shell = candidate;
        break;
      }
    }
    if (shell === null) throw new AtlasError('DOCKER_SHELL_UNAVAILABLE');
    this.audit('terminal', request.context, details.summary.id, 'opened');
    // Context, id, user and shell are validated tokens: nothing here needs quoting.
    return {
      command: [
        'docker',
        '--context',
        request.context,
        'exec',
        '-it',
        ...userArgs,
        details.summary.id,
        shell,
      ].join(' '),
      title: `${details.summary.name} (container)`,
      shell,
      user: user === '' ? 'root (image default)' : user,
    };
  }

  /** Stops every stream. */
  close(): void {
    this.closed = true;
    this.stopEvents();
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private contextArgs(context: string | null): string[] {
    return context === null ? [] : ['--context', context];
  }

  private async listContexts(refresh: boolean): Promise<DockerContextSummary[]> {
    if (!refresh && this.contextCache && Date.now() - this.contextCache.at < CONTEXT_CACHE_MS) {
      return this.contextCache.contexts;
    }
    if (!(await this.options.runner.available())) {
      throw new AtlasError('DOCKER_UNAVAILABLE', 'The Docker CLI was not found.');
    }
    const result = await this.options.runner.run(['context', 'ls', '--format', 'json'], {
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new AtlasError('DOCKER_UNAVAILABLE', 'Docker contexts could not be listed.', {
        details: { stderr: dockerErrorMessage(result.stderr) },
      });
    }
    const contexts = parseContexts(result.stdout);
    this.contextCache = { at: Date.now(), contexts };
    return contexts;
  }

  private async selectedContext(): Promise<string | null> {
    const raw = await this.options.settings.get(DOCKER_CONTEXT_KEY);
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw) as unknown;
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  /** The context must exist; Docker may have removed it since the client listed it. */
  private async requireContext(context: string, refresh = false): Promise<void> {
    let contexts = await this.listContexts(refresh);
    if (!contexts.some((item) => item.name === context) && !refresh) {
      contexts = await this.listContexts(true);
    }
    if (!contexts.some((item) => item.name === context)) {
      throw new AtlasError('DOCKER_CONTEXT_NOT_FOUND');
    }
  }

  private async composeVersion(context: string | null): Promise<string | null> {
    if (this.composeCache && Date.now() - this.composeCache.at < COMPOSE_CACHE_MS) {
      return this.composeCache.version;
    }
    const result = await this.options.runner.run(
      [...this.contextArgs(context), 'compose', 'version', '--short'],
      { timeoutMs: STATUS_TIMEOUT_MS },
    );
    const version =
      result.exitCode === 0 ? (result.stdout.trim().split(/\s+/)[0] ?? null) || null : null;
    this.composeCache = { at: Date.now(), version };
    return version;
  }

  /** Runs a command in a context; failures become user-safe errors. */
  private async docker(
    context: string,
    args: string[],
    options: { timeoutMs?: number } = {},
  ): Promise<DockerCliResult> {
    const result = await this.options.runner.run(['--context', context, ...args], {
      timeoutMs: options.timeoutMs ?? QUERY_TIMEOUT_MS,
    });
    if (result.exitCode === 0) return result;
    if (result.timedOut) {
      throw new AtlasError('DOCKER_COMMAND_FAILED', 'Docker did not answer in time.', {
        issues: [{ field: '_', message: 'Docker did not answer in time.' }],
      });
    }
    const message = this.options.redact(dockerErrorMessage(result.stderr));
    if (/no such container/i.test(message)) throw new AtlasError('DOCKER_CONTAINER_NOT_FOUND');
    if (classifyConnectionError(result.stderr) !== 'CONNECTION_ERROR') {
      this.onConnectionLost(context);
      throw new AtlasError('DOCKER_UNAVAILABLE');
    }
    throw new AtlasError('DOCKER_COMMAND_FAILED', 'Docker refused the operation.', {
      issues: [{ field: '_', message: message || 'Docker could not complete the operation.' }],
    });
  }

  private async inspect(context: string, containerId: string): Promise<DockerContainerDetails> {
    const result = await this.docker(context, [
      'inspect',
      '--type',
      'container',
      '--format',
      'json',
      containerId,
    ]);
    const details = parseContainerDetails(result.stdout, this.options.redact);
    if (details === null) throw new AtlasError('DOCKER_CONTAINER_NOT_FOUND');
    return details;
  }

  private requireAction(actions: readonly ContainerAction[], action: ContainerAction): void {
    if (!actions.includes(action)) throw new AtlasError('DOCKER_ACTION_INVALID');
  }

  private async mutate(
    context: string,
    containerId: string,
    action: string,
    args: string[],
  ): Promise<void> {
    try {
      await this.docker(context, args, { timeoutMs: ACTION_TIMEOUT_MS });
      this.audit(action, context, containerId, 'succeeded');
    } catch (error) {
      this.audit(action, context, containerId, 'failed');
      throw error;
    }
  }

  /** Audit record of a mutation: what, where and how it ended; never values. */
  private audit(action: string, context: string, containerId: string, outcome: string): void {
    this.options.logger.info('Docker container action', {
      action,
      context,
      containerId: containerId.slice(0, 12),
      outcome,
    });
  }

  private closeSession(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    this.sessions.delete(id);
    session.stream.stop();
  }

  private closeIdleSessions(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastRead > LOG_SESSION_IDLE_MS) this.closeSession(session.id);
    }
    if (this.sessions.size === 0 && this.idleTimer !== null) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async startEvents(): Promise<void> {
    if (this.closed || this.watchers.size === 0 || this.events !== null) return;
    let context: string | null;
    try {
      context = (await this.contexts()).effective;
    } catch {
      context = null;
    }
    if (context === null || this.watchers.size === 0 || this.events !== null) {
      this.scheduleReconnect();
      return;
    }
    let buffered = '';
    const stream = this.options.runner.stream(
      ['--context', context, 'events', '--format', 'json', '--filter', 'type=container'],
      (source, chunk) => {
        if (source !== 'out') return;
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          const id = parseContainerEvent(line);
          if (id !== null) this.queueEvent(context, id);
        }
      },
    );
    const current = { context, stream };
    this.events = current;
    this.reconnectAttempt = 0;
    void stream.done.then(() => {
      if (this.events !== current) return;
      this.events = null;
      // The stream ended on its own: Docker stopped or the connection was lost.
      this.notify(context, null);
      this.scheduleReconnect();
    });
  }

  private restartEvents(): void {
    this.stopEvents();
    void this.startEvents();
  }

  private stopEvents(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const current = this.events;
    this.events = null;
    current?.stream.stop();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.watchers.size === 0 || this.reconnectTimer !== null) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startEvents();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private onConnectionLost(context: string): void {
    if (this.events?.context === context) this.notify(context, null);
  }

  /** Events are coalesced: a burst (e.g. stop = kill, die, stop) becomes one change. */
  private queueEvent(context: string, containerId: string): void {
    this.pendingEvents.add(`${context}\n${containerId}`);
    this.eventTimer ??= setTimeout(() => {
      this.eventTimer = null;
      const pending = this.pendingEvents;
      this.pendingEvents = new Set();
      for (const entry of pending) {
        const [eventContext, id] = entry.split('\n');
        this.notify(eventContext!, id!);
      }
    }, EVENT_FLUSH_MS);
  }

  private notify(context: string, containerId: string | null): void {
    try {
      this.options.onChange?.(context, containerId);
    } catch (error) {
      this.options.logger.warn('Docker change listener failed', { error: describeError(error) });
    }
  }

  private now(): string {
    return this.options.clock.now().toISOString();
  }
}
