import { describe, expect, it } from 'vitest';
import {
  HttpHeaderSchema,
  HttpMethodSchema,
  emptyHttpRequestDefinition,
  httpParamsFromUrl,
  httpUrlWithParams,
  isSensitiveName,
  parseHttpQuery,
  placeholderNames,
  redactHttpUrlQuery,
  type HttpRequestDefinition,
} from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import {
  assertSendable,
  bodyKindOf,
  definitionForStorage,
  filesOf,
  parseHttpTarget,
  planRedirect,
  redactHeaders,
  trimIncompleteUtf8,
  urlForHistory,
} from '@atlas/api-workbench';

const definition = (overrides: Partial<HttpRequestDefinition> = {}): HttpRequestDefinition => ({
  ...emptyHttpRequestDefinition(),
  url: 'http://localhost:3000/api',
  ...overrides,
});

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof AtlasError ? error.code : 'not-atlas';
  }
  return undefined;
};

describe('URL text and query parameters (FR-1402, FR-1403)', () => {
  it('keeps absent and empty values, duplicates and order', () => {
    expect(parseHttpQuery('a&b=&c=1&c=2&&d=x%20y')).toEqual([
      { name: 'a', value: null },
      { name: 'b', value: '' },
      { name: 'c', value: '1' },
      { name: 'c', value: '2' },
      { name: 'd', value: 'x%20y' },
    ]);
    expect(parseHttpQuery(null)).toEqual([]);
  });

  it('rebuilds the query from enabled parameters only, keeping the fragment', () => {
    const params = [
      { name: 'a', value: null, enabled: true, secret: false },
      { name: 'b', value: '', enabled: true, secret: false },
      { name: 'off', value: '1', enabled: false, secret: false },
    ];
    expect(httpUrlWithParams('http://h/p?old=1#top', params)).toBe('http://h/p?a&b=#top');
    expect(httpUrlWithParams('http://h/p?x=1', [])).toBe('http://h/p');
  });

  it('reads parameters from the URL and keeps disabled ones and secret flags', () => {
    const previous = [
      { name: 'key2', value: 'v', enabled: true, secret: true },
      { name: 'off', value: '1', enabled: false, secret: false },
    ];
    expect(httpParamsFromUrl('http://h/?key2=v&page=2&access_token=t', previous)).toEqual([
      { name: 'key2', value: 'v', enabled: true, secret: true },
      { name: 'page', value: '2', enabled: true, secret: false },
      { name: 'access_token', value: 't', enabled: true, secret: true },
      { name: 'off', value: '1', enabled: false, secret: false },
    ]);
  });

  it('finds placeholders and redacts secret query values', () => {
    expect(placeholderNames('{{baseUrl}}/a/{{ id }}/{{baseUrl}}')).toEqual(['baseUrl', 'id']);
    expect(redactHttpUrlQuery('http://h/?page=1&api_key=s3cr3t&x=2', new Set(['x']))).toBe(
      'http://h/?page=1&api_key=&x=',
    );
    expect(isSensitiveName('Authorization')).toBe(true);
    expect(isSensitiveName('X-Api-Key')).toBe(true);
    expect(isSensitiveName('refresh_token')).toBe(true);
    expect(isSensitiveName('Accept')).toBe(false);
    expect(isSensitiveName('author')).toBe(false);
  });
});

describe('parseHttpTarget', () => {
  it('sends the path as written: no dot-segment removal or re-encoding', () => {
    const target = parseHttpTarget('HTTP://LocalHost:3000/a/../b/%2F?q=a+b&x=%20#frag');
    expect(target).toMatchObject({
      protocol: 'http:',
      hostname: 'localhost',
      port: 3000,
      path: '/a/../b/%2F?q=a+b&x=%20',
      origin: 'http://localhost:3000',
      url: 'http://localhost:3000/a/../b/%2F?q=a+b&x=%20',
    });
  });

  it('encodes only what a request line cannot carry', () => {
    expect(parseHttpTarget('https://example.com/a b/é?q={x}').path).toBe('/a%20b/%C3%A9?q=%7Bx%7D');
    expect(parseHttpTarget('https://example.com').path).toBe('/');
    expect(parseHttpTarget('https://example.com?x=1').path).toBe('/?x=1');
    expect(parseHttpTarget('https://example.com').port).toBe(443);
    expect(parseHttpTarget('http://[::1]:8080/').hostname).toBe('::1');
  });

  it('refuses other schemes and credentials in the URL', () => {
    expect(codeOf(() => parseHttpTarget('ftp://example.com/'))).toBe('HTTP_INVALID_URL');
    expect(codeOf(() => parseHttpTarget('localhost:3000'))).toBe('HTTP_INVALID_URL');
    expect(codeOf(() => parseHttpTarget('http://user:pass@example.com/'))).toBe('HTTP_INVALID_URL');
    expect(codeOf(() => parseHttpTarget('http://exa mple.com/'))).toBe('HTTP_INVALID_URL');
  });
});

