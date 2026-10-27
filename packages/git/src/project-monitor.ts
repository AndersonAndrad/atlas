import type {
  GitStatus,
  GitUnavailableReason,
  ProjectGitRefreshResult,
  ProjectGitSnapshot,
  ProjectGitState,
} from '@atlas/contracts';
import { AtlasError, describeError, noopLogger, type Logger } from '@atlas/shared';

/** Stored monitoring preference and last known status of one project. */
export interface StoredProjectGit {
  projectId: string;
  monitoringEnabled: boolean;
  snapshot: ProjectGitSnapshot | null;
  refreshedAt: string | null;
  error: { reason: GitUnavailableReason; at: string } | null;
}

export interface ProjectGitStore {
  list(): Promise<StoredProjectGit[]>;
  /** Null when the project does not exist. */
  get(projectId: string): Promise<StoredProjectGit | null>;
  /** False when the project does not exist. */
  setMonitoring(projectId: string, enabled: boolean): Promise<boolean>;
  saveSnapshot(projectId: string, snapshot: ProjectGitSnapshot, refreshedAt: string): Promise<void>;
  saveError(projectId: string, reason: GitUnavailableReason, at: string): Promise<void>;
  clearSnapshot(projectId: string): Promise<void>;
}

export type ProjectDirectory =
  { status: 'available'; directory: string } | { status: 'unavailable' } | { status: 'removed' };

export interface ProjectGitMonitorOptions {
  store: ProjectGitStore;
  /** Read-only status of the repository containing `directory`; `fresh` skips caches. */
  inspect: (directory: string, fresh: boolean) => Promise<GitStatus>;
  projectDirectory: (projectId: string) => Promise<ProjectDirectory>;
  /** Starts or stops change watching of a repository root (best effort). */
  watch?: (repositoryRoot: string) => void;
  unwatch?: (repositoryRoot: string) => void;
  /** Called after a project's stored state changed. */
  onChange: (state: ProjectGitState) => void;
  now?: () => Date;
  logger?: Logger;
  /** Refresh interval after a change; doubled while nothing changes, up to `maxIntervalMs`. */
  baseIntervalMs?: number;
  maxIntervalMs?: number;
  /** How often due projects are looked for. */
  tickMs?: number;
  /** Automatic refreshes running at once; explicit refreshes are not queued. */
  maxConcurrentRefreshes?: number;
}

type RefreshReason = 'monitor' | 'manual';

interface Entry {
  /** Bumped when a running refresh must not be applied (disabled, moved, removed). */
  generation: number;
  monitored: boolean;
  /** Refreshed by monitoring since the monitor started, and the last check succeeded. */
  live: boolean;
  intervalMs: number;
  nextDueAt: number;
  repositoryRoot: string | null;
  fingerprint: string | null;
  inFlight: Promise<ProjectGitRefreshResult> | null;
  /** Generation the running refresh started with; an older one is not shared. */
  inFlightGeneration: number;
  /** The repository changed while a refresh was running: its result may predate it. */
  changedDuringRefresh: boolean;
  queued: boolean;
}

/**
 * Automatic, read-only Git status collection for projects with monitoring enabled
 * (SDD-024). Collected snapshots are persisted so badges render without running Git.
 * Never fetches, pulls, pushes or writes to repositories. One refresh per project runs
 * at a time and automatic refreshes are bounded; disabled projects are never scheduled.
 */
export class ProjectGitMonitor {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: string[] = [];
  private running = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private closed = false;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly baseIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly maxConcurrent: number;

  constructor(private readonly options: ProjectGitMonitorOptions) {
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? (() => new Date());
    this.baseIntervalMs = options.baseIntervalMs ?? 30_000;
    this.maxIntervalMs = Math.max(this.baseIntervalMs, options.maxIntervalMs ?? 120_000);
    this.maxConcurrent = Math.max(1, options.maxConcurrentRefreshes ?? 2);
  }

