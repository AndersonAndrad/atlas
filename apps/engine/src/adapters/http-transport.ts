import { createReadStream, createWriteStream, openAsBlob, type WriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http, { type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import zlib from 'node:zlib';
import type {
  HttpExchangeRequest,
  HttpExchangeResponse,
  HttpOutgoingBody,
  HttpTransport,
} from '@atlas/api-workbench';
import { AtlasError } from '@atlas/shared';

/** Bytes kept to recognize a text body. */
const HEAD_BYTES = 8192;

interface PreparedBody {
  stream: Readable | null;
  bytes: Uint8Array | null;
  length: number | null;
  /** Set by the body itself, e.g. the multipart boundary. */
  contentType: string | null;
}

const TLS_ERROR = /CERT|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL|EPROTO|HOSTNAME_MISMATCH/;
const CONNECTION_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/** Classifies a Node error; never includes the URL or headers (FR-1429). */
export function transportError(error: unknown): AtlasError {
  if (error instanceof AtlasError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
  const details = { code };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') {
    return new AtlasError('HTTP_DNS_FAILED', undefined, { cause: error, details });
  }
  if (CONNECTION_ERRORS.has(code)) {
    return new AtlasError('HTTP_CONNECTION_FAILED', undefined, { cause: error, details });
  }
  if (TLS_ERROR.test(code))
    return new AtlasError('HTTP_TLS_FAILED', undefined, { cause: error, details });
  return new AtlasError('HTTP_TRANSPORT_FAILED', undefined, { cause: error, details });
}

/** Ordered pairs as Node headers: repeated names become arrays, the first spelling wins. */
function toNodeHeaders(pairs: readonly [string, string][]): OutgoingHttpHeaders {
  const headers: Record<string, string | string[]> = {};
  const spelling = new Map<string, string>();
  for (const [name, value] of pairs) {
    const key = spelling.get(name.toLowerCase()) ?? name;
    spelling.set(name.toLowerCase(), key);
    const previous = headers[key];
    headers[key] = previous === undefined ? value : [...[previous].flat(), value];
  }
  return headers;
}

function decoderFor(
  encoding: string | undefined,
): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  switch (encoding?.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

async function prepareBody(body: HttpOutgoingBody): Promise<PreparedBody> {
  switch (body.kind) {
    case 'none':
      return { stream: null, bytes: null, length: null, contentType: null };
    case 'bytes':
      return { stream: null, bytes: body.data, length: body.data.byteLength, contentType: null };
    case 'file': {
      const info = await stat(body.path).catch(() => null);
      if (info === null || !info.isFile()) throw new AtlasError('HTTP_FILE_UNAVAILABLE');
      return {
        stream: createReadStream(body.path),
        bytes: null,
        length: info.size,
        contentType: null,
      };
    }
    case 'multipart': {
      const form = new FormData();
      for (const part of body.parts) {
        if (part.kind === 'text') {
          form.append(part.name, part.value);
        } else {
          const blob = await openAsBlob(part.path, { type: part.contentType ?? '' }).catch(() => {
            throw new AtlasError('HTTP_FILE_UNAVAILABLE');
          });
          form.append(part.name, blob, part.fileName);
        }
      }
      // The platform encoder streams the files and chooses the boundary.
      const encoded = new Request('http://atlas.invalid/', { method: 'POST', body: form });
      return {
        stream: Readable.fromWeb(encoded.body as WebReadableStream<Uint8Array>),
        bytes: null,
        length: null,
        contentType: encoded.headers.get('content-type'),
      };
    }
  }
}

/**
 * HTTP/1.1 exchanges over Node's own client (SDD-014 §2.1). Each exchange opens its own
 * connection, so the measured phases are real; redirects are followed by the service.
 */
export class NodeHttpTransport implements HttpTransport {
  async inspectFile(path: string): Promise<{ size: number } | null> {
    const info = await stat(path).catch(() => null);
    return info?.isFile() ? { size: info.size } : null;
  }

  async exchange(request: HttpExchangeRequest): Promise<HttpExchangeResponse> {
    request.signal.throwIfAborted();
    const body = await prepareBody(request.body);
    let pairs = [...request.headers];
    const has = (name: string) => pairs.some(([key]) => key.toLowerCase() === name);
    if (body.contentType !== null) {
      pairs = pairs.filter(([key]) => key.toLowerCase() !== 'content-type');
      pairs.push(['Content-Type', body.contentType]);
    }
    if (body.length !== null && !has('content-length')) {
      pairs.push(['Content-Length', String(body.length)]);
    }
    const client = request.protocol === 'https:' ? https : http;
    return new Promise<HttpExchangeResponse>((resolve, reject) => {
      const started = performance.now();
      let dnsAt: number | null = null;
      let connectAt: number | null = null;
      let tlsAt: number | null = null;
      let sink: WriteStream | null = null;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        sink?.destroy();
        outgoing.destroy();
        body.stream?.destroy();
        reject(transportError(error));
      };
      const outgoing = client.request({
        method: request.method,
        hostname: request.hostname,
        port: request.port,
        path: request.path,
        headers: toNodeHeaders(pairs),
        // A new connection per exchange: no reuse that would hide connection phases.
        agent: false,
        // Verification is on unless this request turned it off explicitly (FR-1408).
        rejectUnauthorized: request.verifyTls,
        signal: request.signal,
      });
      const sentHeaders = (): [string, string][] =>
        outgoing.getRawHeaderNames().flatMap((name) => {
          const value = outgoing.getHeader(name);
          const values = Array.isArray(value) ? value : value === undefined ? [] : [String(value)];
          return values.map((item): [string, string] => [name, item]);
        });
      outgoing.on('socket', (socket) => {
        socket.once('lookup', () => (dnsAt = performance.now()));
        socket.once('connect', () => (connectAt = performance.now()));
        socket.once('secureConnect', () => (tlsAt = performance.now()));
      });
      outgoing.on('error', fail);
      outgoing.on('response', (response: IncomingMessage) => {
        const firstByteAt = performance.now();
        const headers: [string, string][] = [];
        for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) {
          headers.push([response.rawHeaders[i]!, response.rawHeaders[i + 1]!]);
        }
        let transferred = 0;
        let kept = 0;
        let truncated = false;
        const head: Buffer[] = [];
        let headBytes = 0;
        response.on('data', (chunk: Buffer) => (transferred += chunk.length));
        const decoder = decoderFor(response.headers['content-encoding']);
        const source: Readable = decoder ? response.pipe(decoder) : response;
        const out = createWriteStream(request.bodyFile, { flags: 'w', mode: 0o600 });
        sink = out;
        const phase = (from: number | null, to: number | null) =>
          from === null || to === null ? null : Math.round(to - from);
        const sendStart = tlsAt ?? connectAt ?? started;
        const finish = () => {
          if (settled) return;
          settled = true;
          const doneAt = performance.now();
          out.end(() =>
            resolve({
              status: response.statusCode ?? 0,
              statusText: response.statusMessage ?? '',
              httpVersion: `HTTP/${response.httpVersion}`,
              headers,
              sentHeaders: sentHeaders(),
              dnsMs: phase(started, dnsAt),
              connectMs: phase(dnsAt ?? started, connectAt),
              tlsMs: phase(connectAt, tlsAt),
              firstByteMs: phase(sendStart, firstByteAt),
              downloadMs: phase(firstByteAt, doneAt),
              bodyBytes: kept,
              transferredBytes: transferred,
              truncated,
              head: new Uint8Array(Buffer.concat(head)),
            }),
          );
        };
        source.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = request.maxBodyBytes - kept;
          const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
          if (headBytes < HEAD_BYTES) {
            const slice = part.subarray(0, HEAD_BYTES - headBytes);
            head.push(slice);
            headBytes += slice.length;
          }
          kept += part.length;
          const writable = out.write(part);
          if (chunk.length > room) {
            // Over the limit: keep the beginning and stop reading (FR-1407).
            truncated = true;
            finish();
            response.destroy();
            return;
          }
          if (!writable) {
            source.pause();
            out.once('drain', () => source.resume());
          }
        });
        source.on('end', finish);
        source.on('error', (error) =>
          fail(
            decoder !== null && error !== undefined && !request.signal.aborted
              ? new AtlasError('HTTP_TRANSPORT_FAILED', 'The response could not be decoded.', {
                  cause: error,
                })
              : error,
          ),
        );
        response.on('error', fail);
        // The connection ended before the whole body arrived.
        response.on('close', () => {
          if (!response.complete) fail(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
        });
        out.on('error', fail);
      });
      if (body.stream !== null) {
        body.stream.on('error', fail);
        body.stream.pipe(outgoing);
      } else {
        outgoing.end(body.bytes ?? undefined);
      }
    });
  }
}
