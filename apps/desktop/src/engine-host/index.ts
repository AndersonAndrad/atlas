import path from 'node:path';
import { FileLogger, isRequestMessage, startEngineHost, type EngineHost } from '@atlas/engine';
import { describeError, noopLogger, toSerializedError, type Logger } from '@atlas/shared';
import type { HostToMainMessage, MainToHostMessage } from '../shared/engine-host-protocol';

/**
 * Entry point of the Engine host, an Electron utility process. It owns the
 * database and every terminal process, keeping PTY work off the main thread,
 * and serves the CLI through the authenticated local socket.
 */
const parentPort = process.parentPort;
let host: EngineHost | undefined;
/** Available once main sent the data directory; used for crash diagnostics. */
let crashLogger: Logger = noopLogger;
const send = (message: HostToMainMessage) => parentPort.postMessage(message);

// stdio is not captured, so fatal errors must reach the log file before exiting.
// Exiting lets the main process restart the Engine host.
process.on('uncaughtException', (error) => {
  crashLogger.error('Engine host crashed', { error: describeError(error) });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  crashLogger.error('Engine host crashed (unhandled rejection)', {
    error: describeError(reason),
  });
  process.exit(1);
});

async function start(dataDir: string, appVersion: string): Promise<void> {
  crashLogger = new FileLogger({
    filePath: path.join(dataDir, 'logs', 'atlas.log'),
    component: 'engine',
  });
  try {
    host = await startEngineHost({ dataDir, component: 'engine', terminals: { appVersion } });
    host.onTerminalEvent((event, subscriberId) =>
      send(
        subscriberId === undefined
          ? { type: 'event', event }
          : { type: 'event', event, subscriberId },
      ),
    );
    send({ type: 'ready' });
  } catch (error) {
    crashLogger.error('Engine host failed to start', { error: describeError(error) });
    send({ type: 'start-failed', error: toSerializedError(error) });
  }
}

async function shutdown(): Promise<void> {
  try {
    await host?.stop();
  } finally {
    send({ type: 'stopped' });
    process.exit(0);
  }
}

parentPort.on('message', (event: Electron.MessageEvent) => {
  const message = event.data as MainToHostMessage;
  if (message.type === 'start') {
    void start(message.dataDir, message.appVersion);
    return;
  }
  if (message.type === 'shutdown') {
    void shutdown();
    return;
  }
  if (!isRequestMessage(message) || host === undefined) return;
  void host.dispatcher.call(message.method, message.params, 'desktop').then(
    (result) => send({ type: 'response', id: message.id, ok: true, result }),
    (error: unknown) => {
      const serialized = toSerializedError(error);
      const level =
        serialized.code === 'INTERNAL_ERROR' || serialized.code === 'PROJECT_PERSISTENCE_ERROR'
          ? 'error'
          : 'info';
      host?.engine.logger[level]('Engine request failed', {
        method: message.method,
        error: describeError(error),
      });
      send({ type: 'response', id: message.id, ok: false, error: serialized });
    },
  );
});
