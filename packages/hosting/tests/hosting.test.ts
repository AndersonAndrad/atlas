import { isAtlasError, noopLogger } from '@atlas/shared';
import {
  HostingApiError,
  HostingService,
  classifyRemote,
  globMatch,
  parseRemoteUrl,
  resolveSshAlias,
  sanitizeRemoteUrl,
  type HostingAccessRecord,
  type HostingAccountRecord,
  type HostingApi,
  type HostingRemoteRecord,
} from '@atlas/hosting';
import { describe, expect, it, vi } from 'vitest';

const none = { resolveAlias: () => null, providerOfAlias: () => null };

describe('remote URLs (FR-001)', () => {
  it.each([
    ['git@github.com:acme/api.git', 'ssh', 'github.com', 'acme/api'],
    ['ssh://git@github.com:22/acme/api.git', 'ssh', 'github.com', 'acme/api'],
    ['https://github.com/acme/api.git', 'https', 'github.com', 'acme/api'],
    ['https://user@bitbucket.org/team/repo.git', 'https', 'bitbucket.org', 'team/repo'],
    ['git@github-work:acme/api', 'ssh', 'github-work', 'acme/api'],
    ['bb:team/repo.git', 'ssh', 'bb', 'team/repo'],
  ])('parses %s', (url, transport, host, path) => {
    expect(parseRemoteUrl(url)).toEqual({ transport, host, path });
  });

  it.each([
    '/srv/git/api.git',
    '../api',
    'file:///srv/api.git',
    'http://github.com/a/b',
    'C:\\repo',
    '',
  ])('does not treat %s as a hosted remote', (url) => expect(parseRemoteUrl(url)).toBeNull());

  it('removes credentials from https URLs but keeps an ssh user name', () => {
    expect(sanitizeRemoteUrl('https://x-access-token:ghp_secret@github.com/acme/api.git')).toBe(
      'https://github.com/acme/api.git',
    );
    expect(sanitizeRemoteUrl('https://ana@bitbucket.org/team/repo.git')).toBe(
      'https://bitbucket.org/team/repo.git',
    );
    expect(sanitizeRemoteUrl('ssh://git@github.com/acme/api.git')).toBe(
      'ssh://git@github.com/acme/api.git',
    );
    expect(sanitizeRemoteUrl('git@github.com:acme/api.git')).toBe('git@github.com:acme/api.git');
  });

  it('classifies providers, aliases, other hosts and invalid paths', () => {
    expect(classifyRemote('git@github.com:Acme/API.git', none)).toMatchObject({
      kind: 'SUPPORTED',
      provider: 'GITHUB',
      owner: 'Acme',
      name: 'API',
      repositoryKey: 'github:github.com/acme/api',
    });
    expect(
      classifyRemote('git@work:acme/api.git', { ...none, resolveAlias: () => 'github.com' }),
    ).toMatchObject({
      kind: 'SUPPORTED',
      provider: 'GITHUB',
      sshAlias: 'work',
      host: 'github.com',
    });
    expect(
      classifyRemote('git@work:team/repo.git', { ...none, providerOfAlias: () => 'BITBUCKET' }),
    ).toMatchObject({ kind: 'SUPPORTED', provider: 'BITBUCKET', sshAlias: 'work', host: null });
    expect(classifyRemote('git@work:acme/api.git', none)).toMatchObject({
      kind: 'UNRESOLVED_ALIAS',
      sshAlias: 'work',
    });
    expect(
      classifyRemote('git@gl:acme/api.git', { ...none, resolveAlias: () => 'gitlab.com' }),
    ).toMatchObject({ kind: 'UNSUPPORTED_HOST', host: 'gitlab.com' });
    expect(classifyRemote('https://gitlab.com/acme/api.git', none).kind).toBe('UNSUPPORTED_HOST');
    expect(classifyRemote('https://github.com/acme/team/api.git', none).kind).toBe('INVALID_URL');
  });
});

