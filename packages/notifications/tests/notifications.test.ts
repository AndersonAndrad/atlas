import type {
  AtlasNotification,
  GitOperation,
  PreflightCheckResult,
  PreflightRun,
} from '@atlas/contracts';
import {
  NotificationService,
  gitOperationNotification,
  plainText,
  preflightRunNotification,
  type NotificationRepository,
} from '@atlas/notifications';
import { noopLogger } from '@atlas/shared';
import { describe, expect, it } from 'vitest';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** In-memory repository with the same semantics as the SQLite one. */
class MemoryRepository implements NotificationRepository {
  items: AtlasNotification[] = [];
  failInsert = false;
  async insert(notification: AtlasNotification) {
    if (this.failInsert) throw new Error('disk full');
    this.items.push(structuredClone(notification));
  }
  async list({ unreadOnly, limit }: { unreadOnly: boolean; limit: number }) {
    return [...this.items]
      .reverse()
      .filter((item) => !unreadOnly || !item.read)
      .slice(0, limit);
  }
  async unreadCount() {
    return this.items.filter((item) => !item.read).length;
  }
  async markRead(target: string, at: string) {
    const item = this.items.find((candidate) => candidate.id === target);
    if (item === undefined) return false;
    if (!item.read) Object.assign(item, { read: true, readAt: at });
    return true;
  }
  async markAllRead(at: string) {
    for (const item of this.items) if (!item.read) Object.assign(item, { read: true, readAt: at });
  }
  async remove(target: string) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== target);
    return this.items.length < before;
  }
  async clear() {
    this.items = [];
  }
  prunes: { readBefore: string; keep: number }[] = [];
  async prune(options: { readBefore: string; keep: number }) {
    this.prunes.push(options);
    return 0;
  }
}

function setup() {
  const repository = new MemoryRepository();
  const changes: (AtlasNotification | null)[] = [];
  const warnings: string[] = [];
  let next = 0;
  const service = new NotificationService({
    repository,
    clock: { now: () => new Date('2026-10-23T12:00:00.000Z') },
    generateId: () => id(++next),
    logger: { ...noopLogger, warn: (message) => warnings.push(message) },
    onChange: (created) => changes.push(created),
  });
  return { repository, service, changes, warnings };
}

const operation = (overrides: Partial<GitOperation> = {}): GitOperation => ({
  id: id(50),
  kind: 'commit',
  repositoryRoot: '/repo',
  status: 'succeeded',
  startedAt: '2026-10-23T11:59:00.000Z',
  finishedAt: '2026-10-23T12:00:00.000Z',
  progress: null,
  summary: 'Committed abc1234.',
  error: null,
  cancellable: false,
  steps: null,
  ...overrides,
});

const result = (status: PreflightCheckResult['status']): PreflightCheckResult => ({
  position: 0,
  checkId: 'lint',
  name: 'Lint',
  type: 'COMMAND',
  category: 'LINT',
  required: true,
  method: 'LOCAL_SHELL',
  reference: 'pnpm lint',
  status,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  exitCode: null,
  detail: null,
  environment: 'Local shell (/bin/sh)',
  digest: 'a'.repeat(64),
  outputLines: 0,
  outputTruncated: false,
});

const run = (status: PreflightRun['status'], results: PreflightCheckResult[]): PreflightRun => ({
  id: id(60),
  workspaceId: id(61),
  projectId: id(62),
  workspacePath: '/repo',
  profileId: null,
  profileName: 'Quick',
  trigger: 'MANUAL',
  status,
  requiredOutcome: 'NONE',
  sourceRevision: null,
  branch: null,
  sourceStateFingerprint: null,
  sourceChangedDuringRun: false,
  retryOf: null,
  startedAt: '2026-10-23T11:00:00.000Z',
  finishedAt: '2026-10-23T11:05:00.000Z',
  results,
});

describe('NotificationService', () => {
  it('publishes plain-text notifications, reports the change and prunes', async () => {
    const { service, repository, changes } = setup();
    const created = await service.publish({
      type: 'ERROR',
      category: 'GIT',
      title: 'Commit\nfailed\u0007',
      message: `  ${'x'.repeat(600)}  `,
      sourceName: 'atlas',
      action: { type: 'git-operation', repositoryRoot: '/repo', operationId: id(50) },
    });
    expect(created).toMatchObject({
      id: id(1),
      title: 'Commit failed',
      read: false,
      readAt: null,
      projectId: null,
      createdAt: '2026-10-23T12:00:00.000Z',
    });
    expect(created!.message).toHaveLength(500);
    expect(created!.message.endsWith('…')).toBe(true);
    expect(changes).toEqual([created]);
    expect(repository.prunes).toEqual([{ readBefore: '2026-09-23T12:00:00.000Z', keep: 1000 }]);
    expect(await service.list()).toEqual({ items: [created], unread: 1 });
  });

  it('never throws when publishing fails and drops invalid destinations', async () => {
    const { service, repository, changes, warnings } = setup();
    expect(
      await service.publish({
        type: 'INFO',
        category: 'SYSTEM',
        title: 'Open',
        message: '',
        action: { type: 'url', target: 'https://example.com' } as never,
      }),
    ).toBeNull();
    repository.failInsert = true;
    expect(
      await service.publish({ type: 'INFO', category: 'SYSTEM', title: 'x', message: '' }),
    ).toBeNull();
    expect(repository.items).toEqual([]);
    expect(changes).toEqual([]);
    expect(warnings).toEqual([
      'Notification could not be published',
      'Notification could not be published',
    ]);
  });

  it('marks read, marks all read, dismisses and clears', async () => {
    const { service, changes } = setup();
    const first = await service.publish({
      type: 'INFO',
      category: 'SYSTEM',
      title: 'A',
      message: '',
    });
    await service.publish({ type: 'INFO', category: 'SYSTEM', title: 'B', message: '' });
    await service.markAsRead(first!.id);
    expect(await service.unreadCount()).toBe(1);
    await expect(service.markAsRead(id(99))).rejects.toMatchObject({
      code: 'NOTIFICATION_NOT_FOUND',
    });
    await service.markAllAsRead();
    expect((await service.list({ unreadOnly: true })).items).toEqual([]);
    await service.dismiss(first!.id);
    await expect(service.dismiss(first!.id)).rejects.toMatchObject({
      code: 'NOTIFICATION_NOT_FOUND',
    });
    await service.clear();
    expect(await service.list()).toEqual({ items: [], unread: 0 });
    // Two publications, then read, all read, dismiss and clear.
    expect(changes.slice(2)).toEqual([null, null, null, null]);
  });

  it('keeps working when the change listener throws', async () => {
    const repository = new MemoryRepository();
    const service = new NotificationService({
      repository,
      clock: { now: () => new Date() },
      generateId: () => id(1),
      logger: noopLogger,
      onChange: () => {
        throw new Error('renderer gone');
      },
    });
    expect(
      await service.publish({ type: 'INFO', category: 'SYSTEM', title: 'A', message: '' }),
    ).not.toBeNull();
  });
});

