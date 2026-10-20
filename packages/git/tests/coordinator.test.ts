import { describe, expect, it } from 'vitest';
import type { GitOperation } from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import { GitCommandError, GitOperationCoordinator, GitOperationFailure } from '../src/index.js';

function setup(options: { historyLimit?: number } = {}) {
  let next = 0;
  const events: GitOperation[] = [];
  const coordinator = new GitOperationCoordinator({
    generateId: () => `op-${(next += 1)}`,
    onChange: (operation) => events.push(operation),
    progressIntervalMs: 0,
    ...options,
  });
  return { coordinator, events };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}

const request = (
  kind: GitOperation['kind'],
  lanes: ('index' | 'remote')[],
  cancellable = false,
) => ({
  repositoryRoot: '/repo',
  kind,
  lanes,
  cancellable,
});

describe('GitOperationCoordinator', () => {
  it('serializes operations that share a lane and runs other lanes concurrently', async () => {
    const { coordinator } = setup();
    const order: string[] = [];
    const gate = deferred();
    const commit = coordinator.run(request('commit', ['index']), async () => {
      order.push('commit:start');
      await gate.promise;
      order.push('commit:end');
      return { summary: 'ok', value: 1 };
    });
    const stage = coordinator.run(request('stage', ['index']), async () => {
      order.push('stage');
      return { summary: 'ok', value: 2 };
    });
    const fetch = coordinator.run(request('fetch', ['remote']), async () => {
      order.push('fetch');
      return { summary: 'ok', value: 3 };
    });
    await fetch;
    expect(order).toEqual(['commit:start', 'fetch']);
    expect(coordinator.isBusy('/repo')).toBe(true);
    gate.resolve();
    await Promise.all([commit, stage]);
    expect(order).toEqual(['commit:start', 'fetch', 'commit:end', 'stage']);
    expect(coordinator.isBusy('/repo')).toBe(false);
  });

  it('reports progress and reports expected failures on the operation', async () => {
    const { coordinator, events } = setup();
    const outcome = await coordinator.run(request('push', ['remote']), async ({ progress }) => {
      progress('Writing objects:  50% (1/2)');
      progress('not progress');
      throw new GitOperationFailure('rejected', 'Rejected.', 'output');
    });
    expect(outcome.value).toBeNull();
    expect(outcome.operation).toMatchObject({
      status: 'failed',
      error: { code: 'rejected', message: 'Rejected.', output: 'output' },
      cancellable: false,
    });
    expect(events.some((event) => event.progress?.percent === 50)).toBe(true);
  });

  it('cancels queued operations before they start and running cancellable ones', async () => {
    const { coordinator } = setup();
    const gate = deferred();
    const blocker = coordinator.run(request('commit', ['index']), async () => {
      await gate.promise;
      return { summary: 'ok', value: null };
    });
    let ran = false;
    const queued = coordinator.run(request('stage', ['index']), async () => {
      ran = true;
      return { summary: 'ok', value: null };
    });
    const queuedId = coordinator.list().find((op) => op.kind === 'stage')!.id;
    coordinator.cancel(queuedId);
    gate.resolve();
    await blocker;
    expect((await queued).operation.status).toBe('cancelled');
    expect(ran).toBe(false);

    const fetch = coordinator.run(
      request('fetch', ['remote'], true),
      ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () =>
            reject(new GitCommandError('cancelled', 'cancelled')),
          ),
        ),
    );
    await until(() =>
      coordinator.list().some((op) => op.kind === 'fetch' && op.status === 'running'),
    );
    const running = coordinator.list().find((op) => op.kind === 'fetch')!;
    coordinator.cancel(running.id);
    expect((await fetch).operation.status).toBe('cancelled');
  });

  it('settles a queued operation as soon as it is cancelled and keeps the others in order', async () => {
    const { coordinator } = setup();
    const gate = deferred();
    const order: string[] = [];
    const blocker = coordinator.run(request('commit', ['index']), async () => {
      await gate.promise;
      order.push('commit');
      return { summary: 'ok', value: null };
    });
    const cancelled = coordinator.run(request('pull', ['index', 'remote']), async () => {
      order.push('pull');
      return { summary: 'ok', value: null };
    });
    const next = coordinator.run(request('stage', ['index']), async () => {
      order.push('stage');
      return { summary: 'ok', value: null };
    });
    const pullId = coordinator.list().find((op) => op.kind === 'pull')!.id;

    expect(coordinator.cancel(pullId)).toMatchObject({ status: 'cancelled', cancellable: false });
    // Settles while the lane is still held by the blocker.
    expect((await cancelled).operation).toMatchObject({
      status: 'cancelled',
      summary: 'Cancelled before it started.',
    });
    expect(coordinator.list().find((op) => op.id === pullId)?.status).toBe('cancelled');
    // The remote lane it had already taken is free again.
    expect(
      (
        await coordinator.run(request('fetch', ['remote']), async () => ({
          summary: 'ok',
          value: 'fetched',
        }))
      ).value,
    ).toBe('fetched');

    gate.resolve();
    await Promise.all([blocker, next]);
    expect(order).toEqual(['commit', 'stage']);
    expect(coordinator.isBusy('/repo')).toBe(false);
  });

  it('cancels everything that is safe to stop and waits for running operations', async () => {
    const { coordinator } = setup();
    const gate = deferred();
    const pull = coordinator.run(request('pull', ['index', 'remote']), async () => {
      await gate.promise;
      return { summary: 'ok', value: null };
    });
    const fetch = coordinator.run(
      { ...request('fetch', ['remote'], true), repositoryRoot: '/other' },
      ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () =>
            reject(new GitCommandError('cancelled', 'cancelled')),
          ),
        ),
    );
    const queued = coordinator.run(request('stage', ['index']), async () => ({
      summary: 'ok',
      value: null,
    }));
    await until(() => coordinator.list().filter((op) => op.status === 'running').length === 2);

    coordinator.cancelAll();
    expect((await fetch).operation.status).toBe('cancelled');
    expect((await queued).operation.status).toBe('cancelled');
    // The pull cannot be interrupted: it keeps running and `idle` times out.
    expect(await coordinator.idle(10)).toBe(false);
    gate.resolve();
    expect(await coordinator.idle(1000)).toBe(true);
    expect((await pull).operation.status).toBe('succeeded');
    expect(await coordinator.idle(0)).toBe(true);
  });

  it('stops accepting operations once closed, letting running ones finish', async () => {
    const { coordinator, events } = setup();
    const gate = deferred();
    const commit = coordinator.run(request('commit', ['index']), async () => {
      await gate.promise;
      return { summary: 'committed', value: 'hash' };
    });
    await until(() => coordinator.list()[0]?.status === 'running');

    coordinator.close();
    expect(coordinator.closing).toBe(true);
    let ran = false;
    const push = await coordinator.run(request('push', ['remote']), async () => {
      ran = true;
      return { summary: 'pushed', value: null };
    });
    expect(ran).toBe(false);
    expect(push.operation).toMatchObject({
      status: 'cancelled',
      summary: 'Cancelled because ATLAS is shutting down.',
    });
    expect(events.filter((event) => event.id === push.operation.id).at(-1)?.status).toBe(
      'cancelled',
    );
    // The commit cannot be interrupted and keeps running until it settles.
    expect(await coordinator.idle(10)).toBe(false);
    gate.resolve();
    expect((await commit).operation.status).toBe('succeeded');
    expect(await coordinator.idle(1000)).toBe(true);
  });

  it('refuses to cancel running operations that are not safe to interrupt', async () => {
    const { coordinator } = setup();
    const gate = deferred();
    const pull = coordinator.run(request('pull', ['index', 'remote']), async () => {
      await gate.promise;
      return { summary: 'ok', value: null };
    });
    await until(() => coordinator.list()[0]?.status === 'running');
    const id = coordinator.list()[0]!.id;
    expect(() => coordinator.cancel(id)).toThrow(AtlasError);
    expect(() => coordinator.cancel('missing')).toThrow(AtlasError);
    gate.resolve();
    expect((await pull).operation.status).toBe('succeeded');
  });

  it('rethrows validation errors and hides unexpected ones behind a generic failure', async () => {
    const { coordinator } = setup();
    await expect(
      coordinator.run(request('commit', ['index']), async () => {
        throw new AtlasError('GIT_INDEX_CHANGED');
      }),
    ).rejects.toMatchObject({ code: 'GIT_INDEX_CHANGED' });
    expect(coordinator.list()[0]!.status).toBe('failed');
    // A field issue explains the failure on the operation more precisely.
    await expect(
      coordinator.run(request('commit', ['index']), async () => {
        throw new AtlasError('GIT_INDEX_CHANGED', 'changed', {
          issues: [{ field: 'selection', message: 'Selected files changed.' }],
        });
      }),
    ).rejects.toMatchObject({ code: 'GIT_INDEX_CHANGED' });
    expect(coordinator.list()[1]!.error?.message).toBe('Selected files changed.');

    const outcome = await coordinator.run(request('stage', ['index']), async () => {
      throw new Error('boom /secret/path');
    });
    expect(outcome.operation.error).toEqual({
      code: 'unavailable',
      message: 'Git could not complete the operation.',
      output: null,
    });
    // The lane is released after failures.
    expect(
      (
        await coordinator.run(request('stage', ['index']), async () => ({
          summary: 'ok',
          value: 1,
        }))
      ).value,
    ).toBe(1);
  });

  it('keeps a bounded history of finished operations', async () => {
    const { coordinator } = setup({ historyLimit: 2 });
    for (let i = 0; i < 4; i += 1) {
      await coordinator.run(request('stage', ['index']), async () => ({ summary: 'ok', value: i }));
    }
    expect(coordinator.list().map((op) => op.id)).toEqual(['op-3', 'op-4']);
  });
});