describe('SSH configuration (FR-001)', () => {
  const config = [
    'IdentitiesOnly yes',
    'Host github-work',
    '  HostName github.com',
    '  IdentityFile ~/.ssh/work',
    'Host bb-* !bb-skip',
    '  HostName=bitbucket.org',
    'Host *.internal',
    '  HostName %h.example.com',
    'Host weird',
    '  HostName %r.example.com',
    'Match exec "curl evil"',
    '  HostName attacker.example.com',
    'Host github-work',
    '  HostName ignored.example.com',
  ].join('\n');

  it('uses the first HostName of matching Host blocks, with wildcards and negation', () => {
    expect(resolveSshAlias(config, 'github-work').hostName).toBe('github.com');
    expect(resolveSshAlias(config, 'bb-team').hostName).toBe('bitbucket.org');
    expect(resolveSshAlias(config, 'bb-skip').hostName).toBeNull();
    expect(resolveSshAlias(config, 'git.internal').hostName).toBe('git.internal.example.com');
  });

  it('matches globs without regular expressions, quickly even for hostile patterns', () => {
    expect(globMatch('gh-*', 'GH-work')).toBe(true);
    expect(globMatch('*.conf', 'a.CONF', false)).toBe(false);
    expect(globMatch('a?c', 'abc')).toBe(true);
    expect(globMatch('*a*a*a*a*a*a*a*a*b', 'a'.repeat(253))).toBe(false);
  });

  it('never evaluates Match blocks or unknown tokens', () => {
    expect(resolveSshAlias(config, 'weird')).toEqual({ hostName: null, uncertain: true });
    expect(resolveSshAlias(config, 'other')).toEqual({ hostName: null, uncertain: true });
  });
});

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';

function fakes(options: { remotes?: Record<string, { name: string; fetchUrl: string }[]> } = {}) {
  const accounts = new Map<string, HostingAccountRecord>();
  const remotes = new Map<string, HostingRemoteRecord>();
  const access = new Map<string, HostingAccessRecord>();
  const credentials = new Map<string, string>();
  let id = 0;
  const projectRemotes = options.remotes ?? {
    '/api': [{ name: 'origin', fetchUrl: 'git@github-work:acme/api.git' }],
    '/web': [
      { name: 'origin', fetchUrl: 'https://github.com/acme/web.git' },
      { name: 'mirror', fetchUrl: 'https://gitlab.com/acme/web.git' },
    ],
  };
  const api: HostingApi = {
    verify: vi.fn(async (_provider, credential) => {
      if (credential.token === 'bad') throw new HostingApiError('INVALID_CREDENTIALS', 'Rejected.');
      return { login: `user-${credential.token}`, displayName: null };
    }),
    repositoryAccess: vi.fn(async (_provider, credential, owner) => {
      if (credential.token === 'limited') throw new HostingApiError('RATE_LIMITED', 'Slow down.');
      return credential.token === `can-${owner}` ? 'ACCESSIBLE' : 'NOT_FOUND';
    }),
  };
  const service = new HostingService({
    accounts: {
      list: async () => [...accounts.values()],
      get: async (key) => accounts.get(key) ?? null,
      insert: async (record) => void accounts.set(record.id, record),
      update: async (record) => void accounts.set(record.id, record),
      remove: async (key) => {
        accounts.delete(key);
        for (const record of remotes.values()) {
          if (record.manualAccountId === key) record.manualAccountId = null;
        }
      },
    },
    remotes: {
      list: async () => [...remotes.values()],
      upsert: async (record) => {
        const key = `${record.projectId}:${record.remoteName}`;
        remotes.set(key, { manualAccountId: null, ...remotes.get(key), ...record });
      },
      setManualAccount: async (projectId, remoteName, accountId) => {
        remotes.get(`${projectId}:${remoteName}`)!.manualAccountId = accountId;
      },
      delete: async (projectId, remoteName) => void remotes.delete(`${projectId}:${remoteName}`),
    },
    access: {
      list: async () => [...access.values()],
      put: async (record) => void access.set(`${record.repositoryKey}:${record.accountId}`, record),
    },
    projects: {
      list: async () => [
        { id: PROJECT, name: 'api', workspacePath: '/api', available: true, repository: true },
        { id: OTHER, name: 'web', workspacePath: '/web', available: true, repository: true },
        {
          id: '00000000-0000-4000-8000-0000000000a3',
          name: 'gone',
          workspacePath: '/gone',
          available: false,
          repository: true,
        },
      ],
    },
    remoteReader: {
      remotes: async (workspacePath) =>
        (projectRemotes[workspacePath] ?? []).map((remote) => ({ ...remote, pushUrl: null })),
    },
    sshConfig: { read: async () => 'Host github-work\n  HostName github.com\n' },
    credentials: { get: (key) => credentials.get(key) ?? null },
    api,
    clock: { now: () => new Date('2026-10-28T12:00:00.000Z') },
    generateId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    logger: noopLogger,
  });
  return { service, credentials, api, projectRemotes };
}

