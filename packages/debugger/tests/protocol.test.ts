import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DapConnection,
  DapMessageReader,
  canTransition,
  encodeDapMessage,
  isFinal,
} from '../src/index.js';

const frame = (body: string, header = `Content-Length: ${Buffer.byteLength(body)}`) =>
  Buffer.from(`${header}\r\n\r\n${body}`, 'utf8');

describe('DapMessageReader', () => {
  it('reads messages split across chunks and several in one chunk', () => {
    const reader = new DapMessageReader();
    const bytes = Buffer.concat([
      encodeDapMessage({ type: 'event', event: 'a' }),
      encodeDapMessage({ type: 'event', event: 'ç✓' }),
    ]);
    const messages: unknown[] = [];
    for (const byte of bytes) messages.push(...reader.push(Buffer.from([byte])));
    expect(messages).toEqual([
      { type: 'event', event: 'a' },
      { type: 'event', event: 'ç✓' },
    ]);
    expect(reader.push(bytes)).toHaveLength(2);
  });

  it('ignores other headers and counts bytes, not characters', () => {
    const body = '{"type":"event","event":"é"}';
    const reader = new DapMessageReader();
    expect(
      reader.push(
        frame(body, `Content-Type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}`),
      ),
    ).toEqual([{ type: 'event', event: 'é' }]);
  });

  it.each([
    ['a missing Content-Length', frame('{}', 'Content-Type: x')],
    ['a repeated Content-Length', frame('{}', 'Content-Length: 2\r\nContent-Length: 2')],
    ['a non-numeric length', frame('{}', 'Content-Length: two')],
    ['invalid JSON', frame('{nope}')],
    ['a body that is not an object', frame('[1]')],
    ['a header without end', Buffer.from(`Content-Length: 1${' '.repeat(9000)}`)],
  ])('fails on %s and stays failed', (_case, bytes) => {
    const reader = new DapMessageReader();
    expect(() => reader.push(bytes)).toThrow(
      expect.objectContaining({ code: 'DEBUG_ADAPTER_FAILED' }),
    );
    expect(() => reader.push(encodeDapMessage({ type: 'event' }))).toThrow();
  });

  it('refuses a message larger than the limit before buffering it', () => {
    const reader = new DapMessageReader(100);
    expect(() => reader.push(Buffer.from('Content-Length: 101\r\n\r\n'))).toThrow(
      expect.objectContaining({ code: 'DEBUG_ADAPTER_FAILED' }),
    );
  });
});

describe('DapConnection', () => {
  afterEach(() => vi.useRealTimers());

  function connection() {
    const written: Record<string, unknown>[] = [];
    const events: unknown[] = [];
    const errors: unknown[] = [];
    const reader = new DapMessageReader();
    const dap = new DapConnection({
      write: (data) => written.push(...(reader.push(data) as Record<string, unknown>[])),
      onEvent: (event) => events.push(event),
      onProtocolError: (error) => errors.push(error),
    });
    const reply = (request: Record<string, unknown>, body: object, success = true) =>
      dap.receive(
        encodeDapMessage({
          seq: 100,
          type: 'response',
          request_seq: request.seq,
          command: request.command,
          success,
          body,
        }),
      );
    return { dap, written, events, errors, reply };
  }

  it('matches responses to requests by sequence number, in any order', async () => {
    const { dap, written, reply } = connection();
    const first = dap.request('threads');
    const second = dap.request('stackTrace', { threadId: 1 });
    expect(written.map((message) => [message.seq, message.command])).toEqual([
      [1, 'threads'],
      [2, 'stackTrace'],
    ]);
    expect(written[1]).toMatchObject({ type: 'request', arguments: { threadId: 1 } });
    reply(written[1]!, { stackFrames: [] });
    reply(written[0]!, { threads: [] }, false);
    await expect(second).resolves.toMatchObject({ success: true, body: { stackFrames: [] } });
    await expect(first).resolves.toMatchObject({ success: false, command: 'threads' });
  });

  it('times out a request and ignores its late answer', async () => {
    vi.useFakeTimers();
    const { dap, written, reply } = connection();
    const pending = dap.request('evaluate', {}, 1000);
    vi.advanceTimersByTime(1000);
    await expect(pending).rejects.toMatchObject({ code: 'DEBUG_TIMEOUT' });
    expect(() => reply(written[0]!, {})).not.toThrow();
  });

  it('delivers events and refuses requests from the adapter', () => {
    const { dap, written, events } = connection();
    dap.receive(
      encodeDapMessage({ seq: 1, type: 'event', event: 'output', body: { output: 'x' } }),
    );
    dap.receive(
      encodeDapMessage({ seq: 2, type: 'request', command: 'runInTerminal', arguments: {} }),
    );
    expect(events).toEqual([{ seq: 1, type: 'event', event: 'output', body: { output: 'x' } }]);
    expect(written).toEqual([
      expect.objectContaining({
        type: 'response',
        request_seq: 2,
        command: 'runInTerminal',
        success: false,
      }),
    ]);
  });

  it('closes on a protocol error, rejecting pending and later requests', async () => {
    const { dap, errors } = connection();
    const pending = dap.request('threads');
    dap.receive(Buffer.from('Content-Length: x\r\n\r\n'));
    await expect(pending).rejects.toMatchObject({ code: 'DEBUG_ADAPTER_FAILED' });
    await expect(dap.request('threads')).rejects.toMatchObject({ code: 'DEBUG_ADAPTER_FAILED' });
    expect(errors).toHaveLength(1);
    expect(dap.isClosed).toBe(true);
  });

  it('reports a write failure as an adapter failure', async () => {
    const dap = new DapConnection({
      write: () => {
        throw new Error('EPIPE');
      },
      onEvent: () => undefined,
      onProtocolError: () => undefined,
    });
    await expect(dap.request('threads')).rejects.toMatchObject({ code: 'DEBUG_ADAPTER_FAILED' });
  });
});

describe('session states', () => {
  it.each([
    ['CREATED', 'STARTING', true],
    ['STARTING', 'RUNNING', true],
    ['RUNNING', 'PAUSED', true],
    ['PAUSED', 'RUNNING', true],
    ['RUNNING', 'TERMINATING', true],
    ['TERMINATING', 'TERMINATED', true],
    ['STARTING', 'FAILED', true],
    ['CREATED', 'RUNNING', false],
    ['TERMINATED', 'RUNNING', false],
    ['FAILED', 'TERMINATED', false],
    ['RUNNING', 'STARTING', false],
  ] as const)('%s → %s allowed: %s', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });

  it('knows the final states', () => {
    expect(isFinal('TERMINATED')).toBe(true);
    expect(isFinal('FAILED')).toBe(true);
    expect(isFinal('PAUSED')).toBe(false);
  });
});
