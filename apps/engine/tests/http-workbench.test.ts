import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpWorkbenchService } from '@atlas/api-workbench';
import {
  emptyHttpRequestDefinition,
  type HttpExecutionResult,
  type HttpRequestDefinition,
} from '@atlas/contracts';
import { SqliteHttpWorkbenchRepository, openDatabase, type Database } from '@atlas/persistence';
import { AtlasError, noopLogger } from '@atlas/shared';
import { createTempDir } from '../../../tests/support/temp.js';
import { MemoryCookieJars } from '../src/adapters/http-cookies.js';
import { FileHttpResponses } from '../src/adapters/http-response-files.js';
import { NodeHttpTransport } from '../src/adapters/http-transport.js';

// SDD-014 Milestone A against real local HTTP and HTTPS servers; nothing leaves 127.0.0.1.

const readAll = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

function routes(otherOrigin: () => string) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const body = await readAll(request);
    const json = (
      status: number,
      value: unknown,
      headers: Record<string, string | string[]> = {},
    ) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(value));
    };
    switch (url.pathname) {
      case '/users':
        return json(200, { data: [{ id: 1, name: 'Example User' }], total: 1 });
      case '/echo':
        return json(200, {
          method: request.method,
          path: request.url,
          headers: request.headers,
          rawHeaders: request.rawHeaders,
          body: body.toString('utf8'),
          bytes: body.length,
        });
      case '/status':
        return json(Number(url.searchParams.get('code')), { error: 'nope' });
      case '/redirect': {
        const to = url.searchParams.get('to') ?? '/echo';
        response.writeHead(Number(url.searchParams.get('code') ?? 302), {
          Location: to === 'other' ? `${otherOrigin()}/echo` : to,
        });
        return response.end('moved');
      }
      case '/loop':
        response.writeHead(302, { Location: '/loop' });
        return response.end();
      case '/cookies/set':
        response.writeHead(200, {
          'Set-Cookie': ['session=abc123; Path=/; HttpOnly', 'theme=dark; Path=/cookies'],
        });
        return response.end('ok');
      case '/cookies/echo':
        return json(200, { cookie: request.headers.cookie ?? null });
      case '/big':
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        for (let i = 0; i < 64; i += 1) response.write('x'.repeat(64 * 1024));
        return response.end();
      case '/gzip':
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
        return response.end(zlib.gzipSync(JSON.stringify({ compressed: true })));
      case '/slow':
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.write('started');
        return; // never ends
      case '/hang':
        return; // never answers
      case '/binary':
        response.writeHead(200, { 'Content-Type': 'image/png' });
        return response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
      default:
        return json(404, { error: 'not found' });
    }
  };
}

const listen = (server: http.Server | https.Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(String((server.address() as AddressInfo).port))),
  );

