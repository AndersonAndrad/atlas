import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GitRepositorySnapshot,
  GitStatus,
  GitUnavailableReason,
  ProjectGitSnapshot,
  ProjectGitState,
} from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import {
  ProjectGitMonitor,
  type ProjectDirectory,
  type ProjectGitStore,
  type StoredProjectGit,
} from '../src/index.js';

class MemoryStore implements ProjectGitStore {
  readonly rows = new Map<string, StoredProjectGit>();

  add(projectId: string, monitoringEnabled = true): void {
    this.rows.set(projectId, {
      projectId,
      monitoringEnabled,
      snapshot: null,
      refreshedAt: null,
      error: null,
    });
  }
  async list() {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
  async get(projectId: string) {
    const row = this.rows.get(projectId);
    return row === undefined ? null : { ...row };
  }
  async setMonitoring(projectId: string, enabled: boolean) {
    const row = this.rows.get(projectId);
    if (row === undefined) return false;
    row.monitoringEnabled = enabled;
    return true;
  }
  async saveSnapshot(projectId: string, snapshot: ProjectGitSnapshot, refreshedAt: string) {
    const row = this.rows.get(projectId);
    if (row === undefined) return;
    Object.assign(row, { snapshot, refreshedAt, error: null });
  }
  async saveError(projectId: string, reason: GitUnavailableReason, at: string) {
    const row = this.rows.get(projectId);
    if (row !== undefined) row.error = { reason, at };
  }
  async clearSnapshot(projectId: string) {
    const row = this.rows.get(projectId);
    if (row !== undefined) Object.assign(row, { snapshot: null, refreshedAt: null, error: null });
  }
}

function repository(root: string, overrides: Partial<GitRepositorySnapshot> = {}): GitStatus {
  return {
    state: 'repository',
    snapshot: {
      repositoryRoot: root,
      branch: 'main',
      detachedHead: false,
      unbornHead: false,
      identity: { name: 'Someone', email: 'someone@example.com' },
      localBranchCount: 1,
      recentBranches: [],
      changes: {
        modified: 0,
        staged: 0,
        untracked: 0,
        deleted: 0,
        renamed: 0,
        conflicted: 0,
        total: 0,
      },
      upstream: null,
      ahead: null,
      behind: null,
      upstreamGone: false,
      inspectedAt: new Date().toISOString(),
      ...overrides,
    },
  };
}

function setup(options: { projects?: number; maxConcurrentRefreshes?: number } = {}) {
  const store = new MemoryStore();
  const directories = new Map<string, ProjectDirectory>();
  for (let index = 0; index < (options.projects ?? 1); index += 1) {
    const id = `p${index}`;
    store.add(id);
    directories.set(id, { status: 'available', directory: `/repos/${id}` });
  }
  let active = 0;
  let peak = 0;
  const inspected: string[] = [];
  let respond: (directory: string) => Promise<GitStatus> = async (directory) =>
    repository(directory);
  const events: ProjectGitState[] = [];
  const watched = new Set<string>();
  const monitor = new ProjectGitMonitor({
    store,
    inspect: async (directory) => {
      inspected.push(directory);
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await respond(directory);
      } finally {
        active -= 1;
      }
    },
    projectDirectory: async (projectId) =>
      directories.get(projectId) ?? { status: 'removed' as const },
    watch: (root) => watched.add(root),
    unwatch: (root) => watched.delete(root),
    onChange: (state) => events.push(state),
    baseIntervalMs: 30_000,
    maxIntervalMs: 120_000,
    tickMs: 5_000,
    ...(options.maxConcurrentRefreshes !== undefined
      ? { maxConcurrentRefreshes: options.maxConcurrentRefreshes }
      : {}),
  });
  return {
    store,
    directories,
    monitor,
    inspected,
    events,
    watched,
    peak: () => peak,
    respondWith: (next: (directory: string) => Promise<GitStatus>) => (respond = next),
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('ProjectGitMonitor (SDD-024)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('refreshes monitored projects on start, stores the snapshot and reports it as live', async () => {
    const t = setup();
    t.respondWith(async (directory) =>
      repository(directory, {
        changes: {
          modified: 2,
          staged: 0,
          untracked: 1,
          deleted: 0,
          renamed: 0,
          conflicted: 0,
          total: 3,
        },
        upstream: 'origin/main',
        ahead: 1,
        behind: 4,
      }),
    );
    await t.monitor.start();
    await settle();

    const [state] = await t.monitor.states();
    expect(state).toMatchObject({
      projectId: 'p0',
      monitoringEnabled: true,
      freshness: 'live',
      refreshedAt: '2026-10-27T10:00:00.000Z',
      error: null,
      snapshot: {
        state: 'repository',
        branch: 'main',
        ahead: 1,
        behind: 4,
        upstream: 'origin/main',
      },
    });
    // Identity and branch lists are never kept.
    expect(JSON.stringify(t.store.rows.get('p0'))).not.toContain('someone@example.com');
    expect(t.watched).toEqual(new Set(['/repos/p0']));
    expect(t.events.at(-1)?.freshness).toBe('live');
    t.monitor.close();
  });

