import type {
  HostingAccessState,
  HostingAccountState,
  HostingProvider,
  HostingRemoteKind,
} from '@atlas/contracts';
import type { Logger } from '@atlas/shared';

/** A hosting account as stored: metadata only, never a token (FR-020). */
export interface HostingAccountRecord {
  id: string;
  provider: HostingProvider;
  label: string;
  email: string | null;
  login: string | null;
  displayName: string | null;
  sshAliases: string[];
  state: HostingAccountState;
  stateMessage: string | null;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HostingAccountRepository {
  list(): Promise<HostingAccountRecord[]>;
  get(id: string): Promise<HostingAccountRecord | null>;
  insert(record: HostingAccountRecord): Promise<void>;
  update(record: HostingAccountRecord): Promise<void>;
  /** Manual choices pointing at the account are cleared; its access results removed. */
  remove(id: string): Promise<void>;
}

/** A remote of a registered project, as last scanned. */
export interface HostingRemoteRecord {
  projectId: string;
  remoteName: string;
  /** Without credentials. */
  remoteUrl: string;
  kind: HostingRemoteKind;
  provider: HostingProvider | null;
  sshAlias: string | null;
  host: string | null;
  owner: string | null;
  name: string | null;
  repositoryKey: string | null;
  /** The user's choice (FR-002); null for automatic assignment. */
  manualAccountId: string | null;
  removedAt: string | null;
  updatedAt: string;
}

export interface HostingRemoteRepository {
  list(): Promise<HostingRemoteRecord[]>;
  /** Inserts or updates by project and remote name; keeps the manual choice. */
  upsert(record: Omit<HostingRemoteRecord, 'manualAccountId'>): Promise<void>;
  setManualAccount(projectId: string, remoteName: string, accountId: string | null): Promise<void>;
  delete(projectId: string, remoteName: string): Promise<void>;
}

export interface HostingAccessRecord {
  repositoryKey: string;
  accountId: string;
  access: HostingAccessState;
  checkedAt: string;
}

export interface HostingAccessRepository {
  list(): Promise<HostingAccessRecord[]>;
  put(record: HostingAccessRecord): Promise<void>;
}

/** Registered projects, as far as remote discovery needs them. */
export interface HostingProjectSource {
  list(): Promise<
    { id: string; name: string; workspacePath: string; available: boolean; repository: boolean }[]
  >;
}

/** Reads `git remote -v` of a project folder; throws when it is not a repository. */
export interface HostingRemoteReader {
  remotes(
    workspacePath: string,
  ): Promise<{ name: string; fetchUrl: string | null; pushUrl: string | null }[]>;
}

/** The user's SSH client configuration with its Include files inlined; null when absent. */
export interface SshConfigSource {
  read(): Promise<string | null>;
}

/** Tokens held by the Engine host for the running session; set by the main process. */
export interface HostingCredentialSource {
  get(accountId: string): string | null;
}

export interface HostingCredential {
  /** Bitbucket uses the Atlassian account email with the API token; GitHub only the token. */
  email: string | null;
  token: string;
}

/** A provider answer, mapped to what ATLAS can explain (FR-003, FR-011). */
export type HostingApiFailure =
  'INVALID_CREDENTIALS' | 'PERMISSION_DENIED' | 'RATE_LIMITED' | 'UNREACHABLE' | 'ERROR';

export class HostingApiError extends Error {
  constructor(
    readonly failure: HostingApiFailure,
    /** Short and safe to show; never contains a token or a response body. */
    message: string,
  ) {
    super(message);
    this.name = 'HostingApiError';
  }
}

/** Read-only provider calls; implemented in the Engine with timeouts and size limits. */
export interface HostingApi {
  /** The authenticated user, or a HostingApiError. */
  verify(
    provider: HostingProvider,
    credential: HostingCredential,
  ): Promise<{ login: string; displayName: string | null }>;
  /** Whether the account can read the repository; HostingApiError for other failures. */
  repositoryAccess(
    provider: HostingProvider,
    credential: HostingCredential,
    owner: string,
    name: string,
  ): Promise<'ACCESSIBLE' | 'NOT_FOUND'>;
}

export interface HostingServiceDependencies {
  accounts: HostingAccountRepository;
  remotes: HostingRemoteRepository;
  access: HostingAccessRepository;
  projects: HostingProjectSource;
  remoteReader: HostingRemoteReader;
  sshConfig: SshConfigSource;
  credentials: HostingCredentialSource;
  api: HostingApi;
  clock: { now(): Date };
  generateId: () => string;
  logger: Logger;
}
