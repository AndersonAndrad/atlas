import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { HostingApiError } from '@atlas/hosting';
import { noopLogger, type Logger } from '@atlas/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../../tests/support/temp.js';
import { HttpHostingApi, hostingApiOverrides } from '../src/adapters/hosting-api.js';
import { FileSshConfigSource } from '../src/adapters/ssh-config-reader.js';
import { createEngine, type Engine } from '../src/index.js';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

/** A fake GitHub/Bitbucket API recording what it received. */
function fakeProvider() {
  const requests: { url: string; authorization: string | undefined }[] = [];
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) =>
    res.end('{}');
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', authorization: req.headers.authorization });
    handler(req, res);
  });
  return {
    server,
    requests,
    respond: (next: typeof handler) => {
      handler = next;
    },
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

describe('HttpHostingApi (SDD-024 Task 04, FR-003, FR-022)', () => {
  const provider = fakeProvider();
  let api: HttpHostingApi;
  const github = { email: null, token: 'ghp_secret' };
  const bitbucket = { email: 'ana@example.com', token: 'ATATT_secret' };

  beforeAll(async () => {
    await new Promise<void>((resolve) => provider.server.listen(0, '127.0.0.1', resolve));
    api = new HttpHostingApi({
      userAgent: 'ATLAS/test',
      logger: noopLogger,
      baseUrls: { GITHUB: provider.url(), BITBUCKET: `${provider.url()}/2.0` },
    });
  });
  afterAll(() => provider.server.close());
  beforeEach(() => {
    provider.requests.length = 0;
  });

  it('authenticates GitHub with a bearer token and Bitbucket with email and token', async () => {
    provider.respond((req, res) =>
      req.url === '/user'
        ? json(res, 200, { login: 'ana', name: 'Ana' })
        : json(res, 200, { username: 'ana-bb', display_name: 'Ana B' }),
    );
    expect(await api.verify('GITHUB', github)).toEqual({ login: 'ana', displayName: 'Ana' });
    expect(await api.verify('BITBUCKET', bitbucket)).toEqual({
      login: 'ana-bb',
      displayName: 'Ana B',
    });
    expect(provider.requests).toEqual([
      { url: '/user', authorization: 'Bearer ghp_secret' },
      {
        url: '/2.0/user',
        authorization: `Basic ${Buffer.from('ana@example.com:ATATT_secret').toString('base64')}`,
      },
    ]);
  });

  it.each([
    [401, {}, 'INVALID_CREDENTIALS'],
    [403, {}, 'PERMISSION_DENIED'],
    [403, { 'x-ratelimit-remaining': '0' }, 'RATE_LIMITED'],
    [429, {}, 'RATE_LIMITED'],
    [503, {}, 'UNREACHABLE'],
    [418, {}, 'ERROR'],
  ])('maps status %i to %s without the token in the message', async (status, headers, failure) => {
    provider.respond((_req, res) => json(res, status, { message: 'ghp_secret leaked?' }, headers));
    const error = await api.verify('GITHUB', github).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostingApiError);
    expect((error as HostingApiError).failure).toBe(failure);
    expect((error as HostingApiError).message).not.toContain('ghp_secret');
  });

  it('reports repository access; private repositories without access look missing', async () => {
    provider.respond((req, res) =>
      req.url === '/repos/acme/api'
        ? json(res, 200, { full_name: 'acme/api' })
        : req.url === '/repos/acme/forbidden'
          ? json(res, 403, {})
          : json(res, 404, {}),
    );
    expect(await api.repositoryAccess('GITHUB', github, 'acme', 'api')).toBe('ACCESSIBLE');
    expect(await api.repositoryAccess('GITHUB', github, 'acme', 'forbidden')).toBe('NOT_FOUND');
    expect(await api.repositoryAccess('GITHUB', github, 'acme', 'other')).toBe('NOT_FOUND');
  });

  it('follows a same-origin redirect (renamed repository) but never another origin', async () => {
    provider.respond((req, res) => {
      if (req.url === '/repos/acme/old') {
        res.writeHead(301, { location: '/repositories/42' });
        res.end();
      } else if (req.url === '/repos/acme/away') {
        res.writeHead(302, { location: 'http://localhost:1/steal' });
        res.end();
      } else {
        json(res, 200, {});
      }
    });
    expect(await api.repositoryAccess('GITHUB', github, 'acme', 'old')).toBe('ACCESSIBLE');
    expect(provider.requests.at(-1)).toEqual({
      url: '/repositories/42',
      authorization: 'Bearer ghp_secret',
    });
    await expect(api.repositoryAccess('GITHUB', github, 'acme', 'away')).rejects.toMatchObject({
      failure: 'ERROR',
    });
  });

  it('refuses answers that are too large or not understood', async () => {
    provider.respond((_req, res) => json(res, 200, { login: 'x'.repeat(2 * 1024 * 1024) }));
    await expect(api.verify('GITHUB', github)).rejects.toMatchObject({ failure: 'ERROR' });
    provider.respond((_req, res) => json(res, 200, { unexpected: true }));
    await expect(api.verify('GITHUB', github)).rejects.toMatchObject({ failure: 'ERROR' });
  });

  it('reports an unreachable provider', async () => {
    const offline = new HttpHostingApi({
      userAgent: 'ATLAS/test',
      logger: noopLogger,
      baseUrls: { GITHUB: 'http://127.0.0.1:1' },
    });
    await expect(offline.verify('GITHUB', github)).rejects.toMatchObject({
      failure: 'UNREACHABLE',
    });
  });

  it('accepts API overrides only on loopback addresses', () => {
    const logger = { ...noopLogger, warn: vi.fn() } as unknown as Logger;
    expect(
      hostingApiOverrides(
        {
          ATLAS_GITHUB_API_URL: 'http://127.0.0.1:9000/',
          ATLAS_BITBUCKET_API_URL: 'https://evil.example.com/2.0',
        },
        logger,
      ),
    ).toEqual({ GITHUB: 'http://127.0.0.1:9000' });
  });
});

