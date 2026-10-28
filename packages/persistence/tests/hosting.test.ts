import path from 'node:path';
import type { HostingAccountRecord } from '@atlas/hosting';
import {
  MIGRATIONS,
  SqliteHostingRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir } from '../../../tests/support/temp.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const WORK = '00000000-0000-4000-8000-00000000000a';
const HOME = '00000000-0000-4000-8000-00000000000b';

const account = (
  id: string,
  overrides: Partial<HostingAccountRecord> = {},
): HostingAccountRecord => ({
  id,
  provider: 'GITHUB',
  label: id === WORK ? 'Work' : 'Personal',
  email: null,
  login: null,
  displayName: null,
  sshAliases: [],
  state: 'UNVERIFIED',
  stateMessage: null,
  checkedAt: null,
  createdAt: '2026-10-28T10:00:00.000Z',
  updatedAt: '2026-10-28T10:00:00.000Z',
  ...overrides,
});

const remote = {
  projectId: PROJECT,
  remoteName: 'origin',
  remoteUrl: 'git@github-work:acme/api.git',
  kind: 'SUPPORTED' as const,
  provider: 'GITHUB' as const,
  sshAlias: 'github-work',
  host: 'github.com',
  owner: 'acme',
  name: 'api',
  repositoryKey: 'github:github.com/acme/api',
  removedAt: null,
  updatedAt: '2026-10-28T10:00:00.000Z',
};

describe('hosting accounts and remotes in SQLite (migration v24)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let db: Database;
  let store: SqliteHostingRepository;

  beforeEach(() => {
    temp = createTempDir();
    db = openDatabase({ filePath: path.join(temp.dir, 'atlas.db') });
    store = new SqliteHostingRepository(db);
    db.prepare(
      `INSERT INTO projects (id, name, workspace_path, path_key, tags, is_git_repository,
         created_at, updated_at) VALUES (?, 'api', '/api', '/api', '[]', 1, 'x', 'x')`,
    ).run(PROJECT);
  });

  afterEach(() => {
    db.close();
    temp.cleanup();
  });

  it('migrates a v23 database without touching existing data', () => {
    db.close();
    const file = path.join(temp.dir, 'v23.db');
    db = openDatabase({ filePath: file, migrations: MIGRATIONS.slice(0, 23) });
    expect(getSchemaVersion(db)).toBe(23);
    db.close();
    db = openDatabase({ filePath: file });
    expect(getSchemaVersion(db)).toBe(25);
    expect(db.prepare('SELECT COUNT(*) AS n FROM hosting_accounts').get()).toEqual({ n: 0 });
  });

  it('stores account metadata, never a token column', async () => {
    await store.accounts.insert(account(WORK, { sshAliases: ['github-work'] }));
    await store.accounts.update(
      account(WORK, { sshAliases: ['github-work'], login: 'ana', state: 'CONNECTED' }),
    );
    expect(await store.accounts.get(WORK)).toMatchObject({
      login: 'ana',
      state: 'CONNECTED',
      sshAliases: ['github-work'],
    });
    const columns = (
      db.prepare('PRAGMA table_info(hosting_accounts)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns.some((name) => /token|secret|password/i.test(name))).toBe(false);
  });

  it('keeps the manual choice when a remote is scanned again', async () => {
    await store.accounts.insert(account(WORK));
    await store.remotes.upsert(remote);
    await store.remotes.setManualAccount(PROJECT, 'origin', WORK);
    await store.remotes.upsert({ ...remote, remoteUrl: 'git@github.com:acme/api.git' });
    expect(await store.remotes.list()).toEqual([
      expect.objectContaining({ remoteUrl: 'git@github.com:acme/api.git', manualAccountId: WORK }),
    ]);
  });

  it('clears manual choices and access results of a removed account', async () => {
    await store.accounts.insert(account(WORK));
    await store.accounts.insert(account(HOME));
    await store.remotes.upsert(remote);
    await store.remotes.setManualAccount(PROJECT, 'origin', WORK);
    const checkedAt = '2026-10-28T11:00:00.000Z';
    await store.access.put({
      repositoryKey: remote.repositoryKey,
      accountId: WORK,
      access: 'ACCESSIBLE',
      checkedAt,
    });
    await store.access.put({
      repositoryKey: remote.repositoryKey,
      accountId: HOME,
      access: 'NOT_FOUND',
      checkedAt,
    });
    await store.accounts.remove(WORK);
    expect((await store.remotes.list())[0]!.manualAccountId).toBeNull();
    expect(await store.access.list()).toEqual([
      expect.objectContaining({ accountId: HOME, access: 'NOT_FOUND' }),
    ]);
  });

  it('ignores writes for a removed project or account and deletes remotes with their project', async () => {
    await store.access.put({
      repositoryKey: 'x',
      accountId: WORK,
      access: 'ACCESSIBLE',
      checkedAt: '2026-10-28T11:00:00.000Z',
    });
    expect(await store.access.list()).toEqual([]);
    await store.remotes.upsert({ ...remote, projectId: '00000000-0000-4000-8000-0000000000ff' });
    expect(await store.remotes.list()).toEqual([]);
    await store.remotes.upsert(remote);
    db.prepare('DELETE FROM projects WHERE id = ?').run(PROJECT);
    expect(await store.remotes.list()).toEqual([]);
  });
});
