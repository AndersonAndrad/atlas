import {
  CheckHostingAccessSchema,
  CreateHostingAccountSchema,
  HOSTING_ACCESS_CHECK_MAX_REMOTES,
  HostingAccountIdSchema,
  HostingRemoteRefSchema,
  SetHostingRemoteAccountSchema,
  UpdateHostingAccountSchema,
  parseInput,
  type HostingAccessState,
  type HostingAccount,
  type HostingAccountState,
  type HostingAssignment,
  type HostingProvider,
  type HostingRemote,
  type HostingRepositoryScan,
} from '@atlas/contracts';
import { AtlasError, describeError } from '@atlas/shared';
import {
  HostingApiError,
  type HostingAccessRecord,
  type HostingAccountRecord,
  type HostingCredential,
  type HostingRemoteRecord,
  type HostingServiceDependencies,
} from './ports.js';
import {
  classifyRemote,
  parseRemoteUrl,
  repositoryKey,
  repositoryPath,
  sanitizeRemoteUrl,
} from './remote-url.js';
import { resolveSshAlias } from './ssh-config.js';

/** Remote reads in parallel while scanning projects. */
const SCAN_CONCURRENCY = 4;

const FAILURE_STATES: Record<HostingApiError['failure'], HostingAccountState> = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  RATE_LIMITED: 'RATE_LIMITED',
  UNREACHABLE: 'UNREACHABLE',
  ERROR: 'ERROR',
};

const lower = (value: string) => value.toLowerCase();

/**
 * Repositories and hosting accounts of the Pull Request Center (SDD-024 Task 04 Milestone
 * A). Discovery reads Git remotes and the SSH configuration only; the network is used when
 * an account is tested or access is checked, both on request (PLAN-059 Q5).
 */
export class HostingService {
  private scanning: Promise<HostingRepositoryScan> | null = null;

  constructor(private readonly deps: HostingServiceDependencies) {}

  async accounts(): Promise<HostingAccount[]> {
    return (await this.deps.accounts.list()).map((record) => this.toAccount(record));
  }

