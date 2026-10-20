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