  /** Schedules monitored projects; their first refresh is due immediately. */
  async start(): Promise<void> {
    if (this.closed || this.started) return;
    this.started = true;
    for (const stored of await this.options.store.list()) {
      if (stored.monitoringEnabled) this.schedule(stored.projectId, 0);
    }
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 5_000);
    this.timer.unref?.();
    this.tick();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    for (const entry of this.entries.values()) entry.generation += 1;
  }

  /** Stored states of all projects. Never runs Git. */
  async states(): Promise<ProjectGitState[]> {
    return (await this.options.store.list()).map((stored) => this.toState(stored));
  }

  async state(projectId: string): Promise<ProjectGitState> {
    return this.toState(await this.requireStored(projectId));
  }

  /**
   * Reads the project's status now, whatever its monitoring preference, and stores it.
   * A refresh already running for the project is shared instead of starting another.
   */
  async refresh(
    projectId: string,
    options: { fresh?: boolean } = {},
  ): Promise<ProjectGitRefreshResult> {
    await this.requireStored(projectId);
    return this.run(projectId, 'manual', options.fresh ?? true);
  }

  async setMonitoring(projectId: string, enabled: boolean): Promise<ProjectGitState> {
    if (!(await this.options.store.setMonitoring(projectId, enabled))) {
      throw new AtlasError('PROJECT_NOT_FOUND', undefined, { details: { projectId } });
    }
    if (enabled) {
      this.schedule(projectId, 0);
      this.tick();
    } else {
      this.stopMonitoring(projectId);
    }
    const state = await this.state(projectId);
    this.options.onChange(state);
    return state;
  }

  /** A newly registered project; `enabled` comes from the new-project default. */
  async projectAdded(projectId: string, enabled: boolean): Promise<void> {
    if (!(await this.options.store.setMonitoring(projectId, enabled))) return;
    if (enabled) {
      this.schedule(projectId, 0);
      this.tick();
    }
  }

  /** The project's folder changed: its snapshot described another directory. */
  async projectMoved(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (entry !== undefined) {
      entry.generation += 1;
      entry.live = false;
      entry.fingerprint = null;
      this.release(projectId, entry.repositoryRoot);
      entry.repositoryRoot = null;
    }
    await this.options.store.clearSnapshot(projectId);
    const stored = await this.options.store.get(projectId);
    if (stored === null) return;
    if (stored.monitoringEnabled) {
      this.schedule(projectId, 0);
      this.tick();
    }
    this.options.onChange(this.toState(stored));
  }

  /** The project was removed; running results are discarded (the store cascades). */
  projectRemoved(projectId: string): void {
    this.stopMonitoring(projectId);
    this.entries.delete(projectId);
  }

  /** A repository may have changed (watcher, terminal command, saved file). */
  repositoryChanged(repositoryRoot: string): void {
    let any = false;
    for (const [projectId, entry] of this.entries) {
      if (!entry.monitored || entry.repositoryRoot !== repositoryRoot) continue;
      if (entry.inFlight !== null) entry.changedDuringRefresh = true;
      entry.intervalMs = this.baseIntervalMs;
      this.schedule(projectId, 0);
      any = true;
    }
    if (any) this.tick();
  }

  /** Number of automatic refreshes running (for tests and diagnostics). */
  get activeRefreshes(): number {
    return this.running;
  }

  private schedule(projectId: string, delayMs: number): void {
    const entry = this.entries.get(projectId) ?? this.newEntry(projectId);
    entry.monitored = true;
    entry.nextDueAt = Math.min(
      entry.nextDueAt > 0 ? entry.nextDueAt : Infinity,
      this.now().getTime() + delayMs,
    );
  }

  private newEntry(projectId: string): Entry {
    const entry: Entry = {
      generation: 0,
      monitored: false,
      live: false,
      intervalMs: this.baseIntervalMs,
      nextDueAt: 0,
      repositoryRoot: null,
      fingerprint: null,
      inFlight: null,
      inFlightGeneration: 0,
      changedDuringRefresh: false,
      queued: false,
    };
    this.entries.set(projectId, entry);
    return entry;
  }

  private stopMonitoring(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (entry === undefined) return;
    entry.generation += 1;
    entry.monitored = false;
    entry.live = false;
    entry.nextDueAt = 0;
    entry.intervalMs = this.baseIntervalMs;
    this.release(projectId, entry.repositoryRoot);
    const index = this.queue.indexOf(projectId);
    if (index >= 0) this.queue.splice(index, 1);
    entry.queued = false;
  }

  /** Stops watching a root unless another monitored project still uses it. */
  private release(projectId: string, root: string | null): void {
    if (root === null) return;
    for (const [otherId, other] of this.entries) {
      if (otherId !== projectId && other.monitored && other.repositoryRoot === root) return;
    }
    this.options.unwatch?.(root);
  }

  private tick(): void {
    // Before `start` (e.g. the CLI's Engine) nothing runs automatically.
    if (this.closed || !this.started) return;
    const now = this.now().getTime();
    for (const [projectId, entry] of this.entries) {
      if (!entry.monitored || entry.queued || entry.inFlight !== null) continue;
      if (entry.nextDueAt > now) continue;
      entry.queued = true;
      this.queue.push(projectId);
    }
    this.drain();
  }

  private drain(): void {
    while (!this.closed && this.running < this.maxConcurrent && this.queue.length > 0) {
      const projectId = this.queue.shift()!;
      const entry = this.entries.get(projectId);
      if (entry === undefined) continue;
      entry.queued = false;
      if (!entry.monitored) continue;
      this.running += 1;
      void this.run(projectId, 'monitor', false)
        .catch((error: unknown) =>
          this.logger.warn('Automatic Git refresh failed', { error: describeError(error) }),
        )
        .finally(() => {
          this.running -= 1;
          this.drain();
        });
    }
  }

  private run(
    projectId: string,
    reason: RefreshReason,
    fresh: boolean,
  ): Promise<ProjectGitRefreshResult> {
    const entry = this.entries.get(projectId) ?? this.newEntry(projectId);
    if (entry.inFlight !== null && entry.inFlightGeneration === entry.generation) {
      return entry.inFlight;
    }
    const promise = this.collect(projectId, entry, reason, fresh).finally(() => {
      if (entry.inFlight === promise) entry.inFlight = null;
    });
    entry.inFlight = promise;
    entry.inFlightGeneration = entry.generation;
    return promise;
  }

  private async collect(
    projectId: string,
    entry: Entry,
    reason: RefreshReason,
    fresh: boolean,
  ): Promise<ProjectGitRefreshResult> {
    const generation = entry.generation;
    entry.changedDuringRefresh = false;
    const location = await this.options.projectDirectory(projectId);
    const at = this.now().toISOString();
    let status: GitStatus;
    if (location.status === 'available') {
      status = await this.options.inspect(location.directory, fresh);
    } else {
      status = { state: 'unavailable', reason: 'directory-unavailable', inspectedAt: at };
    }
    // Monitoring was turned off, the folder moved or the project was removed meanwhile:
    // an automatic result is stale. An explicit refresh is still stored (it was asked for).
    // The store may already be closed after shutdown: nothing is read or written.
    if (this.closed) return { state: this.toState(emptyStored(projectId)), status };
    const stale = entry.generation !== generation;
    if (location.status === 'removed' || (stale && reason === 'monitor')) {
      return { state: await this.stateOrEmpty(projectId), status };
    }

    const succeeded = status.state !== 'unavailable';
    if (status.state === 'unavailable') {
      await this.options.store.saveError(projectId, status.reason, at);
    } else {
      await this.options.store.saveSnapshot(projectId, toSnapshot(status), at);
    }

    if (!stale && entry.monitored) {
      const root = status.state === 'repository' ? status.snapshot.repositoryRoot : null;
      if (root !== entry.repositoryRoot) {
        this.release(projectId, entry.repositoryRoot);
        if (root !== null) this.options.watch?.(root);
        entry.repositoryRoot = root;
      }
      const fingerprint =
        status.state === 'unavailable' ? null : JSON.stringify(toSnapshot(status));
      const unchanged = fingerprint !== null && fingerprint === entry.fingerprint;
      entry.intervalMs =
        !succeeded || unchanged
          ? Math.min(entry.intervalMs * 2, this.maxIntervalMs)
          : this.baseIntervalMs;
      if (fingerprint !== null) entry.fingerprint = fingerprint;
      entry.live = succeeded;
      if (entry.changedDuringRefresh) {
        // Checked again on the next tick instead of after a full interval.
        entry.changedDuringRefresh = false;
        entry.intervalMs = this.baseIntervalMs;
        entry.nextDueAt = this.now().getTime();
      } else {
        entry.nextDueAt = this.now().getTime() + entry.intervalMs;
      }
    }

    const state = await this.stateOrEmpty(projectId);
    this.options.onChange(state);
    return { state, status };
  }

  private async requireStored(projectId: string): Promise<StoredProjectGit> {
    const stored = await this.options.store.get(projectId);
    if (stored === null) {
      throw new AtlasError('PROJECT_NOT_FOUND', undefined, { details: { projectId } });
    }
    return stored;
  }

  private async stateOrEmpty(projectId: string): Promise<ProjectGitState> {
    return this.toState((await this.options.store.get(projectId)) ?? emptyStored(projectId));
  }

  private toState(stored: StoredProjectGit): ProjectGitState {
    const failedLast =
      stored.error !== null &&
      (stored.refreshedAt === null || stored.error.at >= stored.refreshedAt);
    const live =
      stored.monitoringEnabled &&
      !failedLast &&
      stored.snapshot !== null &&
      (this.entries.get(stored.projectId)?.live ?? false);
    return {
      projectId: stored.projectId,
      monitoringEnabled: stored.monitoringEnabled,
      freshness: stored.snapshot === null ? 'none' : live ? 'live' : 'cached',
      snapshot: stored.snapshot,
      refreshedAt: stored.refreshedAt,
      error: failedLast ? stored.error : null,
    };
  }
}

function emptyStored(projectId: string): StoredProjectGit {
  return { projectId, monitoringEnabled: false, snapshot: null, refreshedAt: null, error: null };
}

/** The persisted subset of a successful status. */
export function toSnapshot(
  status: Exclude<GitStatus, { state: 'unavailable' }>,
): ProjectGitSnapshot {
  if (status.state === 'not-repository') return { state: 'not-repository' };
  const { snapshot } = status;
  return {
    state: 'repository',
    branch: snapshot.branch,
    detachedHead: snapshot.detachedHead,
    unbornHead: snapshot.unbornHead,
    upstream: snapshot.upstream,
    ahead: snapshot.ahead,
    behind: snapshot.behind,
    upstreamGone: snapshot.upstreamGone,
    changes: { ...snapshot.changes },
  };
}
