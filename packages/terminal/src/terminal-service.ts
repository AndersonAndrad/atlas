import {
  CreateTerminalInputSchema,
  TerminalIdSchema,
  isFinalTerminalStatus,
  parseInput,
  type CreateTerminalInput,
  type ShellCatalog,
  type ShellOption,
  type TerminalAttachment,
  type TerminalCloseInfo,
  type TerminalEndReason,
  type TerminalEvent,
  type TerminalSession,
  type TerminalStatus,
} from '@atlas/contracts';
import { AtlasError, USER_MESSAGES, describeError, noopLogger, type Logger } from '@atlas/shared';
import type {
  EnvironmentProvider,
  PtyExit,
  PtyProcess,
  PtySpawner,
  ScreenMirror,
  ScreenMirrorFactory,
  ShellProvider,
  TerminalSessionRepository,
  WorkspaceResolver,
} from './ports.js';
import { assertTransition } from './status.js';
import type { TerminalSettings } from './terminal-settings.js';

export const TERMINAL_LIMITS = {
  /** Sessions with a live process. */
  maxActiveSessions: 32,
  /** All sessions kept in memory, including ended ones not yet dismissed. */
  maxSessions: 64,
  defaultColumns: 80,
  defaultRows: 24,
} as const;

export interface TerminalTiming {
  /** Output is coalesced for at most this long before being delivered. */
  flushIntervalMs: number;
  /** Output is delivered immediately once this many characters are pending. */
  flushThreshold: number;
  /** The PTY is paused when a view has this many unacknowledged characters. */
  pauseThreshold: number;
  /** A paused PTY resumes when every view is below this many unacknowledged characters. */
  resumeThreshold: number;
  /** Time a process gets to exit after SIGHUP before it is killed. */
  killTimeoutMs: number;
}

export const DEFAULT_TERMINAL_TIMING: TerminalTiming = {
  flushIntervalMs: 8,
  flushThreshold: 32 * 1024,
  pauseThreshold: 1024 * 1024,
  resumeThreshold: 256 * 1024,
  killTimeoutMs: 3000,
};

/**
 * Receives Engine terminal events. Output events are emitted once per attached
 * subscriber with its id; lifecycle events are emitted once without one.
 */
export type TerminalEventListener = (event: TerminalEvent, subscriberId?: string) => void;

export interface TerminalServiceDependencies {
  sessions: TerminalSessionRepository;
  spawner: PtySpawner;
  mirrors: ScreenMirrorFactory;
  shells: ShellProvider;
  workspaces: WorkspaceResolver;
  settings: TerminalSettings;
  environment: EnvironmentProvider;
  clock: { now(): Date };
  generateId: () => string;
  logger?: Logger;
  timing?: Partial<TerminalTiming>;
}

interface Subscriber {
  unacknowledged: number;
}

interface RuntimeSession {
  session: TerminalSession;
  mirror: ScreenMirror | undefined;
  pty: PtyProcess | undefined;
  /** Sequence number of the last delivered output chunk. */
  seq: number;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  killTimer: ReturnType<typeof setTimeout> | undefined;
  subscribers: Map<string, Subscriber>;
  paused: boolean;
  terminationReason: TerminalEndReason | undefined;
  exited: Promise<void>;
  markExited: () => void;
}

/**
 * Owns terminal sessions and their processes. Processes live only in memory;
 * metadata is persisted so a restarted Engine can show what ended.
 */
export class TerminalService {
  private readonly runtimes = new Map<string, RuntimeSession>();
  private readonly listeners = new Set<TerminalEventListener>();
  private readonly logger: Logger;
  private readonly timing: TerminalTiming;
  private shuttingDown = false;

  constructor(private readonly deps: TerminalServiceDependencies) {
    this.logger = deps.logger ?? noopLogger;
    this.timing = { ...DEFAULT_TERMINAL_TIMING, ...deps.timing };
  }

  /** Loads sessions from previous runs, marking the ones that were still live as lost. */
  async initialize(): Promise<void> {
    const interrupted = await this.deps.sessions.markInterrupted(this.now());
    if (interrupted > 0) {
      this.logger.warn('Marked terminal sessions from a previous run as lost', {
        count: interrupted,
      });
    }
    for (const session of await this.deps.sessions.findAll()) {
      this.runtimes.set(session.id, this.newRuntime(session, undefined));
    }
  }

