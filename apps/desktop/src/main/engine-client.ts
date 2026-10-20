import type { EngineMethod, EngineMethodParams, EngineMethodResults } from '@atlas/contracts';
import { fromSerialized, type EngineEventMessage } from '@atlas/engine';
import { AtlasError, type Logger } from '@atlas/shared';
import type { UtilityProcess } from 'electron';
import type { HostToMainMessage, MainToHostMessage } from '../shared/engine-host-protocol';

/** Spawns the Engine host process; injectable so tests can provide a fake. */
export type ForkEngineHost = () => UtilityProcess;

export interface EngineHostClientOptions {
  fork: ForkEngineHost;
  dataDir: string;
  appVersion: string;
  logger: Logger;
  onEvent: (message: EngineEventMessage) => void;
  /** Called after the host crashed and a new one is ready. */
  onRestarted: () => void;
  /** Called when the host crashed too often and is no longer restarted. */
  onGaveUp: () => void;
}

/** Desktop-facing calls into the Engine; implemented by the utility process client. */
export interface EngineCaller {
  call<M extends EngineMethod>(
    method: M,
    ...params: EngineMethodParams<M>
  ): Promise<EngineMethodResults[M]>;
}

const STOP_TIMEOUT_MS = 8000;
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 3;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/**
 * Talks to the Engine host utility process. Requests are correlated by id; the
 * host is restarted when it crashes (its terminals are lost and the restarted
 * Engine marks them accordingly).
 */
export class EngineHostClient implements EngineCaller {
  private child: UtilityProcess | undefined;
  private ready: Promise<void> | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stopping = false;
  private restarts: number[] = [];

  constructor(private readonly options: EngineHostClientOptions) {}

  /** Starts the host and resolves once it is ready; rejects if it failed to start. */
  start(): Promise<void> {
    this.ready = new Promise<void>((resolve, reject) => {
      const child = this.options.fork();
      this.child = child;
      let started = false;

      child.on('message', (message: HostToMainMessage) => {
        switch (message.type) {
          case 'ready':
            started = true;
            resolve();
            break;
          case 'start-failed':
            reject(fromSerialized(message.error));
            break;
          case 'response':
            this.settle(
              message.id,
              message.ok ? { result: message.result } : { error: message.error },
            );
            break;
          case 'event':
            this.options.onEvent(message);
            break;
          case 'stopped':
            break;
        }
      });
      child.on('exit', (code) => {
        if (this.child === child) this.child = undefined;
        this.rejectAll(new AtlasError('ENGINE_UNAVAILABLE', 'The Engine process exited.'));
        if (!started) {
          reject(new AtlasError('ENGINE_UNAVAILABLE', 'The Engine process exited during startup.'));
          return;
        }
        if (!this.stopping) this.handleCrash(code);
      });
      this.post({
        type: 'start',
        dataDir: this.options.dataDir,
        appVersion: this.options.appVersion,
      });
    });
    return this.ready;
  }

  async call<M extends EngineMethod>(
    method: M,
    ...params: EngineMethodParams<M>
  ): Promise<EngineMethodResults[M]> {
    await this.ready;
    if (this.child === undefined) {
      throw new AtlasError('ENGINE_UNAVAILABLE', 'The Engine process is not running.');
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.post({ type: 'request', id, method, params });
    });
  }

  /** Asks the host to terminate its terminals and exit; kills it after a timeout. */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child === undefined) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.options.logger.warn('Engine host did not stop in time; killing it');
        child.kill();
      }, STOP_TIMEOUT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.post({ type: 'shutdown' });
    });
  }

  private handleCrash(code: number): void {
    const now = Date.now();
    this.restarts = this.restarts.filter((time) => now - time < RESTART_WINDOW_MS);
    this.options.logger.error('Engine host exited unexpectedly', {
      exitCode: code,
      recentRestarts: this.restarts.length,
    });
    if (this.restarts.length >= MAX_RESTARTS_PER_WINDOW) {
      this.options.onGaveUp();
      return;
    }
    this.restarts.push(now);
    this.start().then(
      () => {
        this.options.logger.info('Engine host restarted');
        this.options.onRestarted();
      },
      () => this.options.onGaveUp(),
    );
  }

  private settle(
    id: number,
    outcome: { result: unknown } | { error: Parameters<typeof fromSerialized>[0] },
  ): void {
    const request = this.pending.get(id);
    if (request === undefined) return;
    this.pending.delete(id);
    if ('error' in outcome) request.reject(fromSerialized(outcome.error));
    else request.resolve(outcome.result);
  }

  private rejectAll(error: AtlasError): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private post(message: MainToHostMessage): void {
    this.child?.postMessage(message);
  }
}