describe('FileSshConfigSource (FR-001)', () => {
  let temp: ReturnType<typeof createTempDir>;
  afterEach(() => temp.cleanup());

  it('inlines Include files where they appear, relative to ~/.ssh, with wildcards', async () => {
    temp = createTempDir();
    const ssh = path.join(temp.dir, '.ssh');
    mkdirSync(path.join(ssh, 'config.d'), { recursive: true });
    writeFileSync(path.join(ssh, 'config'), 'Include config.d/*.conf\nHost last\n  HostName z\n');
    writeFileSync(path.join(ssh, 'config.d', 'a.conf'), 'Host work\n  HostName github.com\n');
    writeFileSync(path.join(ssh, 'config.d', 'b.conf'), 'Include ../config\n');
    writeFileSync(path.join(ssh, 'config.d', 'skip.txt'), 'Host work\n  HostName nope\n');
    const text = await new FileSshConfigSource(temp.dir).read();
    expect(text).toContain('HostName github.com');
    expect(text).not.toContain('nope');
    // The recursive include stops at the depth and file limits.
    expect(text!.indexOf('github.com')).toBeLessThan(text!.indexOf('HostName z'));
  });

  it('returns null without a configuration', async () => {
    temp = createTempDir();
    expect(await new FileSshConfigSource(temp.dir).read()).toBeNull();
  });
});

/** The Engine with real Git remotes and a fake provider (SDD-024 Task 04 Milestone A). */
describe.skipIf(!gitAvailable)('Engine hosting', () => {
  const provider = fakeProvider();
  let temp: ReturnType<typeof createTempDir>;
  let engine: Engine;
  let projectId: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => provider.server.listen(0, '127.0.0.1', resolve));
  });
  afterAll(() => provider.server.close());

  beforeEach(async () => {
    temp = createTempDir();
    const home = path.join(temp.dir, 'home');
    mkdirSync(path.join(home, '.ssh'), { recursive: true });
    writeFileSync(path.join(home, '.ssh', 'config'), 'Host gh-work\n  HostName github.com\n');
    const repo = path.join(temp.dir, 'repo');
    mkdirSync(repo);
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      ATLAS_GITHUB_API_URL: provider.url(),
    };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env });
    git('init', '-q', '-b', 'main');
    git('remote', 'add', 'origin', 'git@gh-work:acme/api.git');
    git('remote', 'add', 'leak', 'https://bot:ghp_inline@github.com/acme/api.git');
    engine = createEngine({ dataDir: path.join(temp.dir, 'data'), env, component: 'test' });
    projectId = (await engine.createProject({ name: 'api', workspacePath: repo })).id;
  });
  afterEach(async () => {
    await engine.shutdown();
    temp.cleanup();
  });

  it('discovers remotes, stores no credentials and tests accounts with the handed token', async () => {
    const scan = await engine.hosting.repositories();
    expect(scan.sshConfigFound).toBe(true);
    expect(
      scan.remotes.map((remote) => [remote.remoteName, remote.remoteUrl, remote.sshAlias]),
    ).toEqual([
      ['leak', 'https://github.com/acme/api.git', null],
      ['origin', 'git@gh-work:acme/api.git', 'gh-work'],
    ]);
    expect(new Set(scan.remotes.map((remote) => remote.repositoryKey))).toEqual(
      new Set(['github:github.com/acme/api']),
    );

    const account = await engine.hosting.createAccount({ provider: 'GITHUB', label: 'Work' });
    provider.respond((_req, res) => json(res, 200, { login: 'ana' }));
    expect(await engine.hosting.testAccount(account.id)).toMatchObject({ state: 'NO_CREDENTIAL' });
    expect(provider.requests).toEqual([]);
    engine.setHostingCredential(account.id, 'ghp_from_main');
    expect(await engine.hosting.testAccount(account.id)).toMatchObject({
      state: 'CONNECTED',
      login: 'ana',
      hasCredential: true,
    });
    expect(provider.requests.at(-1)?.authorization).toBe('Bearer ghp_from_main');

    const scanned = await engine.hosting.checkAccess({ projectId });
    expect(scanned.remotes.every((remote) => remote.accountId === account.id)).toBe(true);
    expect(scanned.remotes[0]!.access).toBe('ACCESSIBLE');
    // One request per repository, not per remote.
    expect(provider.requests.filter((request) => request.url.startsWith('/repos/'))).toHaveLength(
      1,
    );

    engine.setHostingCredential(account.id, null);
    expect((await engine.hosting.accounts())[0]!.hasCredential).toBe(false);
  });

  it('is not offered to the CLI', async () => {
    const { createEngineDispatcher } = await import('../src/rpc/dispatcher.js');
    const dispatcher = createEngineDispatcher(engine);
    await expect(dispatcher.call('hosting.accounts', [], 'cli')).rejects.toBeTruthy();
    await expect(dispatcher.call('hosting.accounts', [], 'desktop')).resolves.toEqual([]);
  });
});
