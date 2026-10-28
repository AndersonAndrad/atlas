import type {
  HostingAccessState,
  HostingAccountState,
  HostingProvider,
  HostingRemoteKind,
} from '@atlas/contracts';
import type {
  HostingAccessRepository,
  HostingAccountRecord,
  HostingAccountRepository,
  HostingRemoteRecord,
  HostingRemoteRepository,
} from '@atlas/hosting';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

interface AccountRow {
  id: string;
  provider: string;
  label: string;
  email: string | null;
  login: string | null;
  display_name: string | null;
  ssh_aliases: string;
  state: string;
  state_message: string | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RemoteRow {
  project_id: string;
  remote_name: string;
  remote_url: string;
  kind: string;
  provider: string | null;
  ssh_alias: string | null;
  host: string | null;
  owner: string | null;
  name: string | null;
  repository_key: string | null;
  manual_account_id: string | null;
  removed_at: string | null;
  updated_at: string;
}

interface AccessRow {
  repository_key: string;
  account_id: string;
  access: string;
  checked_at: string;
}

function toAccount(row: AccountRow): HostingAccountRecord {
  return {
    id: row.id,
    provider: row.provider as HostingProvider,
    label: row.label,
    email: row.email,
    login: row.login,
    displayName: row.display_name,
    sshAliases: JSON.parse(row.ssh_aliases) as string[],
    state: row.state as HostingAccountState,
    stateMessage: row.state_message,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRemote(row: RemoteRow): HostingRemoteRecord {
  return {
    projectId: row.project_id,
    remoteName: row.remote_name,
    remoteUrl: row.remote_url,
    kind: row.kind as HostingRemoteKind,
    provider: row.provider as HostingProvider | null,
    sshAlias: row.ssh_alias,
    host: row.host,
    owner: row.owner,
    name: row.name,
    repositoryKey: row.repository_key,
    manualAccountId: row.manual_account_id,
    removedAt: row.removed_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Hosting accounts, project remotes and access results (migration v24); never tokens. The
 * three ports are separate objects because each names its own `list`.
 */
export class SqliteHostingRepository {
  readonly accounts: HostingAccountRepository;
  readonly remotes: HostingRemoteRepository;
  readonly access: HostingAccessRepository;

  constructor(private readonly db: Database) {
    this.accounts = this.createAccounts();
    this.access = this.createAccess();
    this.remotes = {
      list: async () =>
        this.run('listRemotes', () =>
          (
            this.db
              .prepare('SELECT * FROM hosting_remotes ORDER BY project_id, remote_name')
              .all() as unknown as RemoteRow[]
          ).map(toRemote),
        ),
      upsert: async (record) =>
        this.run('upsertRemote', () => {
          // A project removed meanwhile matches no row in projects: nothing is written.
          this.db
            .prepare(
              `INSERT INTO hosting_remotes (project_id, remote_name, remote_url, kind, provider,
                 ssh_alias, host, owner, name, repository_key, removed_at, updated_at)
               SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM projects WHERE id = ?
               ON CONFLICT (project_id, remote_name) DO UPDATE SET
                 remote_url = excluded.remote_url, kind = excluded.kind,
                 provider = excluded.provider, ssh_alias = excluded.ssh_alias,
                 host = excluded.host, owner = excluded.owner, name = excluded.name,
                 repository_key = excluded.repository_key, removed_at = excluded.removed_at,
                 updated_at = excluded.updated_at`,
            )
            .run(
              record.remoteName,
              record.remoteUrl,
              record.kind,
              record.provider,
              record.sshAlias,
              record.host,
              record.owner,
              record.name,
              record.repositoryKey,
              record.removedAt,
              record.updatedAt,
              record.projectId,
            );
        }),
      setManualAccount: async (projectId, remoteName, accountId) =>
        this.run('setManualAccount', () => {
          this.db
            .prepare(
              `UPDATE hosting_remotes SET manual_account_id = ?
               WHERE project_id = ? AND remote_name = ?`,
            )
            .run(accountId, projectId, remoteName);
        }),
      delete: async (projectId, remoteName) =>
        this.run('deleteRemote', () => {
          this.db
            .prepare('DELETE FROM hosting_remotes WHERE project_id = ? AND remote_name = ?')
            .run(projectId, remoteName);
        }),
    };
  }

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError(
        'PROJECT_PERSISTENCE_ERROR',
        'Hosting accounts and repositories could not be saved.',
        { cause: error, details: { operation } },
      );
    }
  }

  private createAccounts(): HostingAccountRepository {
    return {
      list: async () =>
        this.run('listAccounts', () =>
          (
            this.db
              .prepare('SELECT * FROM hosting_accounts ORDER BY provider, label, created_at')
              .all() as unknown as AccountRow[]
          ).map(toAccount),
        ),
      get: async (id) =>
        this.run('getAccount', () => {
          const row = this.db.prepare('SELECT * FROM hosting_accounts WHERE id = ?').get(id) as
            AccountRow | undefined;
          return row === undefined ? null : toAccount(row);
        }),
      insert: async (record) =>
        this.run('insertAccount', () => {
          this.db
            .prepare(
              `INSERT INTO hosting_accounts (id, provider, label, email, login, display_name,
                 ssh_aliases, state, state_message, checked_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(...this.accountValues(record));
        }),
      update: async (record) =>
        this.run('updateAccount', () => {
          const [id = null, ...rest] = this.accountValues(record);
          this.db
            .prepare(
              `UPDATE hosting_accounts SET provider = ?, label = ?, email = ?, login = ?,
                 display_name = ?, ssh_aliases = ?, state = ?, state_message = ?,
                 checked_at = ?, created_at = ?, updated_at = ? WHERE id = ?`,
            )
            .run(...rest, id);
        }),
      remove: async (id) =>
        this.run('removeAccount', () => {
          this.db.prepare('DELETE FROM hosting_accounts WHERE id = ?').run(id);
        }),
    };
  }

  private createAccess(): HostingAccessRepository {
    return {
      list: async () =>
        this.run('listAccess', () =>
          (
            this.db
              .prepare('SELECT * FROM hosting_repository_access')
              .all() as unknown as AccessRow[]
          ).map((row) => ({
            repositoryKey: row.repository_key,
            accountId: row.account_id,
            access: row.access as HostingAccessState,
            checkedAt: row.checked_at,
          })),
        ),
      put: async (record) =>
        this.run('putAccess', () => {
          // An account removed meanwhile matches no row: nothing is written.
          this.db
            .prepare(
              `INSERT INTO hosting_repository_access (repository_key, account_id, access,
                 checked_at)
               SELECT ?, id, ?, ? FROM hosting_accounts WHERE id = ?
               ON CONFLICT (repository_key, account_id) DO UPDATE SET
                 access = excluded.access, checked_at = excluded.checked_at`,
            )
            .run(record.repositoryKey, record.access, record.checkedAt, record.accountId);
        }),
    };
  }

  private accountValues(record: HostingAccountRecord): (string | null)[] {
    return [
      record.id,
      record.provider,
      record.label,
      record.email,
      record.login,
      record.displayName,
      JSON.stringify(record.sshAliases),
      record.state,
      record.stateMessage?.slice(0, 300) ?? null,
      record.checkedAt,
      record.createdAt,
      record.updatedAt,
    ];
  }
}
