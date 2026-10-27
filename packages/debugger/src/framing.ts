import { AtlasError } from '@atlas/shared';

/** Largest DAP message body accepted from an adapter (16 MB). */
export const DAP_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;
/** Largest header block accepted before the blank line. */
const HEADER_MAX_BYTES = 8 * 1024;
const SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');

/** A message that breaks the Debug Adapter Protocol's wire format. */
export function protocolError(reason: string): AtlasError {
  return new AtlasError('DEBUG_ADAPTER_FAILED', 'Invalid DAP message.', { details: { reason } });
}

/** A DAP message with its `Content-Length` header (base protocol). */
export function encodeDapMessage(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Splits an adapter's output into DAP messages, whatever the chunk boundaries are. Headers
 * other than `Content-Length` are ignored, as the protocol allows. After an error the
 * reader stays failed: the stream can no longer be trusted.
 */
export class DapMessageReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private failed: AtlasError | null = null;

  constructor(private readonly maxBytes = DAP_MESSAGE_MAX_BYTES) {}

  /** Adds a chunk and returns the complete messages it finished. */
  push(chunk: Buffer): unknown[] {
    if (this.failed !== null) throw this.failed;
    try {
      return this.read(chunk);
    } catch (error) {
      this.failed = error instanceof AtlasError ? error : protocolError('unreadable');
      this.buffer = Buffer.alloc(0);
      throw this.failed;
    }
  }

  private read(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      const end = this.buffer.indexOf(SEPARATOR);
      if (end < 0) {
        if (this.buffer.length > HEADER_MAX_BYTES) throw protocolError('header too long');
        return messages;
      }
      if (end > HEADER_MAX_BYTES) throw protocolError('header too long');
      const length = contentLength(this.buffer.subarray(0, end).toString('ascii'));
      if (length > this.maxBytes) throw protocolError('message too large');
      const start = end + SEPARATOR.length;
      if (this.buffer.length < start + length) return messages;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        throw protocolError('invalid JSON');
      }
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        throw protocolError('not an object');
      }
      messages.push(message);
    }
  }
}

function contentLength(header: string): number {
  let length: number | null = null;
  for (const line of header.split('\r\n')) {
    const match = /^content-length:\s*(\d{1,10})\s*$/i.exec(line);
    if (match) {
      if (length !== null) throw protocolError('repeated Content-Length');
      length = Number(match[1]);
    }
  }
  if (length === null) throw protocolError('missing Content-Length');
  return length;
}