describe('request validation (FR-1401, FR-1404)', () => {
  it('accepts custom method tokens but not CONNECT or spaces', () => {
    expect(HttpMethodSchema.safeParse('PURGE').success).toBe(true);
    expect(HttpMethodSchema.safeParse('CONNECT').success).toBe(false);
    expect(HttpMethodSchema.safeParse('connect').success).toBe(false);
    expect(HttpMethodSchema.safeParse('GET X').success).toBe(false);
  });

  it('refuses header names and values that would split a request', () => {
    const header = { enabled: true, secret: false };
    expect(HttpHeaderSchema.safeParse({ ...header, name: 'X-A', value: 'ok' }).success).toBe(true);
    expect(
      HttpHeaderSchema.safeParse({ ...header, name: 'X-A', value: 'a\r\nHost: evil' }).success,
    ).toBe(false);
    expect(HttpHeaderSchema.safeParse({ ...header, name: 'X A', value: 'v' }).success).toBe(false);
    expect(HttpHeaderSchema.safeParse({ ...header, name: 'X:A', value: 'v' }).success).toBe(false);
  });
});

describe('assertSendable', () => {
  it('never sends unresolved placeholders (PLAN-042 Q3)', () => {
    let error: unknown;
    try {
      assertSendable(
        definition({
          url: '{{baseUrl}}/users',
          headers: [{ name: 'X-Trace', value: '{{trace}}', enabled: true, secret: false }],
          body: { type: 'json', text: '{"id": "{{id}}"}' },
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AtlasError);
    expect((error as AtlasError).code).toBe('HTTP_UNRESOLVED_VARIABLE');
    expect((error as AtlasError).issues.map((issue) => issue.message)).toEqual([
      '{{baseUrl}}',
      '{{trace}}',
      '{{id}}',
    ]);
    // Disabled rows are not sent, so they do not count.
    expect(() =>
      assertSendable(
        definition({
          headers: [{ name: 'X-Trace', value: '{{trace}}', enabled: false, secret: false }],
        }),
      ),
    ).not.toThrow();
  });

  it('asks for secret values that were not entered again (PLAN-042 Q1)', () => {
    expect(
      codeOf(() =>
        assertSendable(
          definition({
            headers: [{ name: 'Authorization', value: '', enabled: true, secret: true }],
          }),
        ),
      ),
    ).toBe('HTTP_SECRET_MISSING');
    expect(
      codeOf(() =>
        assertSendable(
          definition({
            url: 'http://h/?api_key=',
            params: [{ name: 'api_key', value: '', enabled: true, secret: true }],
          }),
        ),
      ),
    ).toBe('HTTP_SECRET_MISSING');
    expect(
      codeOf(() =>
        assertSendable(definition({ body: { type: 'binary', file: null, contentType: null } })),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('definitionForStorage (PLAN-042 Q1)', () => {
  it('empties secret values everywhere and marks the rows secret', () => {
    const stored = definitionForStorage(
      definition({
        url: 'http://h/?page=1&token=abc&mine=v',
        params: [
          { name: 'page', value: '1', enabled: true, secret: false },
          { name: 'token', value: 'abc', enabled: true, secret: false },
          { name: 'mine', value: 'v', enabled: true, secret: true },
          { name: 'flag', value: null, enabled: false, secret: true },
        ],
        headers: [
          { name: 'Authorization', value: 'Bearer abc', enabled: true, secret: false },
          { name: 'X-Custom', value: 'hidden', enabled: true, secret: true },
          { name: 'Accept', value: 'application/json', enabled: true, secret: false },
        ],
        body: {
          type: 'form',
          fields: [
            { name: 'user', value: 'ana', enabled: true, secret: false },
            { name: 'password', value: 'pw', enabled: true, secret: false },
          ],
        },
      }),
    );
    expect(stored.url).toBe('http://h/?page=1&token=&mine=');
    expect(stored.params.map((p) => [p.name, p.value, p.secret])).toEqual([
      ['page', '1', false],
      ['token', '', true],
      ['mine', '', true],
      ['flag', null, true],
    ]);
    expect(stored.headers.map((h) => [h.name, h.value])).toEqual([
      ['Authorization', ''],
      ['X-Custom', ''],
      ['Accept', 'application/json'],
    ]);
    expect(stored.body).toEqual({
      type: 'form',
      fields: [
        { name: 'user', value: 'ana', enabled: true, secret: false },
        { name: 'password', value: '', enabled: true, secret: true },
      ],
    });
    expect(JSON.stringify(stored)).not.toMatch(/abc|hidden|pw"/);
  });

  it('hides secret query values in history and lists uploaded files', () => {
    const def = definition({
      params: [{ name: 'mine', value: 'v', enabled: true, secret: true }],
      body: {
        type: 'multipart',
        parts: [
          { kind: 'text', name: 'a', value: '1', enabled: true, secret: false },
          {
            kind: 'file',
            name: 'f',
            file: { path: '/tmp/a.png', name: 'a.png' },
            contentType: null,
            enabled: true,
          },
          {
            kind: 'file',
            name: 'g',
            file: { path: '/tmp/b.png', name: 'b.png' },
            contentType: null,
            enabled: false,
          },
        ],
      },
    });
    expect(urlForHistory('http://h/?mine=v&session_id=9&q=1', def)).toBe(
      'http://h/?mine=[secret]&session_id=[secret]&q=1',
    );
    expect(filesOf(def)).toEqual(['/tmp/a.png']);
  });

  it('hides credential headers for display', () => {
    expect(
      redactHeaders(
        [
          ['Authorization', 'Bearer x'],
          ['Set-Cookie', 's=1'],
          ['X-Mine', 'v'],
          ['Content-Type', 'text/plain'],
        ],
        new Set(['x-mine']),
      ),
    ).toEqual([
      ['Authorization', '[secret]'],
      ['Set-Cookie', '[secret]'],
      ['X-Mine', '[secret]'],
      ['Content-Type', 'text/plain'],
    ]);
  });
});

describe('planRedirect (FR-1408)', () => {
  const from = (method: string, url: string) => ({ method, target: parseHttpTarget(url) });

  it('keeps credentials on the same origin only', () => {
    expect(planRedirect(from('GET', 'http://a.test/x'), 302, '/y')).toEqual({
      url: 'http://a.test/y',
      method: 'GET',
      keepBody: true,
      removeCredentials: false,
    });
    expect(
      planRedirect(from('GET', 'http://a.test/x'), 302, 'http://b.test/y').removeCredentials,
    ).toBe(true);
    expect(
      planRedirect(from('GET', 'http://a.test:80/x'), 302, 'http://a.test:81/').removeCredentials,
    ).toBe(true);
    expect(
      planRedirect(from('GET', 'https://a.test/x'), 302, 'http://a.test/x').removeCredentials,
    ).toBe(true);
  });

  it('changes the method like browsers do', () => {
    expect(planRedirect(from('POST', 'http://a.test/'), 303, '/r')).toMatchObject({
      method: 'GET',
      keepBody: false,
    });
    expect(planRedirect(from('PUT', 'http://a.test/'), 303, '/r')).toMatchObject({
      method: 'GET',
      keepBody: false,
    });
    expect(planRedirect(from('HEAD', 'http://a.test/'), 303, '/r')).toMatchObject({
      method: 'HEAD',
    });
    expect(planRedirect(from('POST', 'http://a.test/'), 302, '/r')).toMatchObject({
      method: 'GET',
      keepBody: false,
    });
    expect(planRedirect(from('POST', 'http://a.test/'), 307, '/r')).toMatchObject({
      method: 'POST',
      keepBody: true,
    });
    expect(planRedirect(from('PATCH', 'http://a.test/'), 301, '/r')).toMatchObject({
      method: 'PATCH',
      keepBody: true,
    });
  });

  it('refuses redirects outside HTTP', () => {
    expect(
      codeOf(() => planRedirect(from('GET', 'http://a.test/'), 302, 'file:///etc/passwd')),
    ).toBe('HTTP_TRANSPORT_FAILED');
  });
});

describe('response bodies', () => {
  const text = new TextEncoder().encode('hello');

  it('recognizes how to show a body', () => {
    expect(bodyKindOf('application/json; charset=utf-8', text, 5)).toBe('json');
    expect(bodyKindOf('application/problem+json', text, 5)).toBe('json');
    expect(bodyKindOf('application/atom+xml', text, 5)).toBe('xml');
    expect(bodyKindOf('text/html', text, 5)).toBe('html');
    expect(bodyKindOf('text/csv', text, 5)).toBe('text');
    expect(bodyKindOf('image/png', text, 5)).toBe('binary');
    expect(bodyKindOf(null, text, 5)).toBe('text');
    expect(bodyKindOf(null, new Uint8Array([0x89, 0x50, 0x00, 0x47]), 4)).toBe('binary');
    expect(bodyKindOf('application/json', new Uint8Array(), 0)).toBe('empty');
  });

  it('cuts pages on whole UTF-8 characters', () => {
    const bytes = new TextEncoder().encode('aé€😀');
    expect(trimIncompleteUtf8(bytes)).toHaveLength(bytes.length);
    expect(new TextDecoder().decode(trimIncompleteUtf8(bytes.subarray(0, 2)))).toBe('a');
    expect(new TextDecoder().decode(trimIncompleteUtf8(bytes.subarray(0, 5)))).toBe('aé');
    expect(new TextDecoder().decode(trimIncompleteUtf8(bytes.subarray(0, 8)))).toBe('aé€');
  });
});