describe('plainText', () => {
  it('collapses whitespace and control characters and caps the length', () => {
    expect(plainText(' a\t\nb\u0000c ', 10)).toBe('a b c');
    expect(plainText('abcdef', 4)).toBe('abc…');
  });
});

describe('gitOperationNotification', () => {
  const context = { projectId: id(70), sourceName: 'atlas' };

  it('reports finished commits, pushes and pulls with where they lead', () => {
    expect(gitOperationNotification(operation(), context)).toEqual({
      type: 'SUCCESS',
      category: 'GIT',
      title: 'Commit created',
      message: 'Committed abc1234.',
      projectId: id(70),
      sourceName: 'atlas',
      taskId: id(50),
      action: { type: 'git-operation', repositoryRoot: '/repo', operationId: id(50) },
    });
    expect(
      gitOperationNotification(
        operation({
          kind: 'push',
          status: 'failed',
          summary: null,
          error: { code: 'rejected', message: 'The remote refused the push.', output: 'secret' },
        }),
        context,
      ),
    ).toMatchObject({
      type: 'ERROR',
      title: 'Push failed',
      message: 'The remote refused the push.',
    });
  });

  it('asks for action on conflicts and never includes Git output', () => {
    const input = gitOperationNotification(
      operation({
        kind: 'pull',
        status: 'failed',
        error: { code: 'conflict', message: 'Merge conflicts in 2 files.', output: 'CONFLICT …' },
      }),
      context,
    );
    expect(input).toMatchObject({
      type: 'ACTION_REQUIRED',
      title: 'Pull failed: resolve the conflicts',
      message: 'Merge conflicts in 2 files.',
    });
    expect(JSON.stringify(input)).not.toContain('CONFLICT');
  });

  it('skips running, cancelled and routine operations and successful fetches', () => {
    expect(gitOperationNotification(operation({ status: 'running' }), context)).toBeNull();
    expect(gitOperationNotification(operation({ status: 'cancelled' }), context)).toBeNull();
    expect(gitOperationNotification(operation({ kind: 'stage' }), context)).toBeNull();
    expect(gitOperationNotification(operation({ kind: 'fetch' }), context)).toBeNull();
    expect(gitOperationNotification(operation({ kind: 'merge' }), context)).toBeNull();
    expect(
      gitOperationNotification(
        operation({
          kind: 'fetch',
          status: 'failed',
          error: { code: 'network', message: 'Offline.', output: null },
        }),
        context,
      ),
    ).toMatchObject({ type: 'ERROR', title: 'Fetch failed' });
  });
});

describe('preflightRunNotification', () => {
  const context = { projectId: id(62), sourceName: 'WiiAscend' };

  it('summarizes passed, failed and incomplete runs and leads to the run', () => {
    expect(preflightRunNotification(run('PASSED', [result('PASSED')]), context)).toEqual({
      type: 'SUCCESS',
      category: 'PREFLIGHT',
      title: 'Preflight passed',
      message: 'Quick: 1 of 1 check passed.',
      projectId: id(62),
      sourceName: 'WiiAscend',
      taskId: id(60),
      action: { type: 'preflight-run', workspaceId: id(61), runId: id(60) },
    });
    expect(
      preflightRunNotification(
        run('FAILED', [result('PASSED'), result('FAILED'), result('TIMED_OUT'), result('SKIPPED')]),
        context,
      ),
    ).toMatchObject({
      type: 'ERROR',
      title: 'Preflight failed',
      message: 'Quick: 1 of 4 checks passed, 2 failed, 1 did not run.',
    });
    expect(preflightRunNotification(run('INCOMPLETE', [result('BLOCKED')]), context)).toMatchObject(
      { type: 'WARNING', title: 'Preflight incomplete' },
    );
  });

  it('skips runs that are still running or were cancelled', () => {
    expect(preflightRunNotification(run('RUNNING', []), context)).toBeNull();
    expect(preflightRunNotification(run('CANCELLED', []), context)).toBeNull();
  });
});
