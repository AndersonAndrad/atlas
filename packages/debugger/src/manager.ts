import path from 'node:path';
import {
  DebugAdapterIdSchema,
  DebugConfigurationSchema,
  DebugSessionIdSchema,
  parseInput,
  type DebugAdapter,
  type DebugConfiguration,
  type DebugEvent,
  type DebugFailure,
  type DebugSession,
  type DebugSessionStatus,
} from '@atlas/contracts';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { DapConnection } from './connection.js';
import type { AdapterLauncher, AdapterProcess, DebugFileSystem } from './ports.js';
import { canTransition, isFinal } from './state.js';

export interface DebugTimeouts {
  initialize: number;
  /** From `launch`/`attach` to the adapter's `initialized` event and launch response. */
  launch: number;
  configurationDone: number;
  /** How long `disconnect` may take before the adapter process tree is stopped. */
  disconnect: number;
}

export const DEFAULT_DEBUG_TIMEOUTS: DebugTimeouts = {
  initialize: 10_000,
  launch: 30_000,
  configurationDone: 10_000,
  disconnect: 3_000,
};

/** Ended sessions kept per owner so their final status can still be read. */
const ENDED_KEPT = 20;
const OUTPUT_MAX = 8 * 1024;
const EVENT_BODY_MAX = 64 * 1024;
const STDERR_TAIL = 2 * 1024;

export interface DebugSessionManagerOptions {
  launcher: AdapterLauncher;
  fileSystem: DebugFileSystem;
  /** Folder of a registered project, or null. */
  projectPath: (projectId: string) => Promise<string | null>;
  timeouts?: Partial<DebugTimeouts>;
  clock: { now(): Date };
  generateId: () => string;
  logger: Logger;
}

type Listener = (ownerId: string, event: DebugEvent) => void;

interface Live {
  session: DebugSession;
  ownerId: string;
  configuration: DebugConfiguration;
  process: AdapterProcess | null;
  connection: DapConnection | null;
  stderr: string;
  stopping: Promise<void> | null;
  /**
   * Settles on the adapter's `initialized` event. Created before `initialize` is sent:
   * adapters often write that event in the same chunk as the `initialize` response.
   */
  initialized: Promise<void>;
  markInitialized: () => void;
}

/** Trimmed, single-line text without control characters. */
function clean(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').slice(0, max);
}

/** Read through a call: the status changes while the handshake awaits. */
const statusOf = (live: Live): DebugSessionStatus => live.session.status;

function failureOf(error: unknown, adapterMessage: string | null = null): DebugFailure {
  const atlas =
    error instanceof AtlasError ? error : new AtlasError('DEBUG_ADAPTER_FAILED', 'Unexpected.');
  return { code: atlas.code, message: atlas.userMessage, adapterMessage };
}

/**
 * Engine-side owner of Debug Adapter Protocol sessions (SDD-016 Task 01). Each session
 * belongs to the client that created it; only that owner can start, stop or read it, and
 * when the owner goes away its sessions stop. Adapters come only from the Engine's own
 * registry and start without a shell, in a folder inside the session's project, and only
 * when `start` is called. One session is active at a time.
 */
export class DebugSessionManager {
  private readonly adaptersById = new Map<string, DebugAdapter>();
  private readonly entries = new Map<string, Live>();
  private readonly listeners = new Set<Listener>();
  private readonly timeouts: DebugTimeouts;

  constructor(private readonly options: DebugSessionManagerOptions) {
    this.timeouts = { ...DEFAULT_DEBUG_TIMEOUTS, ...options.timeouts };
  }

  private now(): string {
    return this.options.clock.now().toISOString();
  }

  // --- Adapters --------------------------------------------------------------

  /** Registers an adapter the Engine knows how to start. Its executable is checked at start. */
  registerAdapter(adapter: DebugAdapter): void {
    parseInput(DebugAdapterIdSchema, adapter.id);
    if (!path.isAbsolute(adapter.command)) throw new AtlasError('DEBUG_ADAPTER_INVALID');
    this.adaptersById.set(adapter.id, {
      ...adapter,
      args: [...adapter.args],
      languages: [...adapter.languages],
    });
  }

  adapters(): DebugAdapter[] {
    return [...this.adaptersById.values()].map((adapter) => ({
      ...adapter,
      args: [...adapter.args],
      languages: [...adapter.languages],
    }));
  }

  // --- Events ----------------------------------------------------------------

