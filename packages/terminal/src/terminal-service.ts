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
  ProcessCwdResolver,
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
  /** After a command is entered, the cwd is read once output has been quiet this long. */
  cwdCheckDelayMs: number;
}

export const DEFAULT_TERMINAL_TIMING: TerminalTiming = {
  flushIntervalMs: 8,
  flushThreshold: 32 * 1024,
  pauseThreshold: 1024 * 1024,
  resumeThreshold: 256 * 1024,
  killTimeoutMs: 3000,
  cwdCheckDelayMs: 700,
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
  cwdResolver: ProcessCwdResolver;
  /**
   * Called after a submitted command settled (output quiet), with the shell's
   * current directory. Used to refresh Git state that commands may have changed.
   */
  onCommandSettled?: (session: TerminalSession) => void;
  /** Whether a terminal group exists (groups are managed by TerminalGroups). */
  groupExists: (groupId: string) => Promise<boolean>;
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
  /** A command was entered; the cwd is read once output settles. */
  cwdCheckPending: boolean;
  cwdTimer: ReturnType<typeof setTimeout> | undefined;
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

    const cwd = await this.resolveStartDirectory(parsed.projectId, parsed.cwd);
    if (parsed.groupId !== undefined) await this.assertGroup(parsed.groupId);
    const shell = await this.chooseShell(parsed.shellId);
    const groupId = parsed.groupId ?? null;
    const autoTitle = this.autoTitle(cwd);
    const customTitle = parsed.title ?? null;
    const session: TerminalSession = {
      id: this.deps.generateId(),
      projectId: parsed.projectId ?? null,
      title: customTitle ?? autoTitle,
      customTitle,
      autoTitle,
      groupId,
      groupPosition: this.nextPosition(groupId),
      shell: { id: shell.id, name: shell.name, path: shell.path },
      cwd,
      currentCwd: cwd,
      cwdSource: 'initial',
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
    // A submitted command may change the directory; check once output settles.
    if (data.includes('\r') || data.includes('\n')) {
      runtime.cwdCheckPending = true;
      this.scheduleCwdCheck(runtime);
    }
  }

  resize(id: string, columns: number, rows: number): void {
    const runtime = this.getRuntime(id);
    this.applyResize(runtime, columns, rows);
  }

  /** Sets a custom name; `null` restores the automatic name. */
  async rename(id: string, title: string | null): Promise<TerminalSession> {
    const runtime = this.getRuntime(id);
    runtime.session.customTitle = title;
    runtime.session.title = title ?? runtime.session.autoTitle;
    return this.update(runtime);
  }

  /** Associates the terminal with a registered project, or makes it standalone. */
  async associate(id: string, projectId: string | null): Promise<TerminalSession> {
    const runtime = this.getRuntime(id);
    if (projectId !== null) await this.deps.workspaces.assertProjectExists(projectId);
    runtime.session.projectId = projectId;
    return this.update(runtime);
  }

  /** Clears the association of every terminal of a removed project. Processes keep running. */
  async detachProject(projectId: string): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      if (runtime.session.projectId !== projectId) continue;
      runtime.session.projectId = null;
      await this.update(runtime);
    }
  }

  /**
   * Moves a terminal into a group (or out of all groups with `null`) at the given
   * position. Only metadata changes: the process is never restarted.
   */
  async move(id: string, groupId: string | null, position: number): Promise<TerminalSession> {
    const runtime = this.getRuntime(id);
    if (groupId !== null) await this.assertGroup(groupId);
    const previousGroup = runtime.session.groupId;
    runtime.session.groupId = groupId;
    const members = this.groupMembers(groupId).filter((member) => member !== runtime);
    members.splice(Math.min(position, members.length), 0, runtime);
    await this.renumber(members, new Set([runtime]));
    if (previousGroup !== groupId) await this.renumber(this.groupMembers(previousGroup));
    return copySession(runtime.session);
  }

  /** Moves every terminal of a group out of it (used when the group is deleted). */
  async ungroupAll(groupId: string): Promise<void> {
    const members = this.groupMembers(groupId);
    const ungrouped = this.groupMembers(null);
    for (const runtime of members) runtime.session.groupId = null;
    await this.renumber([...ungrouped, ...members], new Set(members));
  }

  /** Publishes an event to listeners (used by collaborating Engine services). */
  publish(event: TerminalEvent): void {
    this.emit(event);
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
    const groupAvailable =
      previous.groupId !== null && (await this.deps.groupExists(previous.groupId));
    const next = await this.create({
      ...(previous.projectId !== null ? { projectId: previous.projectId } : { cwd: previous.cwd }),
      ...(previous.customTitle !== null ? { title: previous.customTitle } : {}),
      ...(groupAvailable && previous.groupId !== null ? { groupId: previous.groupId } : {}),
      columns: previous.columns,
      rows: previous.rows,
      ...(shellAvailable ? { shellId: previous.shell.id } : {}),
    });
    await this.dismiss(id);
    // Take the place of the session it replaces.
    const runtime = this.getRuntime(next.id);
    if (runtime.session.groupId === previous.groupId) {
      const members = this.groupMembers(runtime.session.groupId).filter((m) => m !== runtime);
      const index = members.filter((m) => m.session.groupPosition < previous.groupPosition).length;
      members.splice(index, 0, runtime);
      await this.renumber(members);
    }
    return copySession(runtime.session);
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
        env: this.deps.environment.shellEnvironment({
          projectId: session.projectId,
          cwd: session.cwd,
        }),
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
    if (runtime.cwdCheckPending) this.scheduleCwdCheck(runtime);
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

  /** Reads the shell's working directory after output settled; never blocks I/O. */
  private scheduleCwdCheck(runtime: RuntimeSession): void {
    if (runtime.cwdTimer !== undefined) clearTimeout(runtime.cwdTimer);
    runtime.cwdTimer = setTimeout(() => {
      runtime.cwdTimer = undefined;
      runtime.cwdCheckPending = false;
      void this.refreshCwd(runtime);
    }, this.timing.cwdCheckDelayMs);
  }

  private async refreshCwd(runtime: RuntimeSession): Promise<void> {
    const pid = runtime.session.pid;
    if (runtime.session.status !== 'RUNNING' || pid === undefined) return;
    let directory: string | null;
    try {
      directory = await this.deps.cwdResolver.currentDirectory(pid);
    } catch (error) {
      this.logger.debug('Could not read terminal working directory', {
        sessionId: runtime.session.id,
        error: describeError(error),
      });
      return;
    }
    if (runtime.session.status !== 'RUNNING') return;
    if (directory === null) {
      this.deps.onCommandSettled?.(copySession(runtime.session));
      return;
    }
    const { session } = runtime;
    if (directory === session.currentCwd && session.cwdSource === 'detected') {
      this.deps.onCommandSettled?.(copySession(session));
      return;
    }
    session.currentCwd = directory;
    session.cwdSource = 'detected';
    session.autoTitle = this.autoTitle(directory);
    session.title = session.customTitle ?? session.autoTitle;
    await this.update(runtime);
    this.deps.onCommandSettled?.(copySession(session));
  }

  /** Automatic name: the current directory's name (`~` for the home directory). */
  private autoTitle(directory: string): string {
    if (directory === this.deps.workspaces.homeDirectory()) return '~';
    const name =
      directory
        .split(/[\\/]/)
        .filter((part) => part !== '')
        .pop() ?? directory;
    return name.slice(0, 60) || '/';
  }

  private async resolveStartDirectory(
    projectId: string | undefined,
    cwd: string | undefined,
  ): Promise<string> {
    // Project terminals always start in the registered directory.
    if (projectId !== undefined) return this.deps.workspaces.resolveProjectDirectory(projectId);
    if (cwd !== undefined) return this.deps.workspaces.resolveDirectory(cwd);
    const { defaultWorkingDirectory } = await this.deps.settings.getPreferences();
    if (defaultWorkingDirectory !== null) {
      try {
        return await this.deps.workspaces.resolveDirectory(defaultWorkingDirectory);
      } catch (error) {
        this.logger.warn('Default working directory unavailable; using the home directory', {
          error: describeError(error),
        });
      }
    }
    return this.deps.workspaces.resolveDirectory(this.deps.workspaces.homeDirectory());
  }

  private async assertGroup(groupId: string): Promise<void> {
    if (!(await this.deps.groupExists(groupId))) {
      throw new AtlasError('VALIDATION_FAILED', 'The terminal group does not exist.', {
        details: { groupId },
        issues: [{ field: 'groupId', message: 'The terminal group does not exist.' }],
      });
    }
  }

  private groupMembers(groupId: string | null): RuntimeSession[] {
    return [...this.runtimes.values()]
      .filter((runtime) => runtime.session.groupId === groupId)
      .sort(
        (a, b) =>
          a.session.groupPosition - b.session.groupPosition ||
          a.session.createdAt.localeCompare(b.session.createdAt),
      );
  }

  private nextPosition(groupId: string | null): number {
    const members = this.groupMembers(groupId);
    return members.length === 0 ? 0 : members.at(-1)!.session.groupPosition + 1;
  }

  /**
   * Stores consecutive positions for the given ordered members, persisting the
   * ones whose position changed and those listed in `changed`.
   */
  private async renumber(
    members: RuntimeSession[],
    changed: ReadonlySet<RuntimeSession> = new Set(),
  ): Promise<void> {
    for (const [index, runtime] of members.entries()) {
      if (runtime.session.groupPosition === index && !changed.has(runtime)) continue;
      runtime.session.groupPosition = index;
      await this.update(runtime);
    }
  }

  private async update(runtime: RuntimeSession): Promise<TerminalSession> {
    await this.persist(runtime);
    this.emit({ type: 'session', session: copySession(runtime.session) });
    return copySession(runtime.session);
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
      cwdCheckPending: false,
      cwdTimer: undefined,
      exited,
      markExited,
    };
    if (isFinalTerminalStatus(session.status)) markExited();
    return runtime;
  }

  private disposeRuntime(runtime: RuntimeSession): void {
    if (runtime.flushTimer !== undefined) clearTimeout(runtime.flushTimer);
    if (runtime.killTimer !== undefined) clearTimeout(runtime.killTimer);
    if (runtime.cwdTimer !== undefined) clearTimeout(runtime.cwdTimer);
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
