import { describeError } from '@atlas/shared';
import type { TerminalEventListener } from '@atlas/terminal';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import { createEngineDispatcher, type EngineDispatcher } from './rpc/dispatcher.js';
import { startEngineSocketServer, type EngineSocketServer } from './rpc/socket-server.js';

export interface EngineHostOptions extends EngineOptions {
  /** Serve CLI clients on the local authenticated endpoint (default true). */
  socket?: boolean;
}

/** A long-lived Engine that owns terminal processes and serves local clients. */
export interface EngineHost {
  readonly engine: Engine;
  readonly dispatcher: EngineDispatcher;
  readonly socket: EngineSocketServer | undefined;
  onTerminalEvent(listener: TerminalEventListener): () => void;
  /** Terminates terminals, stops serving clients and closes the database. */
  stop(): Promise<void>;
}

export async function startEngineHost(options: EngineHostOptions = {}): Promise<EngineHost> {
  const engine = createEngine({ ...options, terminals: options.terminals ?? {} });
  let socket: EngineSocketServer | undefined;
  try {
    await engine.initialize();
    const dispatcher = createEngineDispatcher(engine);
    if (options.socket !== false) {
      socket = await startEngineSocketServer({
        dataDir: engine.dataDir,
        platform: options.platform ?? process.platform,
        dispatcher,
        logger: engine.logger,
      });
    }
    engine.logger.info('Engine host started', { schemaVersion: engine.schemaVersion() });

    let stopping: Promise<void> | undefined;
    return {
      engine,
      dispatcher,
      socket,
      onTerminalEvent: (listener) => engine.terminals!.onEvent(listener),
      stop: () => {
        stopping ??= (async () => {
          try {
            await socket?.close();
          } catch (error) {
            engine.logger.warn('Failed to close Engine socket', { error: describeError(error) });
          }
          await engine.shutdown();
          engine.logger.info('Engine host stopped');
        })();
        return stopping;
      },
    };
  } catch (error) {
    await socket?.close().catch(() => undefined);
    engine.close();
    throw error;
  }
}