  async createAccount(input: unknown): Promise<HostingAccount> {
    const value = parseInput(CreateHostingAccountSchema, input);
    const aliases = value.sshAliases ?? [];
    await this.assertAliasesFree(aliases, null);
    const now = this.now();
    const record: HostingAccountRecord = {
      id: this.deps.generateId(),
      provider: value.provider,
      label: value.label,
      email: value.provider === 'BITBUCKET' ? (value.email ?? null) : null,
      login: null,
      displayName: null,
      sshAliases: aliases,
      state: 'UNVERIFIED',
      stateMessage: null,
      checkedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.accounts.insert(record);
    this.deps.logger.info('Hosting account added', {
      accountId: record.id,
      provider: record.provider,
    });
    return this.toAccount(record);
  }

  async updateAccount(input: unknown): Promise<HostingAccount> {
    const value = parseInput(UpdateHostingAccountSchema, input);
    const existing = await this.requireAccount(value.accountId);
    if (value.sshAliases !== undefined) await this.assertAliasesFree(value.sshAliases, existing.id);
    if (existing.provider === 'BITBUCKET' && value.email === null) {
      throw new AtlasError('VALIDATION_FAILED', 'Bitbucket accounts need an email.', {
        issues: [
          {
            field: 'email',
            message: 'Bitbucket API tokens are used with the email of your Atlassian account.',
          },
        ],
      });
    }
    const emailChanged =
      existing.provider === 'BITBUCKET' && value.email != null && value.email !== existing.email;
    const updated: HostingAccountRecord = {
      ...existing,
      label: value.label ?? existing.label,
      email: existing.provider === 'BITBUCKET' ? (value.email ?? existing.email) : null,
      sshAliases: value.sshAliases ?? existing.sshAliases,
      // Another email authenticates differently: the last test no longer says anything.
      ...(emailChanged ? { state: 'UNVERIFIED' as const, stateMessage: null } : {}),
      updatedAt: this.now(),
    };
    await this.deps.accounts.update(updated);
    return this.toAccount(updated);
  }

  async removeAccount(input: unknown): Promise<void> {
    const id = parseInput(HostingAccountIdSchema, input);
    await this.requireAccount(id);
    await this.deps.accounts.remove(id);
    this.deps.logger.info('Hosting account removed', { accountId: id });
  }

  /** Calls the provider with the stored token and records what it answered (FR-003). */
  async testAccount(input: unknown): Promise<HostingAccount> {
    const id = parseInput(HostingAccountIdSchema, input);
    const account = await this.requireAccount(id);
    const credential = this.credentialOf(account);
    let updated: HostingAccountRecord;
    if (credential === null) {
      updated = {
        ...account,
        state: 'NO_CREDENTIAL',
        stateMessage: 'No token is stored for this account.',
      };
    } else {
      try {
        const user = await this.deps.api.verify(account.provider, credential);
        updated = {
          ...account,
          login: user.login,
          displayName: user.displayName,
          state: 'CONNECTED',
          stateMessage: null,
        };
      } catch (error) {
        const failure = this.failure(error);
        this.deps.logger.info('Hosting account test failed', {
          accountId: id,
          provider: account.provider,
          failure: failure.state,
        });
        updated = { ...account, state: failure.state, stateMessage: failure.message };
      }
    }
    const now = this.now();
    updated = { ...updated, checkedAt: now, updatedAt: now };
    await this.deps.accounts.update(updated);
    return this.toAccount(updated);
  }

  /**
   * Reads the remotes of every registered project (FR-001, FR-004) without network access.
   * Concurrent calls share one scan.
   */
  repositories(): Promise<HostingRepositoryScan> {
    this.scanning ??= this.scan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async setRemoteAccount(input: unknown): Promise<HostingRemote> {
    const value = parseInput(SetHostingRemoteAccountSchema, input);
    const record = await this.requireRemote(value.projectId, value.remoteName);
    if (value.accountId !== null) {
      const account = await this.requireAccount(value.accountId);
      const provider =
        record.provider ?? (record.kind === 'UNRESOLVED_ALIAS' ? account.provider : null);
      if (provider === null || provider !== account.provider) {
        throw new AtlasError('HOSTING_ACCOUNT_MISMATCH');
      }
      const parsed = parseRemoteUrl(record.remoteUrl);
      if (parsed === null || repositoryPath(parsed.path) === null) {
        throw new AtlasError('VALIDATION_FAILED', 'This remote does not name owner/repository.', {
          issues: [{ field: 'remoteName', message: 'This remote does not name owner/repository.' }],
        });
      }
    }
    await this.deps.remotes.setManualAccount(value.projectId, value.remoteName, value.accountId);
    const remote = (await this.view()).remotes.find(
      (item) => item.projectId === value.projectId && item.remoteName === value.remoteName,
    );
    if (remote === undefined) throw new AtlasError('HOSTING_REPOSITORY_NOT_FOUND');
    return remote;
  }

  /** Forgets a remote that no longer exists in its project. */
  async dismissRemote(input: unknown): Promise<void> {
    const value = parseInput(HostingRemoteRefSchema, input);
    const record = await this.requireRemote(value.projectId, value.remoteName);
    if (record.removedAt === null) {
      throw new AtlasError('VALIDATION_FAILED', 'Only removed remotes can be dismissed.');
    }
    await this.deps.remotes.delete(value.projectId, value.remoteName);
  }

  /**
   * Asks each provider whether the candidate accounts can read the repositories (FR-004),
   * at most HOSTING_ACCESS_CHECK_MAX_REMOTES repositories per call. An account that hits a
   * rate limit or cannot be reached is not asked again in the same call.
   */
  async checkAccess(input: unknown): Promise<HostingRepositoryScan> {
    const value = parseInput(CheckHostingAccessSchema, input);
    const scan = await this.repositories();
    const accounts = await this.deps.accounts.list();
    const targets = new Map<string, HostingRemote>();
    for (const remote of scan.remotes) {
      if (remote.kind !== 'SUPPORTED' || remote.removed || remote.repositoryKey === null) continue;
      if (value.projectId !== undefined && remote.projectId !== value.projectId) continue;
      if (!targets.has(remote.repositoryKey)) targets.set(remote.repositoryKey, remote);
    }
    const skipped = new Set<string>();
    for (const remote of [...targets.values()].slice(0, HOSTING_ACCESS_CHECK_MAX_REMOTES)) {
      const candidates =
        remote.assignment === 'MANUAL' && remote.accountId !== null
          ? accounts.filter((account) => account.id === remote.accountId)
          : accounts.filter((account) => account.provider === remote.provider);
      for (const account of candidates) {
        if (skipped.has(account.id)) continue;
        const credential = this.credentialOf(account);
        if (credential === null) continue;
        let access: HostingAccessState;
        try {
          access = await this.deps.api.repositoryAccess(
            account.provider,
            credential,
            remote.owner!,
            remote.name!,
          );
        } catch (error) {
          const failure = this.failure(error);
          access = 'ERROR';
          if (failure.state !== 'ERROR') skipped.add(account.id);
          this.deps.logger.info('Hosting access check failed', {
            accountId: account.id,
            provider: account.provider,
            failure: failure.state,
          });
        }
        await this.deps.access.put({
          repositoryKey: remote.repositoryKey!,
          accountId: account.id,
          access,
          checkedAt: this.now(),
        });
      }
    }
    return this.view(scan.skipped, scan.sshConfigFound);
  }

  private async scan(): Promise<HostingRepositoryScan> {
    const projects = await this.deps.projects.list();
    const sshConfig = await this.deps.sshConfig.read().catch((error: unknown) => {
      this.deps.logger.warn('SSH configuration could not be read', {
        error: describeError(error),
      });
      return null;
    });
    const accounts = await this.deps.accounts.list();
    const aliasCache = new Map<string, string | null>();
    const resolveAlias = (alias: string) => {
      if (!aliasCache.has(alias)) {
        aliasCache.set(
          alias,
          sshConfig === null ? null : resolveSshAlias(sshConfig, alias).hostName,
        );
      }
      return aliasCache.get(alias)!;
    };
    const providerOfAlias = (alias: string): HostingProvider | null => {
      const providers = new Set(
        accounts
          .filter((account) => account.sshAliases.some((item) => lower(item) === lower(alias)))
          .map((account) => account.provider),
      );
      return providers.size === 1 ? [...providers][0]! : null;
    };

    const existing = await this.deps.remotes.list();
    const skipped: HostingRepositoryScan['skipped'] = [];
    const now = this.now();
    const queue = [...projects];
    const worker = async () => {
      for (let project = queue.shift(); project !== undefined; project = queue.shift()) {
        if (!project.available) {
          skipped.push({
            projectId: project.id,
            projectName: project.name,
            reason: 'The project folder is missing.',
          });
          continue;
        }
        // Not a Git repository: nothing to discover, and nothing to report.
        if (!project.repository) continue;
        let remotes: Awaited<ReturnType<typeof this.deps.remoteReader.remotes>>;
        try {
          remotes = await this.deps.remoteReader.remotes(project.workspacePath);
        } catch (error) {
          skipped.push({
            projectId: project.id,
            projectName: project.name,
            reason: 'Its Git remotes could not be read.',
          });
          this.deps.logger.warn('Git remotes could not be read', {
            projectId: project.id,
            error: describeError(error),
          });
          continue;
        }
        const seen = new Set<string>();
        for (const remote of remotes) {
          const url = remote.fetchUrl ?? remote.pushUrl;
          if (url === null) continue;
          seen.add(remote.name);
          const found = classifyRemote(url, { resolveAlias, providerOfAlias });
          await this.deps.remotes.upsert({
            projectId: project.id,
            remoteName: remote.name,
            remoteUrl: sanitizeRemoteUrl(url),
            ...found,
            removedAt: null,
            updatedAt: now,
          });
        }
        // Remotes that disappeared stay listed as removed until dismissed (FR-004).
        for (const record of existing) {
          if (record.projectId !== project.id || seen.has(record.remoteName)) continue;
          if (record.removedAt !== null) continue;
          await this.deps.remotes.upsert({ ...record, removedAt: now, updatedAt: now });
        }
      }
    };
    await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
    return this.view(skipped, sshConfig !== null);
  }

  /** Remotes with their account resolved by FR-002's precedence. */
  private async view(
    skipped: HostingRepositoryScan['skipped'] = [],
    sshConfigFound = false,
  ): Promise<HostingRepositoryScan> {
    const [records, accounts, accessRecords, projects] = await Promise.all([
      this.deps.remotes.list(),
      this.deps.accounts.list(),
      this.deps.access.list(),
      this.deps.projects.list(),
    ]);
    const names = new Map(projects.map((project) => [project.id, project.name]));
    const access = new Map<string, HostingAccessRecord>(
      accessRecords.map((record) => [`${record.repositoryKey}\n${record.accountId}`, record]),
    );
    const remotes = records
      .filter((record) => names.has(record.projectId))
      .map((record) => this.toRemote(record, names.get(record.projectId)!, accounts, access))
      .sort(
        (a, b) =>
          a.projectName.localeCompare(b.projectName) || a.remoteName.localeCompare(b.remoteName),
      );
    return {
      remotes,
      skipped: [...skipped].sort((a, b) => a.projectName.localeCompare(b.projectName)),
      sshConfigFound,
      scannedAt: this.now(),
    };
  }

  private toRemote(
    record: HostingRemoteRecord,
    projectName: string,
    accounts: HostingAccountRecord[],
    access: Map<string, HostingAccessRecord>,
  ): HostingRemote {
    const manual = accounts.find((account) => account.id === record.manualAccountId) ?? null;
    let { kind, provider, owner, name, repositoryKey: key } = record;
    // A manual account tells the provider of an alias ATLAS could not resolve.
    if (kind === 'UNRESOLVED_ALIAS' && manual !== null) {
      const parsed = parseRemoteUrl(record.remoteUrl);
      const path = parsed === null ? null : repositoryPath(parsed.path);
      if (path !== null) {
        kind = 'SUPPORTED';
        provider = manual.provider;
        owner = path.owner;
        name = path.name;
        key = repositoryKey(manual.provider, path.owner, path.name);
      }
    }
    const base = {
      projectId: record.projectId,
      projectName,
      remoteName: record.remoteName,
      remoteUrl: record.remoteUrl,
      kind,
      provider,
      sshAlias: record.sshAlias,
      host: record.host,
      owner,
      name,
      repositoryKey: key,
      removed: record.removedAt !== null,
    };
    if (kind !== 'SUPPORTED' || provider === null || key === null) {
      return {
        ...base,
        accountId: null,
        assignment: null,
        ambiguous: false,
        access: 'UNKNOWN',
        accessCheckedAt: null,
      };
    }
    const candidates = accounts.filter((account) => account.provider === provider);
    const accessOf = (accountId: string) => access.get(`${key}\n${accountId}`);
    let chosen: HostingAccountRecord | null = null;
    let assignment: HostingAssignment | null = null;
    const byAlias =
      record.sshAlias === null
        ? []
        : candidates.filter((account) =>
            account.sshAliases.some((alias) => lower(alias) === lower(record.sshAlias!)),
          );
    const accessible = candidates.filter(
      (account) => accessOf(account.id)?.access === 'ACCESSIBLE',
    );
    if (manual !== null && manual.provider === provider) {
      [chosen, assignment] = [manual, 'MANUAL'];
    } else if (byAlias.length === 1) {
      [chosen, assignment] = [byAlias[0]!, 'SSH_ALIAS'];
    } else if (candidates.length === 1) {
      [chosen, assignment] = [candidates[0]!, 'ONLY_ACCOUNT'];
    } else if (accessible.length === 1) {
      [chosen, assignment] = [accessible[0]!, 'ACCESS_CHECK'];
    }
    const checked = chosen === null ? undefined : accessOf(chosen.id);
    return {
      ...base,
      accountId: chosen?.id ?? null,
      assignment,
      ambiguous: chosen === null && candidates.length > 1,
      access: checked?.access ?? 'UNKNOWN',
      accessCheckedAt: checked?.checkedAt ?? null,
    };
  }

  private toAccount(record: HostingAccountRecord): HostingAccount {
    return { ...record, hasCredential: this.deps.credentials.get(record.id) !== null };
  }

  private credentialOf(account: HostingAccountRecord): HostingCredential | null {
    const token = this.deps.credentials.get(account.id);
    return token === null ? null : { email: account.email, token };
  }

  private failure(error: unknown): { state: HostingAccountState; message: string } {
    if (error instanceof HostingApiError) {
      return { state: FAILURE_STATES[error.failure], message: error.message };
    }
    this.deps.logger.warn('Unexpected hosting provider failure', { error: describeError(error) });
    return { state: 'ERROR', message: 'The provider could not be reached.' };
  }

  private async assertAliasesFree(aliases: string[], ownerId: string | null): Promise<void> {
    if (aliases.length === 0) return;
    const taken = new Set(
      (await this.deps.accounts.list())
        .filter((account) => account.id !== ownerId)
        .flatMap((account) => account.sshAliases.map(lower)),
    );
    const clash = aliases.find((alias) => taken.has(lower(alias)));
    if (clash !== undefined) {
      throw new AtlasError('VALIDATION_FAILED', 'SSH alias already used.', {
        issues: [
          { field: 'sshAliases', message: `"${clash}" is already used by another account.` },
        ],
      });
    }
  }

  private async requireAccount(id: string): Promise<HostingAccountRecord> {
    const account = await this.deps.accounts.get(id);
    if (account === null) throw new AtlasError('HOSTING_ACCOUNT_NOT_FOUND');
    return account;
  }

  private async requireRemote(projectId: string, remoteName: string): Promise<HostingRemoteRecord> {
    const record = (await this.deps.remotes.list()).find(
      (item) => item.projectId === projectId && item.remoteName === remoteName,
    );
    if (record === undefined) throw new AtlasError('HOSTING_REPOSITORY_NOT_FOUND');
    return record;
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }
}
