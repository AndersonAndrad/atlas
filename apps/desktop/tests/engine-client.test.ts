import { EventEmitter } from 'node:events';
import type { UtilityProcess } from 'electron';
import { noopLogger } from '@atlas/shared';
import { describe, expect, it, vi } from 'vitest';
import { EngineHostClient } from '../src/main/engine-client.js';
import type { MainToHostMessage } from '../src/shared/engine-host-protocol.js';

type Behavior = 'ready' | 'fail' | 'exit-on-start';

/** Simulates the Engine host utility process. */
class FakeHost extends EventEmitter {
  readonly received: MainToHostMessage[] = [];
  killed = false;
  constructor(
    private readonly behavior: Behavior,
    private readonly answerShutdown = true,
  ) {
    super();
  }
  postMessage(message: MainToHostMessage): void {
    this.received.push(message);
    queueMicrotask(() => {
      if (message.type === 'start') {
        if (this.behavior === 'ready') this.emit('message', { type: 'ready' });
        if (this.behavior === 'fail') {
          this.emit('message', {
            type: 'start-failed',
            error: { code: 'PROJECT_PERSISTENCE_ERROR', message: 'x', issues: [] },
          });
        }
        if (this.behavior === 'exit-on-start') this.crash(1);
      } else if (message.type === 'request') {
        if (message.method === 'engine.status') {
          this.emit('message', { type: 'response', id: message.id, ok: true, result: { pid: 1 } });
        } else {
          this.emit('message', {
            type: 'response',
            id: message.id,
            ok: false,
            error: { code: 'TERMINAL_NOT_FOUND', message: 'gone', issues: [] },
          });
        }
      } else if (message.type === 'shutdown' && this.answerShutdown) {
        this.emit('message', { type: 'stopped' });
        this.crash(0);
      }
    });
  }
  kill(): boolean {
    this.killed = true;
    this.crash(1);
    return true;
  }
  crash(code: number): void {
    this.emit('exit', code);
  }
}

function setup(behaviors: Behavior[], answerShutdown = true) {
  const hosts: FakeHost[] = [];
  const onRestarted = vi.fn();
  const onGaveUp = vi.fn();
  const onEvent = vi.fn();
  const client = new EngineHostClient({
    fork: () => {
      const host = new FakeHost(behaviors[hosts.length] ?? 'ready', answerShutdown);
      hosts.push(host);
      return host as unknown as UtilityProcess;
    },
    dataDir: '/data',
    appVersion: '0.2.0',
    logger: noopLogger,
    onEvent,
    onRestarted,
    onGaveUp,
  });
  return { client, hosts, onRestarted, onGaveUp, onEvent };
}

describe('EngineHostClient', () => {
  it('starts the host with the data directory and correlates requests', async () => {
    const { client, hosts } = setup(['ready']);
    await client.start();
    expect(hosts[0]!.received[0]).toEqual({ type: 'start', dataDir: '/data', appVersion: '0.2.0' });
    await expect(client.call('engine.status')).resolves.toEqual({ pid: 1 });
    await expect(
      client.call('terminals.get', '00000000-0000-4000-8000-000000000001'),
    ).rejects.toMatchObject({ code: 'TERMINAL_NOT_FOUND' });
  });

  it('rejects startup failures and early exits', async () => {
    await expect(setup(['fail']).client.start()).rejects.toMatchObject({
      code: 'PROJECT_PERSISTENCE_ERROR',
    });
    await expect(setup(['exit-on-start']).client.start()).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
    });
  });

  it('forwards events', async () => {
    const { client, hosts, onEvent } = setup(['ready']);
    await client.start();
    const message = { type: 'event', event: { type: 'removed', sessionId: 's', projectId: 'p' } };
    hosts[0]!.emit('message', message);
    expect(onEvent).toHaveBeenCalledWith(message);
  });

  it('fails pending requests and restarts the host after a crash', async () => {
    const { client, hosts, onRestarted } = setup(['ready', 'ready']);
    await client.start();
    // A request that never gets an answer is rejected when the host dies.
    hosts[0]!.postMessage = function (this: FakeHost, message: MainToHostMessage) {
      this.received.push(message);
    } as never;
    const pending = client.call('engine.status');
    await vi.waitFor(() => expect(hosts[0]!.received.at(-1)).toMatchObject({ type: 'request' }));
    hosts[0]!.crash(1);
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    await vi.waitFor(() => expect(onRestarted).toHaveBeenCalledOnce());
    expect(hosts).toHaveLength(2);
    await expect(client.call('engine.status')).resolves.toEqual({ pid: 1 });
  });

  it('gives up after repeated crashes', async () => {
    const { client, hosts, onRestarted, onGaveUp } = setup(['ready', 'ready', 'ready', 'ready']);
    await client.start();
    for (let index = 0; index < 4; index += 1) {
      hosts.at(-1)!.crash(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(onRestarted).toHaveBeenCalledTimes(3);
    expect(onGaveUp).toHaveBeenCalledOnce();
    await expect(client.call('engine.status')).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
    });
  });

  it('stops gracefully without restarting, and kills an unresponsive host', async () => {
    const graceful = setup(['ready']);
    await graceful.client.start();
    await graceful.client.stop();
    expect(graceful.hosts[0]!.received.at(-1)).toEqual({ type: 'shutdown' });
    expect(graceful.hosts).toHaveLength(1);
    expect(graceful.onRestarted).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      const stuck = setup(['ready'], false);
      await stuck.client.start();
      const stopping = stuck.client.stop();
      await vi.advanceTimersByTimeAsync(8000);
      await stopping;
      expect(stuck.hosts[0]!.killed).toBe(true);
      expect(stuck.hosts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
