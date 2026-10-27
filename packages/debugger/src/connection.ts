import { AtlasError } from '@atlas/shared';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { DapMessageReader, encodeDapMessage, protocolError } from './framing.js';

/** Default time an adapter has to answer a request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface DapConnectionOptions {
  /** Writes framed bytes to the adapter's standard input. */
  write: (data: Buffer) => void;
  onEvent: (event: DebugProtocol.Event) => void;
  /** The stream broke (invalid framing or JSON); the connection is closed. */
  onProtocolError: (error: AtlasError) => void;
  maxMessageBytes?: number;
}

interface Pending {
  command: string;
  resolve: (response: DebugProtocol.Response) => void;
  reject: (error: AtlasError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The client side of one Debug Adapter Protocol connection: numbered requests matched to
 * their responses by `request_seq`, with a timeout each, and events delivered in order.
 * Requests the adapter sends to the client (`runInTerminal`, `startDebugging`) are
 * refused: ATLAS does not run anything on an adapter's behalf.
 */
export class DapConnection {
  private seq = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly reader: DapMessageReader;
  private closed: AtlasError | null = null;

  constructor(private readonly options: DapConnectionOptions) {
    this.reader = new DapMessageReader(options.maxMessageBytes);
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  /** Bytes from the adapter's standard output. */
  receive(chunk: Buffer): void {
    if (this.closed !== null) return;
    let messages: unknown[];
    try {
      messages = this.reader.push(chunk);
    } catch (error) {
      const failure = error instanceof AtlasError ? error : protocolError('unreadable');
      this.close(failure);
      this.options.onProtocolError(failure);
      return;
    }
    for (const message of messages) this.dispatch(message);
  }

  private dispatch(message: unknown): void {
    if (!isRecord(message)) return;
    switch (message.type) {
      case 'response': {
        const pending = this.pending.get(message.request_seq as number);
        if (pending === undefined) return; // Late answer to a request that timed out.
        this.pending.delete(message.request_seq as number);
        clearTimeout(pending.timer);
        pending.resolve(message as unknown as DebugProtocol.Response);
        return;
      }
      case 'event':
        if (typeof message.event === 'string') {
          this.options.onEvent(message as unknown as DebugProtocol.Event);
        }
        return;
      case 'request':
        this.send({
          type: 'response',
          request_seq: message.seq,
          success: false,
          command: message.command,
          message: 'ATLAS does not support this request.',
        });
        return;
      default:
        return;
    }
  }

  private send(message: Record<string, unknown>): void {
    this.options.write(encodeDapMessage({ ...message, seq: this.seq++ }));
  }

  /**
   * Sends a request and settles with the adapter's response, successful or not. Rejects
   * with DEBUG_TIMEOUT, or with the closing error when the connection closes first.
   */
  request(
    command: string,
    args?: object,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<DebugProtocol.Response> {
    if (this.closed !== null) return Promise.reject(this.closed);
    const seq = this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(
          new AtlasError('DEBUG_TIMEOUT', `No answer to ${command}.`, { details: { command } }),
        );
      }, timeoutMs);
      this.pending.set(seq, { command, resolve, reject, timer });
      try {
        this.send({ type: 'request', command, ...(args === undefined ? {} : { arguments: args }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(
          new AtlasError('DEBUG_ADAPTER_FAILED', 'Could not write to the adapter.', {
            cause: error,
          }),
        );
      }
    });
  }

  /** Rejects every pending request; later requests fail at once. Idempotent. */
  close(reason: AtlasError): void {
    if (this.closed !== null) return;
    this.closed = reason;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}