  onEvent(listener: TerminalEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(projectId?: string): TerminalSession[] {
    return [...this.runtimes.values()]
      .map((runtime) => runtime.session)
      .filter((session) => projectId === undefined || session.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(copySession);
  }

  getById(id: string): TerminalSession {
    return copySession(this.getRuntime(id).session);
  }

  activeCount(): number {
    return [...this.runtimes.values()].filter((r) => !isFinalTerminalStatus(r.session.status))
      .length;
  }

  async create(input: CreateTerminalInput): Promise<TerminalSession> {
    const parsed = parseInput(CreateTerminalInputSchema, input);
    if (this.shuttingDown) {
      throw new AtlasError('TERMINAL_START_FAILED', 'The Engine is shutting down.');
    }
    if (
      this.activeCount() >= TERMINAL_LIMITS.maxActiveSessions ||
      this.runtimes.size >= TERMINAL_LIMITS.maxSessions
    ) {
      throw new AtlasError('TERMINAL_LIMIT_REACHED', undefined, {
        details: { active: this.activeCount(), total: this.runtimes.size },
      });
    }

    // The working directory always comes from the registry, never from the caller.
    const cwd = await this.deps.workspaces.resolveWorkingDirectory(parsed.projectId);
    const shell = await this.chooseShell(parsed.shellId);
    const session: TerminalSession = {
      id: this.deps.generateId(),
      projectId: parsed.projectId,
      title: parsed.title ?? this.defaultTitle(parsed.projectId, shell.name),
      shell: { id: shell.id, name: shell.name, path: shell.path },
      cwd,
      status: 'CREATED',
      columns: parsed.columns ?? TERMINAL_LIMITS.defaultColumns,
      rows: parsed.rows ?? TERMINAL_LIMITS.defaultRows,
      createdAt: this.now(),
    };
    const runtime = this.newRuntime(
      session,
      this.deps.mirrors.create(session.columns, session.rows),
    );
    this.runtimes.set(session.id, runtime);
    await this.persist(runtime);
    this.emit({ type: 'session', session: copySession(session) });

    await this.start(runtime, shell);
    return copySession(runtime.session);
  }

  write(id: string, data: string): void {
    const runtime = this.getRuntime(id);
    if (runtime.session.status !== 'RUNNING' || runtime.pty === undefined) {
      throw new AtlasError('TERMINAL_NOT_RUNNING', undefined, { details: { sessionId: id } });
    }
    // Raw PTY input: never interpolated into a command line.
    runtime.pty.write(data);
  }

  resize(id: string, columns: number, rows: number): void {
    const runtime = this.getRuntime(id);
    this.applyResize(runtime, columns, rows);
  }

  async rename(id: string, title: string): Promise<TerminalSession> {
    const runtime = this.getRuntime(id);
    runtime.session.title = title;
    await this.persist(runtime);
    this.emit({ type: 'session', session: copySession(runtime.session) });
    return copySession(runtime.session);
  }

  /**
   * Terminates the session's process and resolves once it exited (forcing a
   * kill after the timeout). Ended sessions are returned unchanged.
   */
  async terminate(id: string, reason: TerminalEndReason = 'user'): Promise<TerminalSession> {
    const runtime = this.getRuntime(id);
    const { status } = runtime.session;
    if (status === 'RUNNING') {
      runtime.terminationReason = reason;
      await this.transition(runtime, 'TERMINATING');
      this.logger.info('Terminating terminal session', { sessionId: id, reason });
      runtime.pty?.kill('SIGHUP');
      runtime.killTimer = setTimeout(() => {
        this.logger.warn('Terminal process did not exit; killing it', { sessionId: id });
        runtime.pty?.kill('SIGKILL');
      }, this.timing.killTimeoutMs);
    }
    if (!isFinalTerminalStatus(runtime.session.status)) {
      await runtime.exited;
    }
    return copySession(runtime.session);
  }

  /** Terminates the session if needed and forgets it (closing its tab). */
  async dismiss(id: string): Promise<void> {
    const runtime = this.getRuntime(id);
    await this.terminate(id);
    this.disposeRuntime(runtime);
    this.runtimes.delete(id);
    await this.deps.sessions.delete(id);
    this.emit({ type: 'removed', sessionId: id, projectId: runtime.session.projectId });
  }

  /** Starts a new session that replaces an ended one, keeping its title and shell. */
  async restart(id: string): Promise<TerminalSession> {
    const previous = this.getRuntime(id).session;
    if (!isFinalTerminalStatus(previous.status)) {
      throw new AtlasError('VALIDATION_FAILED', 'Only ended terminals can be restarted.', {
        details: { sessionId: id, status: previous.status },
      });
    }
    const catalog = await this.deps.shells.catalog(null);
    const shellAvailable = catalog.shells.some((shell) => shell.id === previous.shell.id);
    const next = await this.create({
      projectId: previous.projectId,
      title: previous.title,
      columns: previous.columns,
      rows: previous.rows,
      ...(shellAvailable ? { shellId: previous.shell.id } : {}),
    });
    await this.dismiss(id);
    return next;
  }

  /** Available shells, with the user's preferred default marked. */
  async shellCatalog(): Promise<ShellCatalog> {
    const preferences = await this.deps.settings.getPreferences();
    return this.deps.shells.catalog(preferences.defaultShellId);
  }

  closeInfo(id: string): TerminalCloseInfo {
    const runtime = this.getRuntime(id);
    if (runtime.session.status !== 'RUNNING' || runtime.pty === undefined) {
      return { requiresConfirmation: false };
    }
    const foreground = runtime.pty.foregroundProcess;
    if (foreground === undefined) {
      // The platform cannot tell what is running; be conservative.
      return { requiresConfirmation: true };
    }
    const busy = processName(foreground) !== processName(runtime.session.shell.path);
    return busy
      ? { requiresConfirmation: true, processName: processName(foreground) }
      : { requiresConfirmation: false };
  }

  closeAllInfo(): { runningSessions: number; busySessions: number } {
    let runningSessions = 0;
    let busySessions = 0;
    for (const runtime of this.runtimes.values()) {
      if (isFinalTerminalStatus(runtime.session.status)) continue;
      runningSessions += 1;
      if (this.closeInfo(runtime.session.id).requiresConfirmation) busySessions += 1;
    }
    return { runningSessions, busySessions };
  }

  /** Clears the mirrored scrollback so a reattached view does not bring it back. */
  clear(id: string): void {
    this.getRuntime(id).mirror?.clear();
  }

  /**
   * Attaches a view: the subscriber starts receiving output, and gets a snapshot
   * of the current screen. Output with `seq` up to the returned value is already
   * contained in the snapshot.
   */
  async attach(
    id: string,
    subscriberId: string,
    columns: number,
    rows: number,
  ): Promise<TerminalAttachment> {
    const runtime = this.getRuntime(id);
    this.applyResize(runtime, columns, rows);
    this.flush(runtime);
    runtime.subscribers.set(subscriberId, { unacknowledged: 0 });

    const mirror = runtime.mirror;
    if (mirror === undefined) {
      return { session: copySession(runtime.session), snapshot: '', seq: runtime.seq };
    }
    const seq = runtime.seq;
    // Every chunk up to `seq` was written to the mirror; wait until it was parsed.
    const snapshot = await new Promise<string>((resolve) => {
      mirror.write('', () => resolve(mirror.serialize()));
    });
    return { session: copySession(runtime.session), snapshot, seq };
  }

  detach(id: string, subscriberId: string): void {
    const runtime = this.runtimes.get(id);
    if (runtime === undefined) return;
    runtime.subscribers.delete(subscriberId);
    this.updateFlowControl(runtime);
  }

  /** Detaches `subscriberId` and every subscriber in its group (`<subscriberId>:<view>`). */
  detachSubscriber(subscriberId: string): void {
    const groupPrefix = `${subscriberId}:`;
    for (const runtime of this.runtimes.values()) {
      let changed = false;
      for (const id of [...runtime.subscribers.keys()]) {
        if (id === subscriberId || id.startsWith(groupPrefix)) {
          runtime.subscribers.delete(id);
          changed = true;
        }
      }
      if (changed) this.updateFlowControl(runtime);
    }
  }

  /** Acknowledges output a view has rendered, releasing back-pressure. */
  acknowledge(id: string, subscriberId: string, characters: number): void {
    const subscriber = this.runtimes.get(id)?.subscribers.get(subscriberId);
    if (subscriber === undefined) return;
    subscriber.unacknowledged = Math.max(0, subscriber.unacknowledged - characters);
    this.updateFlowControl(this.runtimes.get(id)!);
  }

  /** Dismisses every session of a project (used when the project is removed). */
  async removeProjectSessions(projectId: string): Promise<void> {
    const ids = this.list(projectId).map((session) => session.id);
    await Promise.all(ids.map((id) => this.dismiss(id)));
  }

  /** Terminates every live process. Called when the Engine stops. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const live = [...this.runtimes.values()].filter(
      (runtime) => !isFinalTerminalStatus(runtime.session.status),
    );
    await Promise.all(
      live.map((runtime) =>
        this.terminate(runtime.session.id, 'engine-shutdown').catch((error: unknown) =>
          this.logger.error('Failed to terminate terminal during shutdown', {
            sessionId: runtime.session.id,
            error: describeError(error),
          }),
        ),
      ),
    );
    for (const runtime of this.runtimes.values()) this.disposeRuntime(runtime);
  }

  private async start(runtime: RuntimeSession, shell: ShellOption): Promise<void> {
    const { session } = runtime;
    await this.transition(runtime, 'STARTING');
    let pty: PtyProcess;
    try {
      pty = this.deps.spawner.spawn({
        file: shell.path,
        args: shell.args,
        cwd: session.cwd,
        env: this.deps.environment.shellEnvironment(),
        columns: session.columns,
        rows: session.rows,
      });
    } catch (error) {
      this.logger.error('Failed to start terminal shell', {
        sessionId: session.id,
        projectId: session.projectId,
        shellId: shell.id,
        error: describeError(error),
      });
      session.endReason = 'startup-failed';
      session.failureMessage = USER_MESSAGES.TERMINAL_START_FAILED;
      session.endedAt = this.now();
      await this.transition(runtime, 'FAILED');
      runtime.markExited();
      return;
    }

    runtime.pty = pty;
    pty.onData((data) => this.handleOutput(runtime, data));
    pty.onExit((exit) => void this.handleExit(runtime, exit));
    session.pid = pty.pid;
    session.startedAt = this.now();
    await this.transition(runtime, 'RUNNING');
    this.logger.info('Terminal session started', {
      sessionId: session.id,
      projectId: session.projectId,
      shellId: shell.id,
      pid: pty.pid,
    });
    if (this.shuttingDown) await this.terminate(session.id, 'engine-shutdown');
  }

  private handleOutput(runtime: RuntimeSession, data: string): void {
    runtime.pending += data;
    if (runtime.pending.length >= this.timing.flushThreshold) {
      this.flush(runtime);
    } else if (runtime.flushTimer === undefined) {
      runtime.flushTimer = setTimeout(() => this.flush(runtime), this.timing.flushIntervalMs);
    }
  }

  private flush(runtime: RuntimeSession): void {
    if (runtime.flushTimer !== undefined) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = undefined;
    }
    if (runtime.pending === '') return;
    const data = runtime.pending;
    runtime.pending = '';
    runtime.seq += 1;
    runtime.mirror?.write(data);
    const event: TerminalEvent = {
      type: 'output',
      sessionId: runtime.session.id,
      seq: runtime.seq,
      data,
    };
    for (const [subscriberId, subscriber] of runtime.subscribers) {
      subscriber.unacknowledged += data.length;
      this.emit(event, subscriberId);
    }
    this.updateFlowControl(runtime);
  }

  private updateFlowControl(runtime: RuntimeSession): void {
    const pty = runtime.pty;
    if (pty === undefined || runtime.session.status !== 'RUNNING') return;
    const backlog = Math.max(
      0,
      ...[...runtime.subscribers.values()].map((subscriber) => subscriber.unacknowledged),
    );
    if (!runtime.paused && backlog > this.timing.pauseThreshold) {
      runtime.paused = true;
      pty.pause();
    } else if (runtime.paused && backlog < this.timing.resumeThreshold) {
      runtime.paused = false;
      pty.resume();
    }
  }

  private async handleExit(runtime: RuntimeSession, exit: PtyExit): Promise<void> {
    this.flush(runtime);
    if (runtime.killTimer !== undefined) clearTimeout(runtime.killTimer);
    const { session } = runtime;
    session.exitCode = exit.exitCode;
    if (exit.signal !== undefined && exit.signal !== 0) session.signal = exit.signal;
    session.endedAt = this.now();
    session.endReason = runtime.terminationReason ?? 'exited';
    runtime.pty = undefined;
    try {
      await this.transition(runtime, session.status === 'TERMINATING' ? 'TERMINATED' : 'EXITED');
    } catch (error) {
      this.logger.error('Failed to record terminal exit', {
        sessionId: session.id,
        error: describeError(error),
      });
    } finally {
      runtime.markExited();
    }
    this.logger.info('Terminal session ended', {
      sessionId: session.id,
      projectId: session.projectId,
      exitCode: session.exitCode,
      signal: session.signal,
      endReason: session.endReason,
    });
  }

  private async transition(runtime: RuntimeSession, next: TerminalStatus): Promise<void> {
    assertTransition(runtime.session.status, next);
    runtime.session.status = next;
    this.emit({ type: 'session', session: copySession(runtime.session) });
    await this.persist(runtime);
  }

  private async persist(runtime: RuntimeSession): Promise<void> {
    try {
      await this.deps.sessions.save(copySession(runtime.session));
    } catch (error) {
      // Runtime state stays authoritative; persistence only serves restarts.
      this.logger.error('Failed to persist terminal session', {
        sessionId: runtime.session.id,
        error: describeError(error),
      });
    }
  }

  private applyResize(runtime: RuntimeSession, columns: number, rows: number): void {
    const { session } = runtime;
    if (session.columns === columns && session.rows === rows) return;
    session.columns = columns;
    session.rows = rows;
    runtime.mirror?.resize(columns, rows);
    if (session.status === 'RUNNING') runtime.pty?.resize(columns, rows);
  }

  private async chooseShell(shellId: string | undefined): Promise<ShellOption> {
    const catalog = await this.shellCatalog();
    const shell =
      shellId === undefined
        ? catalog.shells.find((option) => option.isDefault)
        : catalog.shells.find((option) => option.id === shellId);
    if (shell === undefined) {
      throw new AtlasError('TERMINAL_SHELL_UNAVAILABLE', undefined, {
        details: { shellId, available: catalog.shells.map((option) => option.id) },
      });
    }
    return shell;
  }

  private defaultTitle(projectId: string, shellName: string): string {
    const taken = new Set(this.list(projectId).map((session) => session.title));
    if (!taken.has(shellName)) return shellName;
    let index = 2;
    while (taken.has(`${shellName} ${index}`)) index += 1;
    return `${shellName} ${index}`;
  }

  private getRuntime(id: string): RuntimeSession {
    const parsed = TerminalIdSchema.safeParse(id);
    const runtime = parsed.success ? this.runtimes.get(parsed.data) : undefined;
    if (runtime === undefined) {
      throw new AtlasError('TERMINAL_NOT_FOUND', undefined, { details: { sessionId: id } });
    }
    return runtime;
  }

  private newRuntime(session: TerminalSession, mirror: ScreenMirror | undefined): RuntimeSession {
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const runtime: RuntimeSession = {
      session,
      mirror,
      pty: undefined,
      seq: 0,
      pending: '',
      flushTimer: undefined,
      killTimer: undefined,
      subscribers: new Map(),
      paused: false,
      terminationReason: undefined,
      exited,
      markExited,
    };
    if (isFinalTerminalStatus(session.status)) markExited();
    return runtime;
  }

  private disposeRuntime(runtime: RuntimeSession): void {
    if (runtime.flushTimer !== undefined) clearTimeout(runtime.flushTimer);
    if (runtime.killTimer !== undefined) clearTimeout(runtime.killTimer);
    runtime.subscribers.clear();
    runtime.mirror?.dispose();
    runtime.mirror = undefined;
  }

  private emit(event: TerminalEvent, subscriberId?: string): void {
    for (const listener of this.listeners) {
      try {
        listener(event, subscriberId);
      } catch (error) {
        this.logger.error('Terminal event listener failed', { error: describeError(error) });
      }
    }
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }
}

function copySession(session: TerminalSession): TerminalSession {
  return { ...session, shell: { ...session.shell } };
}

/** Normalizes a process name or path for comparison ("-zsh", "/bin/zsh" -> "zsh"). */
function processName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  return base
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
}
