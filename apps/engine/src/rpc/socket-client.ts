import net from 'node:net';
import type { EngineMethod, EngineMethodParams, EngineMethodResults } from '@atlas/contracts';
import { AtlasError, ERROR_CODES, USER_MESSAGES, type SerializedError } from '@atlas/shared';
import { readRunFile } from './endpoint.js';
import {
  ENGINE_PROTOCOL_VERSION,
  LineDecoder,
  encodeMessage,
  type EngineResponseMessage,
} from './protocol.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface EngineSocketClient {
  call<M extends EngineMethod>(
    method: M,
    ...params: EngineMethodParams<M>
  ): Promise<EngineMethodResults[M]>;
  close(): void;
}

export interface ConnectOptions {
  dataDir: string;
  /** Applies to connecting and to each request. */
  timeoutMs?: number;
}

/**
 * Connects to the running Engine. Throws ENGINE_UNAVAILABLE when no Engine is
 * running for the data directory or it refuses the connection.
 */
export async function connectToEngine(options: ConnectOptions): Promise<EngineSocketClient> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const info = await readRunFile(options.dataDir);
  if (info === null) throw unavailable('no-run-file');

  const socket = net.connect(info.endpoint);
  socket.setEncoding('utf8');
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }
  >();
  let nextId = 1;
  let welcomed: (() => void) | undefined;

  const failAll = (error: AtlasError) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const decoder = new LineDecoder((message) => {
    const value = message as { type?: string };
    if (value.type === 'welcome') {
      welcomed?.();
      return;
    }
    if (value.type !== 'response') return;
    const response = message as EngineResponseMessage;
    const request = pending.get(response.id);
    if (request === undefined) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.ok) request.resolve(response.result);
    else request.reject(fromSerialized(response.error));
  });
  socket.on('data', (chunk: string) => {
    if (!decoder.push(chunk)) socket.destroy();
  });
  socket.on('close', () => failAll(unavailable('connection-closed')));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(unavailable('connect-timeout'));
    }, timeoutMs);
    welcomed = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(unavailable('connect-failed', error));
    });
    socket.once('close', () => {
      clearTimeout(timer);
      reject(unavailable('rejected'));
    });
    socket.once('connect', () => {
      socket.write(
        encodeMessage({ type: 'hello', protocol: ENGINE_PROTOCOL_VERSION, token: info.token }),
      );
    });
  });
  socket.on('error', () => socket.destroy());

  return {
    call(method, ...params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(unavailable('request-timeout'));
        }, timeoutMs);
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
        socket.write(encodeMessage({ type: 'request', id, method, params }));
      });
    },
    close() {
      socket.destroy();
    },
  };
}

function unavailable(reason: string, cause?: unknown): AtlasError {
  return new AtlasError('ENGINE_UNAVAILABLE', undefined, { details: { reason }, cause });
}

/** Rebuilds an AtlasError from the Engine's user-safe serialized form. */
export function fromSerialized(error: SerializedError): AtlasError {
  const code = ERROR_CODES.includes(error.code) ? error.code : 'INTERNAL_ERROR';
  return new AtlasError(code, error.message ?? USER_MESSAGES[code], { issues: error.issues ?? [] });
}
