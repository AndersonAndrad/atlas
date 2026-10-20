import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import {
  AtlasError,
  describeError,
  noopLogger,
  toSerializedError,
  type Logger,
} from '@atlas/shared';
import type { EngineDispatcher } from './dispatcher.js';
import { ensureRunDirectory, engineEndpoint, removeRunFile, writeRunFile } from './endpoint.js';
import {
  ENGINE_PROTOCOL_VERSION,
  LineDecoder,
  encodeMessage,
  isRequestMessage,
  type EngineHelloMessage,
  type EngineResponseMessage,
} from './protocol.js';

const AUTH_TIMEOUT_MS = 2000;
const MAX_CONNECTIONS = 16;

export interface EngineSocketServerOptions {
  dataDir: string;
  platform: NodeJS.Platform;
  dispatcher: EngineDispatcher;
  logger?: Logger;
}

export interface EngineSocketServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

/**
 * Serves CLI clients on a user-private local endpoint. Each connection must
 * first present the random token stored in the 0600 run file; afterwards it may
 * call the CLI allow-list of Engine methods.
 */
export async function startEngineSocketServer(
  options: EngineSocketServerOptions,
): Promise<EngineSocketServer> {
  const logger = options.logger ?? noopLogger;
  const { dataDir, platform, dispatcher } = options;
  ensureRunDirectory(dataDir, platform);
  const endpoint = engineEndpoint(dataDir, platform);
  if (platform !== 'win32' && existsSync(endpoint)) {
    if (await isEndpointAlive(endpoint)) {
      throw new AtlasError('INTERNAL_ERROR', 'Another ATLAS Engine is already running.', {
        details: { endpoint },
      });
    }
    // Left behind by an Engine that did not exit cleanly.
    rmSync(endpoint, { force: true });
  }

  const token = randomBytes(32).toString('base64url');
  const tokenDigest = digest(token);
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    if (sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');

    let authenticated = false;
    const authTimer = setTimeout(() => {
      logger.warn('Engine socket client did not authenticate in time');
      socket.destroy();
    }, AUTH_TIMEOUT_MS);
    const send = (message: object) => {
      if (!socket.destroyed) socket.write(encodeMessage(message));
    };

    const decoder = new LineDecoder((message) => {
      if (!authenticated) {
        clearTimeout(authTimer);
        if (!isValidHello(message, tokenDigest)) {
          logger.warn('Rejected Engine socket client with an invalid token');
          socket.destroy();
          return;
        }
        authenticated = true;
        send({ type: 'welcome', protocol: ENGINE_PROTOCOL_VERSION });
        return;
      }
      if (!isRequestMessage(message)) {
        socket.destroy();
        return;
      }
      void dispatcher.call(message.method, message.params, 'cli').then(
        (result) => send({ type: 'response', id: message.id, ok: true, result }),
        (error: unknown) => {
          const serialized = toSerializedError(error);
          const level = serialized.code === 'INTERNAL_ERROR' ? 'error' : 'info';
          logger[level]('Engine socket request failed', {
            method: message.method,
            error: describeError(error),
          });
          send({
            type: 'response',
            id: message.id,
            ok: false,
            error: serialized,
          } satisfies EngineResponseMessage);
        },
      );
    });
    socket.on('data', (chunk: string) => {
      if (!decoder.push(chunk)) socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (platform !== 'win32') chmodSync(endpoint, 0o600);
  await writeRunFile(dataDir, {
    protocol: ENGINE_PROTOCOL_VERSION,
    pid: process.pid,
    endpoint,
    token,
  });
  logger.info('Engine socket listening');

  let closed = false;
  return {
    endpoint,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeRunFile(dataDir, token).catch(() => undefined);
    },
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function isValidHello(message: unknown, tokenDigest: Buffer): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const hello = message as Partial<EngineHelloMessage>;
  if (hello.type !== 'hello' || hello.protocol !== ENGINE_PROTOCOL_VERSION) return false;
  if (typeof hello.token !== 'string' || hello.token.length > 256) return false;
  return timingSafeEqual(digest(hello.token), tokenDigest);
}

function isEndpointAlive(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(endpoint);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}
