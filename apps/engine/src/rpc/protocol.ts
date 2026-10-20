import type { TerminalEvent } from '@atlas/contracts';
import type { SerializedError } from '@atlas/shared';

export const ENGINE_PROTOCOL_VERSION = 1;

/** Upper bound for one newline-delimited JSON message on the local socket. */
export const MAX_SOCKET_MESSAGE_BYTES = 2 * 1024 * 1024;

export interface EngineRequestMessage {
  type: 'request';
  id: number;
  method: string;
  params: unknown[];
}

export type EngineResponseMessage =
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: SerializedError };

export interface EngineEventMessage {
  type: 'event';
  event: TerminalEvent;
  /** Set for output events, which are addressed to one attached view. */
  subscriberId?: string;
}

/** First message a socket client sends; the token comes from the 0600 run file. */
export interface EngineHelloMessage {
  type: 'hello';
  protocol: number;
  token: string;
}

export interface EngineWelcomeMessage {
  type: 'welcome';
  protocol: number;
}

export function isRequestMessage(value: unknown): value is EngineRequestMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<EngineRequestMessage>;
  return (
    message.type === 'request' &&
    typeof message.id === 'number' &&
    Number.isSafeInteger(message.id) &&
    typeof message.method === 'string' &&
    Array.isArray(message.params)
  );
}

/**
 * Splits a byte stream into newline-delimited JSON messages. Returns false when
 * the peer exceeded the size limit or sent invalid JSON; the caller must then
 * drop the connection.
 */
export class LineDecoder {
  private buffer = '';

  constructor(private readonly onMessage: (message: unknown) => void) {}

  push(chunk: string): boolean {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== '') {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return false;
        }
        this.onMessage(message);
      }
      newline = this.buffer.indexOf('\n');
    }
    return Buffer.byteLength(this.buffer) <= MAX_SOCKET_MESSAGE_BYTES;
  }
}

export function encodeMessage(message: object): string {
  return `${JSON.stringify(message)}\n`;
}