  /** Session events with their owner; returns the unsubscribe function. */
  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(live: Live, event: DebugEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(live.ownerId, event);
      } catch (error) {
        this.options.logger.warn('Debug event listener failed', { error: describeError(error) });
      }
    }
  }

  private transition(live: Live, status: DebugSessionStatus, failure?: DebugFailure): boolean {
    if (!canTransition(live.session.status, status)) return false;
    live.session.status = status;
    if (failure !== undefined) live.session.failure = failure;
    if (isFinal(status)) live.session.endedAt = this.now();
    this.emit(live, {
      type: 'status',
      sessionId: live.session.id,
      status,
      failure: live.session.failure,
    });
    return true;
  }

  // --- Lookup ------------------------------------------------------------------

  private owned(ownerId: string, id: unknown): Live {
    const sessionId = parseInput(DebugSessionIdSchema, id);
    const live = this.entries.get(sessionId);
    // Another owner's session is reported as missing: its existence is not disclosed.
    if (live === undefined || live.ownerId !== ownerId) {
      throw new AtlasError('DEBUG_SESSION_NOT_FOUND');
    }
    return live;
  }

  private snapshot(live: Live): DebugSession {
    return structuredClone(live.session);
  }

  session(ownerId: string, id: unknown): DebugSession {
    return this.snapshot(this.owned(ownerId, id));
  }

  sessions(ownerId: string): DebugSession[] {
    return [...this.entries.values()]
      .filter((live) => live.ownerId === ownerId)
      .map((live) => this.snapshot(live));
  }

  // --- Lifecycle ---------------------------------------------------------------

  /** Records a configuration as a CREATED session. Nothing starts yet. */
  async create(ownerId: string, input: unknown): Promise<DebugSession> {
    const configuration = parseInput(DebugConfigurationSchema, input);
    if (!this.adaptersById.has(configuration.adapterId)) {
      throw new AtlasError('DEBUG_ADAPTER_NOT_FOUND');
    }
    if ((await this.options.projectPath(configuration.projectId)) === null) {
      throw new AtlasError('PROJECT_NOT_FOUND');
    }
    if ([...this.entries.values()].some((live) => !isFinal(live.session.status))) {
      throw new AtlasError('DEBUG_BUSY');
    }
    const live: Live = {
      ownerId,
      configuration,
      process: null,
      connection: null,
      stderr: '',
      stopping: null,
      initialized: Promise.resolve(),
      markInitialized: () => undefined,
      session: {
        id: this.options.generateId(),
        name: configuration.name,
        adapterId: configuration.adapterId,
        projectId: configuration.projectId,
        request: configuration.request,
        status: 'CREATED',
        capabilities: null,
        failure: null,
        createdAt: this.now(),
        startedAt: null,
        endedAt: null,
      },
    };
    this.entries.set(live.session.id, live);
    this.prune(ownerId);
    return this.snapshot(live);
  }

  private prune(ownerId: string): void {
    const ended = [...this.entries.values()].filter(
      (live) => live.ownerId === ownerId && isFinal(live.session.status),
    );
    for (const live of ended.slice(0, Math.max(0, ended.length - ENDED_KEPT))) {
      this.entries.delete(live.session.id);
    }
  }

  /** Where the adapter runs: a folder inside the project, resolved without symlink escapes. */
  private async workingFolder(configuration: DebugConfiguration): Promise<string> {
    const { fileSystem } = this.options;
    const project = await this.options.projectPath(configuration.projectId);
    const root = project === null ? null : await fileSystem.directory(project);
    if (root === null) throw new AtlasError('PROJECT_NOT_FOUND');
    const folder = await fileSystem.directory(path.join(root, configuration.cwd));
    if (folder === null || (folder !== root && !folder.startsWith(root + path.sep))) {
      throw new AtlasError('DEBUG_WORKSPACE_INVALID');
    }
    return folder;
  }

  /**
   * Starts the adapter and runs the DAP handshake: `initialize`, `launch` or `attach`,
   * the `initialized` event, then `configurationDone`. Settles with the session once it
   * runs (or is paused on entry), or with its FAILED state and reason.
   */
  async start(ownerId: string, id: unknown): Promise<DebugSession> {
    const live = this.owned(ownerId, id);
    if (live.session.status !== 'CREATED') throw new AtlasError('DEBUG_INVALID_STATE');
    let prepared: { adapter: DebugAdapter; command: string; cwd: string };
    try {
      prepared = await this.prepare(live.configuration);
    } catch (error) {
      this.terminateUnstarted(live, error);
      return this.snapshot(live);
    }
    const { adapter, command, cwd } = prepared;
    live.session.startedAt = this.now();
    this.transition(live, 'STARTING');
    this.launch(live, adapter, command, cwd);
    try {
      await this.handshake(live, adapter, cwd);
      if (statusOf(live) === 'STARTING') this.transition(live, 'RUNNING');
      this.options.logger.info('Debug session started', {
        session: live.session.id,
        adapter: live.session.adapterId,
        pid: live.process?.pid ?? null,
      });
    } catch (error) {
      // A stop requested while starting is not a failure.
      const status = statusOf(live);
      if (status !== 'TERMINATING' && status !== 'TERMINATED') {
        this.fail(live, error);
      }
    }
    return this.snapshot(live);
  }

  /** The adapter, its checked executable and the working folder; nothing runs yet. */
  private async prepare(
    configuration: DebugConfiguration,
  ): Promise<{ adapter: DebugAdapter; command: string; cwd: string }> {
    const adapter = this.adaptersById.get(configuration.adapterId);
    if (adapter === undefined) throw new AtlasError('DEBUG_ADAPTER_NOT_FOUND');
    const command = await this.options.fileSystem.executable(adapter.command);
    if (command === null) throw new AtlasError('DEBUG_ADAPTER_INVALID');
    return { adapter, command, cwd: await this.workingFolder(configuration) };
  }

  /** CREATED sessions that cannot start end as FAILED without running anything. */
  private terminateUnstarted(live: Live, error: unknown): void {
    const failure = failureOf(error);
    this.transition(live, 'FAILED', failure);
    this.options.logger.warn('Debug session could not start', {
      session: live.session.id,
      code: failure.code,
    });
  }

  private launch(live: Live, adapter: DebugAdapter, command: string, cwd: string): void {
    live.initialized = new Promise<void>((resolve) => {
      live.markInitialized = resolve;
    });
    live.process = this.options.launcher.launch(
      { command, args: adapter.args, cwd },
      {
        onStdout: (chunk) => live.connection?.receive(chunk),
        onStderr: (chunk) => {
          live.stderr = (live.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
        },
        onExit: (code, signal, error) => this.exited(live, code, signal, error),
      },
    );
    const process = live.process;
    live.connection = new DapConnection({
      write: (data) => process.write(data),
      onEvent: (event) => this.adapterEvent(live, event),
      onProtocolError: (error) => this.fail(live, error),
    });
  }

  private async handshake(live: Live, adapter: DebugAdapter, cwd: string): Promise<void> {
    const connection = live.connection as DapConnection;
    const { configuration } = live;
    const initialize = await connection.request(
      'initialize',
      {
        clientID: 'atlas',
        clientName: 'ATLAS',
        adapterID: adapter.id,
        locale: 'en',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsRunInTerminalRequest: false,
        supportsStartDebuggingRequest: false,
      } satisfies DebugProtocol.InitializeRequestArguments,
      this.timeouts.initialize,
    );
    if (!initialize.success) throw this.launchFailure(initialize);
    const capabilities = (initialize.body ?? {}) as DebugProtocol.Capabilities;
    live.session.capabilities = structuredClone(capabilities) as Record<string, unknown>;

    // Adapter options first, so they cannot replace what ATLAS sets.
    const response = connection.request(
      configuration.request,
      {
        ...configuration.options,
        name: configuration.name,
        type: adapter.id,
        request: configuration.request,
        cwd,
        ...(configuration.program === null ? {} : { program: configuration.program }),
        args: configuration.args,
        env: configuration.env,
        stopOnEntry: configuration.stopOnEntry,
      },
      this.timeouts.launch,
    );
    // Some adapters answer `launch` only after `configurationDone`; a refusal ends at once.
    const refused = response.then((result) => {
      if (!result.success) throw this.launchFailure(result);
      return new Promise<never>(() => undefined);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AtlasError('DEBUG_TIMEOUT', 'No initialized event.')),
        this.timeouts.launch,
      );
    });
    try {
      await Promise.race([live.initialized, refused, late]);
    } finally {
      clearTimeout(timer);
    }
    if (capabilities.supportsConfigurationDoneRequest === true) {
      const done = await connection.request(
        'configurationDone',
        undefined,
        this.timeouts.configurationDone,
      );
      if (!done.success) throw this.launchFailure(done);
    }
    const launched = await response;
    if (!launched.success) throw this.launchFailure(launched);
  }

  private launchFailure(response: DebugProtocol.Response): AtlasError {
    const error = new AtlasError('DEBUG_LAUNCH_FAILED', `${response.command} refused.`);
    const detail =
      response.message ?? (response.body as { error?: { format?: string } })?.error?.format;
    (error as AtlasError & { adapterMessage?: string }).adapterMessage =
      typeof detail === 'string' ? clean(detail, 500) : undefined;
    return error;
  }

  private adapterEvent(live: Live, event: DebugProtocol.Event): void {
    const sessionId = live.session.id;
    const body = (event.body ?? {}) as Record<string, unknown>;
    switch (event.event) {
      case 'initialized':
        live.markInitialized();
        return;
      case 'stopped':
        if (live.session.status === 'RUNNING' || live.session.status === 'STARTING') {
          this.transition(live, 'PAUSED');
        }
        this.emit(live, {
          type: 'stopped',
          sessionId,
          reason: clean(String(body.reason ?? 'unknown'), 100),
          threadId: typeof body.threadId === 'number' ? body.threadId : null,
          description: typeof body.description === 'string' ? clean(body.description, 500) : null,
        });
        return;
      case 'continued':
        if (live.session.status === 'PAUSED') this.transition(live, 'RUNNING');
        return;
      case 'output':
        this.emit(live, {
          type: 'output',
          sessionId,
          category: clean(String(body.category ?? 'console'), 50),
          output: String(body.output ?? '').slice(0, OUTPUT_MAX),
        });
        return;
      case 'terminated':
        // The program ended: close the session like a user stop.
        void this.stopLive(live);
        return;
      default: {
        let size = Infinity;
        try {
          size = JSON.stringify(body).length;
        } catch {
          // Not serializable: dropped below.
        }
        this.emit(live, {
          type: 'adapter-event',
          sessionId,
          event: clean(event.event, 100),
          body: size <= EVENT_BODY_MAX ? body : null,
        });
      }
    }
  }

  private exited(
    live: Live,
    code: number | null,
    signal: string | null,
    error: Error | null,
  ): void {
    live.connection?.close(new AtlasError('DEBUG_ADAPTER_FAILED', 'The adapter exited.'));
    if (isFinal(live.session.status) || live.session.status === 'TERMINATING') return;
    this.options.logger.warn('Debug adapter exited unexpectedly', {
      session: live.session.id,
      exitCode: code,
      signal,
      error: error === null ? undefined : describeError(error),
    });
    const tail = clean(live.stderr.trim(), 500);
    this.fail(
      live,
      new AtlasError(error === null ? 'DEBUG_ADAPTER_FAILED' : 'DEBUG_ADAPTER_INVALID'),
      tail || null,
    );
  }

  /** Ends a session as FAILED and stops its adapter tree. */
  private fail(live: Live, error: unknown, adapterMessage: string | null = null): void {
    if (isFinal(live.session.status)) return;
    const fromAdapter =
      adapterMessage ?? (error as { adapterMessage?: string } | null)?.adapterMessage ?? null;
    const failure = failureOf(error, fromAdapter);
    if (!this.transition(live, 'FAILED', failure)) return;
    live.connection?.close(new AtlasError('DEBUG_ADAPTER_FAILED', 'The session failed.'));
    live.process?.stop();
    this.options.logger.warn('Debug session failed', {
      session: live.session.id,
      adapter: live.session.adapterId,
      code: failure.code,
    });
  }

  /**
   * Stops a session: `disconnect` (ending the debuggee) with a timeout, then the adapter's
   * whole process tree. Settles once the tree is gone.
   */
  async stop(ownerId: string, id: unknown): Promise<DebugSession> {
    const live = this.owned(ownerId, id);
    await this.stopLive(live);
    return this.snapshot(live);
  }

  private stopLive(live: Live): Promise<void> {
    if (live.stopping !== null) return live.stopping;
    if (live.session.status === 'CREATED') {
      this.transition(live, 'TERMINATED');
      return Promise.resolve();
    }
    if (isFinal(live.session.status)) return live.process?.finished ?? Promise.resolve();
    this.transition(live, 'TERMINATING');
    live.stopping = (async () => {
      const connection = live.connection;
      if (connection !== null && !connection.isClosed) {
        await connection
          .request('disconnect', { terminateDebuggee: true }, this.timeouts.disconnect)
          .catch(() => undefined);
      }
      connection?.close(new AtlasError('DEBUG_INVALID_STATE', 'The session stopped.'));
      live.process?.stop();
      await live.process?.finished;
      this.transition(live, 'TERMINATED');
      this.options.logger.info('Debug session stopped', { session: live.session.id });
    })();
    return live.stopping;
  }

  /** The owner went away (window reloaded or closed): its sessions stop and are forgotten. */
  async detach(ownerId: string): Promise<void> {
    const owned = [...this.entries.values()].filter((live) => live.ownerId === ownerId);
    await Promise.all(owned.map((live) => this.stopLive(live)));
    for (const live of owned) this.entries.delete(live.session.id);
  }

  /** Engine shutdown: every adapter process tree is stopped. */
  async close(): Promise<void> {
    await Promise.all([...this.entries.values()].map((live) => this.stopLive(live)));
    this.listeners.clear();
  }
}