  it('never inspects projects with monitoring disabled in the background', async () => {
    const t = setup({ projects: 2 });
    t.store.rows.get('p1')!.monitoringEnabled = false;
    await t.monitor.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(t.inspected.every((directory) => directory === '/repos/p0')).toBe(true);
    expect(t.inspected.length).toBeGreaterThan(1);
    t.monitor.close();
  });

  it('stops automatic checks when disabled and keeps the last snapshot as cached', async () => {
    const t = setup();
    await t.monitor.start();
    await settle();
    const before = t.inspected.length;

    const state = await t.monitor.setMonitoring('p0', false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(t.inspected.length).toBe(before);
    expect(state).toMatchObject({ monitoringEnabled: false, freshness: 'cached' });
    expect(state.snapshot).not.toBeNull();
    expect(t.watched.size).toBe(0);
    t.monitor.close();
  });

  it('refreshes manually while disabled without changing the preference', async () => {
    const t = setup();
    t.store.rows.get('p0')!.monitoringEnabled = false;
    await t.monitor.start();
    expect(t.inspected).toEqual([]);

    const result = await t.monitor.refresh('p0');
    expect(result.status.state).toBe('repository');
    expect(result.state).toMatchObject({ monitoringEnabled: false, freshness: 'cached' });
    expect(result.state.snapshot).not.toBeNull();
    expect(t.inspected).toEqual(['/repos/p0']);
    // The manual refresh does not start watching or scheduling.
    expect(t.watched.size).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.inspected).toEqual(['/repos/p0']);
    t.monitor.close();
  });

  it('resumes automatic checks when enabled again', async () => {
    const t = setup();
    t.store.rows.get('p0')!.monitoringEnabled = false;
    await t.monitor.start();
    await t.monitor.setMonitoring('p0', true);
    await settle();
    expect(t.inspected).toEqual(['/repos/p0']);
    expect((await t.monitor.state('p0')).freshness).toBe('live');
    t.monitor.close();
  });

  it('keeps the last good snapshot when Git fails and reports the error', async () => {
    const t = setup();
    await t.monitor.start();
    await settle();
    t.respondWith(async () => ({
      state: 'unavailable',
      reason: 'timeout',
      inspectedAt: new Date().toISOString(),
    }));
    vi.setSystemTime(new Date('2026-10-27T10:01:00.000Z'));
    const { state } = await t.monitor.refresh('p0');

    expect(state).toMatchObject({
      freshness: 'cached',
      refreshedAt: '2026-10-27T10:00:00.000Z',
      error: { reason: 'timeout', at: '2026-10-27T10:01:00.000Z' },
    });
    expect(state.snapshot?.state).toBe('repository');
    t.monitor.close();
  });

  it('reports a folder that is not a repository, a missing upstream and an unavailable folder', async () => {
    const t = setup({ projects: 3 });
    t.directories.set('p2', { status: 'unavailable' });
    t.respondWith(async (directory) =>
      directory === '/repos/p0'
        ? { state: 'not-repository', inspectedAt: new Date().toISOString() }
        : repository(directory),
    );
    await t.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const states = new Map((await t.monitor.states()).map((state) => [state.projectId, state]));
    expect(states.get('p0')?.snapshot).toEqual({ state: 'not-repository' });
    expect(states.get('p1')?.snapshot).toMatchObject({ upstream: null, ahead: null, behind: null });
    expect(states.get('p2')).toMatchObject({
      freshness: 'none',
      error: { reason: 'directory-unavailable' },
    });
    expect(t.inspected).not.toContain('/repos/p2');
    t.monitor.close();
  });

  it('shares a running refresh instead of starting a second one for the same project', async () => {
    const t = setup();
    let release!: () => void;
    t.respondWith(async (directory) => {
      await new Promise<void>((done) => (release = done));
      return repository(directory);
    });
    t.store.rows.get('p0')!.monitoringEnabled = false;
    await t.monitor.start();
    const first = t.monitor.refresh('p0');
    const second = t.monitor.refresh('p0');
    await settle();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(t.inspected).toEqual(['/repos/p0']);
    expect(a).toBe(b);
    t.monitor.close();
  });

  it('discards an automatic result when monitoring was disabled meanwhile', async () => {
    const t = setup();
    let release!: () => void;
    t.respondWith(async (directory) => {
      await new Promise<void>((done) => (release = done));
      return repository(directory);
    });
    await t.monitor.start();
    await settle();
    await t.monitor.setMonitoring('p0', false);
    release();
    await settle();

    expect(t.store.rows.get('p0')?.snapshot).toBeNull();
    expect(t.watched.size).toBe(0);
    t.monitor.close();
  });