describe('API Workbench over real HTTP (SDD-014 Milestone A)', () => {
  let main: http.Server;
  let other: http.Server;
  let secure: https.Server | null = null;
  let base = '';
  let otherBase = '';
  let secureBase = '';
  let certTemp: ReturnType<typeof createTempDir>;
  const sockets = new Set<{ destroy(): unknown }>();

  beforeAll(async () => {
    main = http.createServer(routes(() => otherBase));
    other = http.createServer(routes(() => base));
    for (const server of [main, other]) server.on('connection', (s) => sockets.add(s));
    base = `http://localhost:${await listen(main)}`;
    otherBase = `http://127.0.0.1:${await listen(other)}`;
    certTemp = createTempDir();
    const key = path.join(certTemp.dir, 'key.pem');
    const cert = path.join(certTemp.dir, 'cert.pem');
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
      );
      secure = https.createServer(
        { key: readFileSync(key), cert: readFileSync(cert) },
        routes(() => base),
      );
      secure.on('connection', (s) => sockets.add(s));
      secureBase = `https://localhost:${await listen(secure)}`;
    } catch {
      secure = null; // No openssl: the TLS tests are skipped.
    }
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [main, other, secure].map(
        (server) => new Promise((resolve) => (server ? server.close(resolve) : resolve(null))),
      ),
    );
    certTemp.cleanup();
  });

  let temp: ReturnType<typeof createTempDir>;
  let db: Database;
  let service: HttpWorkbenchService;
  let responsesDir: string;
  const subscriber = 'desktop-1-0';

  beforeEach(() => {
    temp = createTempDir();
    db = openDatabase({ filePath: ':memory:' });
    responsesDir = path.join(temp.dir, 'responses');
    service = new HttpWorkbenchService({
      repository: new SqliteHttpWorkbenchRepository(db),
      transport: new NodeHttpTransport(),
      cookies: new MemoryCookieJars(),
      responses: new FileHttpResponses(responsesDir),
      projectExists: async () => true,
      userAgent: 'ATLAS/test',
      clock: { now: () => new Date() },
      generateId: randomUUID,
      logger: noopLogger,
    });
  });

  afterEach(async () => {
    await service.close();
    db.close();
    temp.cleanup();
  });

  const request = (overrides: Partial<HttpRequestDefinition>): HttpRequestDefinition => ({
    ...emptyHttpRequestDefinition(),
    ...overrides,
  });

  const send = (
    definition: HttpRequestDefinition,
    options: { collectionId?: string | null; requestId?: string | null; picked?: string[] } = {},
  ) =>
    service.send(
      subscriber,
      {
        executionId: randomUUID(),
        collectionId: options.collectionId ?? null,
        requestId: options.requestId ?? null,
        definition,
      },
      options.picked ?? [],
    );

  const bodyOf = async (result: HttpExecutionResult) =>
    (await service.readBody({ executionId: result.executionId, offset: 0 })).text;

  const errorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error instanceof AtlasError ? error.code : String(error);
    }
    return 'resolved';
  };

  it('sends a GET and reports real metadata (Scenario A, FR-1410)', async () => {
    const result = await send(request({ url: `${base}/users` }));
    expect(result).toMatchObject({
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      contentType: 'application/json',
      bodyKind: 'json',
      truncated: false,
      redirects: [],
      requestUrl: `${base}/users`,
      finalUrl: `${base}/users`,
    });
    expect(JSON.parse(await bodyOf(result))).toEqual({
      data: [{ id: 1, name: 'Example User' }],
      total: 1,
    });
    expect(result.bodyBytes).toBe(Buffer.byteLength(await bodyOf(result)));
    // Measured phases only: a fresh connection to a host name has DNS and connect, no TLS.
    expect(result.timing.dnsMs).not.toBeNull();
    expect(result.timing.connectMs).not.toBeNull();
    expect(result.timing.tlsMs).toBeNull();
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(result.timing.firstByteMs ?? 0);
    expect(result.requestHeaders).toEqual(
      expect.arrayContaining([
        ['User-Agent', 'ATLAS/test'],
        ['Accept', '*/*'],
      ]),
    );
  });

  it('supports every standard method and custom tokens (FR-1401)', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PURGE']) {
      const result = await send(request({ method, url: `${base}/echo` }));
      expect(JSON.parse(await bodyOf(result)).method).toBe(method);
    }
    const head = await send(request({ method: 'HEAD', url: `${base}/echo` }));
    expect(head).toMatchObject({ status: 200, bodyBytes: 0, bodyKind: 'empty' });
  });

  it('sends the URL, query and headers as written, including duplicates (FR-1402–FR-1404)', async () => {
    const result = await send(
      request({
        url: `${base}/echo?a&b=&c=1&c=2&q=a+b%20c`,
        headers: [
          { name: 'X-Trace', value: 'one', enabled: true, secret: false },
          { name: 'X-Trace', value: 'two', enabled: true, secret: false },
          { name: 'X-Off', value: 'no', enabled: false, secret: false },
        ],
      }),
    );
    const echo = JSON.parse(await bodyOf(result));
    expect(echo.path).toBe('/echo?a&b=&c=1&c=2&q=a+b%20c');
    expect(echo.headers['x-trace']).toBe('one, two');
    expect(echo.headers['x-off']).toBeUndefined();
  });

  it('reports HTTP error statuses as responses, not failures (FR-1407)', async () => {
    const notFound = await send(request({ url: `${base}/status?code=404` }));
    const failed = await send(request({ url: `${base}/status?code=500` }));
    expect([notFound.status, failed.status]).toEqual([404, 500]);
    expect(service.history({}).entries.map((e) => [e.status, e.errorCode])).toEqual([
      [500, null],
      [404, null],
    ]);
  });

  it('sends JSON, text, XML and form bodies with their types (FR-1405)', async () => {
    const cases: [HttpRequestDefinition['body'], string, string][] = [
      [{ type: 'json', text: '{"name":"Ana"}' }, 'application/json', '{"name":"Ana"}'],
      [{ type: 'text', text: 'olá' }, 'text/plain; charset=utf-8', 'olá'],
      [{ type: 'xml', text: '<a/>' }, 'application/xml', '<a/>'],
      [
        {
          type: 'form',
          fields: [
            { name: 'user', value: 'ana maria', enabled: true, secret: false },
            { name: 'skip', value: 'x', enabled: false, secret: false },
            { name: 'tag', value: 'a&b', enabled: true, secret: false },
          ],
        },
        'application/x-www-form-urlencoded',
        'user=ana+maria&tag=a%26b',
      ],
    ];
    for (const [body, type, sent] of cases) {
      const echo = JSON.parse(
        await bodyOf(await send(request({ method: 'POST', url: `${base}/echo`, body }))),
      );
      expect(echo.headers['content-type']).toBe(type);
      expect(echo.body).toBe(sent);
      expect(Number(echo.headers['content-length'])).toBe(Buffer.byteLength(sent));
    }
    // A Content-Type set by the user wins over the default.
    const custom = JSON.parse(
      await bodyOf(
        await send(
          request({
            method: 'POST',
            url: `${base}/echo`,
            headers: [
              {
                name: 'Content-Type',
                value: 'application/vnd.api+json',
                enabled: true,
                secret: false,
              },
            ],
            body: { type: 'json', text: '{}' },
          }),
        ),
      ),
    );
    expect(custom.headers['content-type']).toBe('application/vnd.api+json');
  });

  it('uploads picked files as binary and multipart bodies, and refuses others (FR-1405, R5)', async () => {
    const file = path.join(temp.dir, 'photo.bin');
    writeFileSync(file, Buffer.from([1, 2, 3, 4, 5]));
    const binary = request({
      method: 'PUT',
      url: `${base}/echo`,
      body: { type: 'binary', file: { path: file, name: 'photo.bin' }, contentType: null },
    });
    expect(await errorOf(send(binary))).toBe('HTTP_FILE_UNAUTHORIZED');
    const echo = JSON.parse(await bodyOf(await send(binary, { picked: [file] })));
    expect(echo).toMatchObject({ bytes: 5 });
    expect(echo.headers['content-type']).toBe('application/octet-stream');

    const multipart = request({
      method: 'POST',
      url: `${base}/echo`,
      headers: [{ name: 'Content-Type', value: 'text/plain', enabled: true, secret: false }],
      body: {
        type: 'multipart',
        parts: [
          { kind: 'text', name: 'title', value: 'Holiday', enabled: true, secret: false },
          {
            kind: 'file',
            name: 'upload',
            file: { path: file, name: 'photo.bin' },
            contentType: 'image/png',
            enabled: true,
          },
        ],
      },
    });
    const parts = JSON.parse(await bodyOf(await send(multipart, { picked: [file] })));
    expect(parts.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(parts.body).toContain('name="title"');
    expect(parts.body).toContain('Holiday');
    expect(parts.body).toContain('filename="photo.bin"');
    expect(parts.body).toContain('Content-Type: image/png');

    const missing = request({
      ...binary,
      body: {
        type: 'binary',
        file: { path: path.join(temp.dir, 'gone'), name: 'gone' },
        contentType: null,
      },
    });
    expect(await errorOf(send(missing, { picked: [path.join(temp.dir, 'gone')] }))).toBe(
      'HTTP_FILE_UNAVAILABLE',
    );
  });

  it('follows redirects and never forwards credentials to another origin (FR-1408)', async () => {
    const authorization = {
      name: 'Authorization',
      value: 'Bearer s3cr3t',
      enabled: true,
      secret: false,
    };
    const same = await send(
      request({ url: `${base}/redirect?to=/echo`, headers: [authorization] }),
    );
    expect(same.redirects).toEqual([
      { status: 302, url: `${base}/echo`, credentialsRemoved: false },
    ]);
    expect(JSON.parse(await bodyOf(same)).headers.authorization).toBe('Bearer s3cr3t');

    const cross = await send(
      request({ url: `${base}/redirect?to=other`, headers: [authorization] }),
    );
    expect(cross.redirects[0]).toMatchObject({ credentialsRemoved: true });
    expect(cross.finalUrl).toBe(`${otherBase}/echo`);
    expect(JSON.parse(await bodyOf(cross)).headers.authorization).toBeUndefined();

    const posted = await send(
      request({
        method: 'POST',
        url: `${base}/redirect?code=303&to=/echo`,
        body: { type: 'json', text: '{"a":1}' },
      }),
    );
    const afterSeeOther = JSON.parse(await bodyOf(posted));
    expect(afterSeeOther).toMatchObject({ method: 'GET', bytes: 0 });
    expect(afterSeeOther.headers['content-type']).toBeUndefined();

    const kept = JSON.parse(
      await bodyOf(
        await send(
          request({
            method: 'POST',
            url: `${base}/redirect?code=307&to=/echo`,
            body: { type: 'json', text: '{"a":1}' },
          }),
        ),
      ),
    );
    expect(kept).toMatchObject({ method: 'POST', body: '{"a":1}' });

    const notFollowed = await send(
      request({
        url: `${base}/redirect?to=/echo`,
        settings: { ...emptyHttpRequestDefinition().settings, followRedirects: false },
      }),
    );
    expect(notFollowed.status).toBe(302);
    expect(await errorOf(send(request({ url: `${base}/loop` })))).toBe('HTTP_TOO_MANY_REDIRECTS');
  });

  it('keeps cookies per collection, in memory, scoped by path (FR-1413)', async () => {
    const first = await service.createCollection({ name: 'Shop', scope: { kind: 'global' } });
    const second = await service.createCollection({ name: 'Other', scope: { kind: 'global' } });
    const setter = await send(request({ url: `${base}/cookies/set` }), { collectionId: first.id });
    expect(setter.setCookies.map((c) => [c.name, c.path, c.httpOnly])).toEqual([
      ['session', '/', true],
      ['theme', '/cookies', false],
    ]);
    const echo = async (collectionId: string | null, pathname = '/cookies/echo') =>
      JSON.parse(await bodyOf(await send(request({ url: `${base}${pathname}` }), { collectionId })))
        .cookie;
    expect(await echo(first.id)).toBe('theme=dark; session=abc123');
    expect(await echo(second.id)).toBeNull();
    expect(await echo(null)).toBeNull();
    expect((await service.cookies(first.id)).map((c) => c.name).sort()).toEqual([
      'session',
      'theme',
    ]);
    await service.updateCollection({ id: first.id, cookieJar: false });
    expect(await echo(first.id)).toBeNull();
    expect(await service.cookies(first.id)).toEqual([]);
  });

  it('stops at the size limit and decodes compressed bodies (FR-1407, §19)', async () => {
    const limited = await send(
      request({
        url: `${base}/big`,
        settings: { ...emptyHttpRequestDefinition().settings, maxResponseBytes: 10_000 },
      }),
    );
    expect(limited).toMatchObject({ truncated: true, bodyBytes: 10_000 });
    const page = await service.readBody({
      executionId: limited.executionId,
      offset: 0,
      limit: 4096,
    });
    expect(page).toMatchObject({
      offset: 0,
      nextOffset: 4096,
      totalBytes: 10_000,
      complete: false,
    });

    const full = await send(request({ url: `${base}/big` }));
    expect(full).toMatchObject({ truncated: false, bodyBytes: 64 * 64 * 1024 });

    const gzip = await send(request({ url: `${base}/gzip` }));
    expect(JSON.parse(await bodyOf(gzip))).toEqual({ compressed: true });
    expect(gzip.transferredBytes).toBeLessThan(gzip.bodyBytes + 30);

    const binary = await send(request({ url: `${base}/binary` }));
    expect(binary).toMatchObject({ bodyKind: 'binary', bodyBytes: 8 });
  });

  it('times out and cancels, without reporting a response (FR-1407)', async () => {
    const short = { ...emptyHttpRequestDefinition().settings, timeoutMs: 1000 };
    expect(await errorOf(send(request({ url: `${base}/hang`, settings: short })))).toBe(
      'HTTP_TIMEOUT',
    );
    expect(await errorOf(send(request({ url: `${base}/slow`, settings: short })))).toBe(
      'HTTP_TIMEOUT',
    );

    const executionId = randomUUID();
    const pending = service.send(
      subscriber,
      {
        executionId,
        collectionId: null,
        requestId: null,
        definition: request({ url: `${base}/hang` }),
      },
      [],
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    service.cancel(executionId);
    expect(await errorOf(pending)).toBe('HTTP_CANCELLED');
    expect(await errorOf(service.readBody({ executionId, offset: 0 }))).toBe(
      'HTTP_EXECUTION_NOT_FOUND',
    );
    const entries = service.history({}).entries;
    expect(entries[0]).toMatchObject({ status: null, errorCode: 'HTTP_CANCELLED' });
    // Failed requests leave no body file behind.
    expect(existsSync(responsesDir) ? readdirSync(responsesDir) : []).toEqual([]);
  });

  it('distinguishes connection failures (FR-1407)', async () => {
    const closed = http.createServer();
    const port = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    expect(await errorOf(send(request({ url: `http://127.0.0.1:${port}/` })))).toBe(
      'HTTP_CONNECTION_FAILED',
    );
    expect(await errorOf(send(request({ url: '{{baseUrl}}/users' })))).toBe(
      'HTTP_UNRESOLVED_VARIABLE',
    );
    expect(await errorOf(send(request({ url: 'ftp://localhost/' })))).toBe('HTTP_INVALID_URL');
  });

  it.skipIf(process.platform === 'win32')(
    'verifies TLS unless this request turns it off (FR-1408)',
    async ({ skip }) => {
      if (secure === null) skip();
      expect(await errorOf(send(request({ url: `${secureBase}/users` })))).toBe('HTTP_TLS_FAILED');
      const insecure = await send(
        request({
          url: `${secureBase}/users`,
          settings: { ...emptyHttpRequestDefinition().settings, verifyTls: false },
        }),
      );
      expect(insecure.status).toBe(200);
      expect(insecure.timing.tlsMs).not.toBeNull();
      // The next request verifies again: nothing was turned off globally.
      expect(await errorOf(send(request({ url: `${secureBase}/users` })))).toBe('HTTP_TLS_FAILED');
    },
  );

  it('saves requests without secrets and keeps history free of them (FR-1409, FR-1419)', async () => {
    const collection = await service.createCollection({ name: 'API', scope: { kind: 'global' } });
    const definition = request({
      url: `${base}/echo?page=1&api_key=k3y`,
      params: [
        { name: 'page', value: '1', enabled: true, secret: false },
        { name: 'api_key', value: 'k3y', enabled: true, secret: true },
      ],
      headers: [{ name: 'Authorization', value: 'Bearer s3cr3t', enabled: true, secret: false }],
    });
    const saved = service.saveRequest(
      { collectionId: collection.id, folderId: null, name: 'Echo', definition },
      [],
    );
    const result = await send(definition, { collectionId: collection.id, requestId: saved.id });
    expect(JSON.parse(await bodyOf(result)).headers.authorization).toBe('Bearer s3cr3t');
    expect(result.requestHeaders).toContainEqual(['Authorization', '[secret]']);
    expect(result.requestUrl).toBe(`${base}/echo?page=1&api_key=[secret]`);

    const stored = service.getRequest(saved.id);
    expect(stored.definition.headers[0]).toMatchObject({ value: '', secret: true });
    expect(stored.url).toBe(`${base}/echo?page=1&api_key=`);
    const everything =
      JSON.stringify(db.prepare('SELECT * FROM http_requests').all()) +
      JSON.stringify(db.prepare('SELECT * FROM http_history').all());
    expect(everything).not.toContain('s3cr3t');
    expect(everything).not.toContain('k3y');
    expect(service.history({ requestId: saved.id }).entries[0]).toMatchObject({
      url: `${base}/echo?page=1&api_key=[secret]`,
      status: 200,
    });
    // Sending the stored definition asks for the secrets again.
    expect(await errorOf(send(stored.definition))).toBe('HTTP_SECRET_MISSING');
  });

  it('saves, downloads and compares responses without credentials (FR-1411, FR-1415)', async () => {
    const result = await send(request({ url: `${base}/cookies/set` }));
    const snapshot = await service.saveSnapshot({
      executionId: result.executionId,
      requestId: null,
      name: 'Login',
    });
    const stored = service.snapshot(snapshot.id);
    expect(stored).toMatchObject({ status: 200, body: 'ok', bodyTruncated: false });
    expect(stored.headers.filter(([name]) => name === 'Set-Cookie')).toEqual([
      ['Set-Cookie', '[secret]'],
      ['Set-Cookie', '[secret]'],
    ]);
    expect(JSON.stringify(db.prepare('SELECT * FROM http_snapshots').all())).not.toContain(
      'abc123',
    );

    const destination = path.join(temp.dir, 'download.json');
    const users = await send(request({ url: `${base}/users` }));
    await service.saveResponse(users.executionId, destination);
    expect(JSON.parse(readFileSync(destination, 'utf8')).total).toBe(1);

    await service.release(users.executionId);
    expect(await errorOf(service.readBody({ executionId: users.executionId, offset: 0 }))).toBe(
      'HTTP_EXECUTION_NOT_FOUND',
    );
    await service.detach(subscriber);
    expect(readdirSync(responsesDir)).toEqual([]);
  });
});