describe('HostingService (SDD-024 Task 04 Milestone A)', () => {
  it('lists remotes per project without network access and skips missing folders', async () => {
    const { service, api } = fakes();
    const scan = await service.repositories();
    expect(
      scan.remotes.map((remote) => [remote.projectName, remote.remoteName, remote.kind]),
    ).toEqual([
      ['api', 'origin', 'SUPPORTED'],
      ['web', 'mirror', 'UNSUPPORTED_HOST'],
      ['web', 'origin', 'SUPPORTED'],
    ]);
    expect(scan.remotes[0]).toMatchObject({ sshAlias: 'github-work', host: 'github.com' });
    expect(scan.skipped).toEqual([
      expect.objectContaining({ projectName: 'gone', reason: 'The project folder is missing.' }),
    ]);
    expect(api.verify).not.toHaveBeenCalled();
    expect(api.repositoryAccess).not.toHaveBeenCalled();
  });

  it('assigns accounts by alias, by being the only one, by access, or manually', async () => {
    const { service, credentials } = fakes();
    const work = await service.createAccount({
      provider: 'GITHUB',
      label: 'Work',
      sshAliases: ['github-work'],
    });
    let scan = await service.repositories();
    expect(
      scan.remotes.find((r) => r.projectName === 'web' && r.remoteName === 'origin'),
    ).toMatchObject({
      accountId: work.id,
      assignment: 'ONLY_ACCOUNT',
    });
    const personal = await service.createAccount({ provider: 'GITHUB', label: 'Personal' });
    scan = await service.repositories();
    const api = scan.remotes.find((r) => r.projectName === 'api')!;
    const web = scan.remotes.find((r) => r.projectName === 'web' && r.remoteName === 'origin')!;
    expect(api).toMatchObject({ accountId: work.id, assignment: 'SSH_ALIAS' });
    expect(web).toMatchObject({ accountId: null, assignment: null, ambiguous: true });

    credentials.set(work.id, 'can-other');
    credentials.set(personal.id, 'can-acme');
    scan = await service.checkAccess({});
    expect(scan.remotes.find((r) => r.repositoryKey === web.repositoryKey)).toMatchObject({
      accountId: personal.id,
      assignment: 'ACCESS_CHECK',
      access: 'ACCESSIBLE',
    });

    const manual = await service.setRemoteAccount({
      projectId: OTHER,
      remoteName: 'origin',
      accountId: work.id,
    });
    expect(manual).toMatchObject({ accountId: work.id, assignment: 'MANUAL', access: 'NOT_FOUND' });
    await service.removeAccount(work.id);
    scan = await service.repositories();
    expect(scan.remotes.find((r) => r.repositoryKey === web.repositoryKey)).toMatchObject({
      accountId: personal.id,
    });
  });

  it('lets an account tell the provider of an unknown alias, and refuses another provider', async () => {
    const { service } = fakes({
      remotes: {
        '/api': [
          { name: 'origin', fetchUrl: 'git@mystery:team/repo.git' },
          { name: 'odd', fetchUrl: 'git@mystery:just-a-path' },
        ],
        '/web': [{ name: 'origin', fetchUrl: 'https://github.com/acme/web.git' }],
      },
    });
    const bitbucket = await service.createAccount({
      provider: 'BITBUCKET',
      label: 'Team',
      email: 'ana@example.com',
    });
    let scan = await service.repositories();
    expect(scan.remotes.find((r) => r.remoteName === 'origin')).toMatchObject({
      kind: 'UNRESOLVED_ALIAS',
      accountId: null,
    });
    const chosen = await service.setRemoteAccount({
      projectId: PROJECT,
      remoteName: 'origin',
      accountId: bitbucket.id,
    });
    expect(chosen).toMatchObject({
      kind: 'SUPPORTED',
      provider: 'BITBUCKET',
      repositoryKey: 'bitbucket:bitbucket.org/team/repo',
      assignment: 'MANUAL',
    });
    // An alias whose path is not owner/repository cannot become a repository.
    await expect(
      service.setRemoteAccount({ projectId: PROJECT, remoteName: 'odd', accountId: bitbucket.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // A GitHub repository cannot use a Bitbucket account.
    await expect(
      service.setRemoteAccount({ projectId: OTHER, remoteName: 'origin', accountId: bitbucket.id }),
    ).rejects.toMatchObject({ code: 'HOSTING_ACCOUNT_MISMATCH' });
    scan = await service.repositories();
    expect(
      scan.remotes.find((r) => r.projectName === 'api' && r.remoteName === 'origin')!.provider,
    ).toBe('BITBUCKET');
  });

  it('keeps removed remotes until dismissed', async () => {
    const { service, projectRemotes } = fakes();
    await service.repositories();
    projectRemotes['/web'] = [{ name: 'origin', fetchUrl: 'https://github.com/acme/web.git' }];
    const scan = await service.repositories();
    expect(scan.remotes.find((r) => r.remoteName === 'mirror')).toMatchObject({ removed: true });
    await expect(
      service.dismissRemote({ projectId: OTHER, remoteName: 'origin' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await service.dismissRemote({ projectId: OTHER, remoteName: 'mirror' });
    expect((await service.repositories()).remotes.some((r) => r.remoteName === 'mirror')).toBe(
      false,
    );
  });

  it('tests accounts and explains failures without the token', async () => {
    const { service, credentials } = fakes();
    const account = await service.createAccount({ provider: 'GITHUB', label: 'Work' });
    expect(account).toMatchObject({ state: 'UNVERIFIED', hasCredential: false });
    expect(await service.testAccount(account.id)).toMatchObject({ state: 'NO_CREDENTIAL' });
    credentials.set(account.id, 'bad');
    const rejected = await service.testAccount(account.id);
    expect(rejected).toMatchObject({ state: 'INVALID_CREDENTIALS', stateMessage: 'Rejected.' });
    expect(JSON.stringify(rejected)).not.toContain('bad');
    credentials.set(account.id, 'ok');
    expect(await service.testAccount(account.id)).toMatchObject({
      state: 'CONNECTED',
      login: 'user-ok',
      hasCredential: true,
    });
  });

  it('stops asking an account that hit a rate limit', async () => {
    const { service, credentials, api } = fakes();
    const account = await service.createAccount({ provider: 'GITHUB', label: 'Work' });
    credentials.set(account.id, 'limited');
    await service.checkAccess({});
    expect(api.repositoryAccess).toHaveBeenCalledTimes(1);
  });

  it('validates accounts: Bitbucket email, unique aliases', async () => {
    const { service } = fakes();
    await expect(service.createAccount({ provider: 'BITBUCKET', label: 'Team' })).rejects.toSatisfy(
      (error) => isAtlasError(error) && error.issues[0]?.field === 'email',
    );
    await service.createAccount({ provider: 'GITHUB', label: 'A', sshAliases: ['gh'] });
    await expect(
      service.createAccount({ provider: 'GITHUB', label: 'B', sshAliases: ['GH'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.createAccount({ provider: 'GITHUB', label: 'C', sshAliases: ['bad alias*'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