  it('does not hand a discarded automatic result to a later manual refresh', async () => {
    const t = setup();
    const releases: (() => void)[] = [];
    t.respondWith(async (directory) => {
      await new Promise<void>((done) => releases.push(done));
      return repository(directory);
    });
    await t.monitor.start();
    await settle();
    await t.monitor.setMonitoring('p0', false);
    const manual = t.monitor.refresh('p0');
    await settle();
    for (const release of releases) release();

    expect((await manual).state.snapshot).not.toBeNull();
    expect(t.inspected).toHaveLength(2);
    t.monitor.close();
  });

  it('runs nothing automatically before start', async () => {
    const t = setup();
    await t.monitor.setMonitoring('p0', true);
    await t.monitor.projectAdded('p0', true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.inspected).toEqual([]);
  });

  it('backs off while nothing changes and refreshes at once after a repository change', async () => {
    const t = setup();
    await t.monitor.start();
    await settle();
    expect(t.inspected).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.inspected).toHaveLength(2);
    // Unchanged: the next check waits 60 s, then 120 s (the maximum).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.inspected).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(t.inspected).toHaveLength(3);

    t.monitor.repositoryChanged('/repos/p0');
    await settle();
    expect(t.inspected).toHaveLength(4);
    t.monitor.repositoryChanged('/somewhere/else');
    await settle();
    expect(t.inspected).toHaveLength(4);
    t.monitor.close();
  });

  it('keeps watching a repository shared by another monitored project', async () => {
    const t = setup({ projects: 2 });
    t.directories.set('p1', { status: 'available', directory: '/repos/p0' });
    await t.monitor.start();
    await settle();
    expect(t.watched).toEqual(new Set(['/repos/p0']));

    await t.monitor.setMonitoring('p1', false);
    expect(t.watched).toEqual(new Set(['/repos/p0']));
    await t.monitor.setMonitoring('p0', false);
    expect(t.watched.size).toBe(0);
    t.monitor.close();
  });

  it('checks again soon when the repository changed during a refresh', async () => {
    const t = setup();
    const releases: (() => void)[] = [];
    await t.monitor.start();
    await settle();
    t.respondWith(async (directory) => {
      await new Promise<void>((done) => releases.push(done));
      return repository(directory);
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.inspected).toHaveLength(2);
    t.monitor.repositoryChanged('/repos/p0');
    releases.shift()!();
    await settle();
    // Without the change it would wait 60 s; it runs on the next tick instead.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.inspected).toHaveLength(3);
    for (const release of releases) release();
    t.monitor.close();
  });

  it('bounds automatic refreshes for large registries', async () => {
    const t = setup({ projects: 200, maxConcurrentRefreshes: 2 });
    t.respondWith(async (directory) => {
      await new Promise((done) => setTimeout(done, 10));
      return repository(directory);
    });
    await t.monitor.start();
    expect(t.monitor.activeRefreshes).toBeLessThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(t.peak()).toBeLessThanOrEqual(2);
    expect(new Set(t.inspected).size).toBe(200);
    expect(t.inspected).toHaveLength(200);
    t.monitor.close();
  });

  it('forgets removed projects and clears the snapshot of a moved project', async () => {
    const t = setup({ projects: 2 });
    await t.monitor.start();
    await settle();

    const removedChecks = () => t.inspected.filter((directory) => directory === '/repos/p0');
    const beforeRemoval = removedChecks().length;
    t.monitor.projectRemoved('p0');
    t.store.rows.delete('p0');
    t.directories.delete('p0');
    expect(t.watched.has('/repos/p0')).toBe(false);
    await expect(t.monitor.refresh('p0')).rejects.toBeInstanceOf(AtlasError);

    t.directories.set('p1', { status: 'available', directory: '/repos/moved' });
    await t.monitor.projectMoved('p1');
    expect(t.watched.has('/repos/p1')).toBe(false);
    await settle();
    expect(t.inspected.at(-1)).toBe('/repos/moved');
    expect(t.watched.has('/repos/moved')).toBe(true);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(removedChecks()).toHaveLength(beforeRemoval);
    t.monitor.close();
  });

  it('applies the new-project default and stops everything on close', async () => {
    const t = setup();
    await t.monitor.start();
    await settle();
    t.store.add('n1', true);
    t.directories.set('n1', { status: 'available', directory: '/repos/n1' });
    await t.monitor.projectAdded('n1', false);
    await settle();
    expect(t.store.rows.get('n1')?.monitoringEnabled).toBe(false);
    expect(t.inspected).not.toContain('/repos/n1');

    t.monitor.close();
    const count = t.inspected.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.inspected).toHaveLength(count);
  });

  it('reports unknown projects as not found', async () => {
    const t = setup();
    await expect(t.monitor.setMonitoring('nope', true)).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(t.monitor.state('nope')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});
