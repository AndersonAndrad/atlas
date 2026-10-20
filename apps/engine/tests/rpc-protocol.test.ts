import { describe, expect, it } from 'vitest';
import {
  LineDecoder,
  MAX_SOCKET_MESSAGE_BYTES,
  encodeMessage,
  engineEndpoint,
  isRequestMessage,
} from '../src/index.js';

describe('Engine socket protocol', () => {
  it('decodes newline-delimited JSON split across chunks', () => {
    const messages: unknown[] = [];
    const decoder = new LineDecoder((message) => messages.push(message));
    const wire = encodeMessage({ a: 1 }) + encodeMessage({ b: 'x\ny' });
    expect(decoder.push(wire.slice(0, 5))).toBe(true);
    expect(decoder.push(wire.slice(5))).toBe(true);
    expect(messages).toEqual([{ a: 1 }, { b: 'x\ny' }]);
  });

  it('rejects invalid JSON and oversized messages', () => {
    expect(new LineDecoder(() => undefined).push('not json\n')).toBe(false);
    expect(new LineDecoder(() => undefined).push('x'.repeat(MAX_SOCKET_MESSAGE_BYTES + 1))).toBe(
      false,
    );
  });

  it('recognizes only well-formed requests', () => {
    expect(isRequestMessage({ type: 'request', id: 1, method: 'engine.status', params: [] })).toBe(
      true,
    );
    for (const value of [
      null,
      'x',
      { type: 'request', id: '1', method: 'm', params: [] },
      { type: 'request', id: 1.5, method: 'm', params: [] },
      { type: 'request', id: 1, method: 'm', params: {} },
      { type: 'hello', id: 1, method: 'm', params: [] },
    ]) {
      expect(isRequestMessage(value)).toBe(false);
    }
  });

  it('uses a private socket path, a short fallback, or a named pipe', () => {
    expect(engineEndpoint('/Users/me/Library/Application Support/ATLAS', 'darwin')).toBe(
      '/Users/me/Library/Application Support/ATLAS/run/engine.sock',
    );
    const long = engineEndpoint(`/tmp/${'x'.repeat(120)}`, 'darwin');
    expect(long).toMatch(/atlas-[0-9a-f]{16}\.sock$/);
    expect(Buffer.byteLength(long)).toBeLessThan(104);
    expect(engineEndpoint('C:\\Users\\me\\AppData\\Roaming\\ATLAS', 'win32')).toMatch(
      /^\\\\\.\\pipe\\atlas-engine-[0-9a-f]{16}$/,
    );
  });
});
