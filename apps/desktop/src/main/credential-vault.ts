import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HostingCredentialStoreStatus } from '@atlas/contracts';
import { AtlasError, type Logger } from '@atlas/shared';

/** The part of Electron's `safeStorage` the vault uses; injectable for tests. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: which secret store encrypts, or `basic_text` when none. */
  getSelectedStorageBackend?(): string;
}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE = /^hosting-([0-9a-f-]{36})\.bin$/i;

/**
 * Hosting tokens encrypted with the operating system's secret store (SDD-024 Task 04,
 * FR-020): Keychain on macOS, DPAPI on Windows, libsecret or KWallet on Linux. Each token
 * is its own file, readable only by the user, outside SQLite. On Linux without a secret
 * store Electron would fall back to a hard-coded key, so tokens are refused (PLAN-059 Q2).
 * Plain tokens leave this class only towards the Engine host.
 */
export class HostingCredentialVault {
  constructor(
    private readonly options: {
      directory: string;
      /** Read on every use, so the current `safeStorage` object is always consulted. */
      safeStorage: () => SafeStorageLike;
      platform: NodeJS.Platform;
      logger: Logger;
    },
  ) {}

  status(): HostingCredentialStoreStatus {
    const storage = this.options.safeStorage();
    let available: boolean;
    try {
      available = storage.isEncryptionAvailable();
    } catch {
      available = false;
    }
    if (!available) {
      return {
        available: false,
        reason: 'The system secret store is not available, so tokens cannot be encrypted.',
      };
    }
    if (this.options.platform === 'linux') {
      const backend = storage.getSelectedStorageBackend?.() ?? 'unknown';
      if (backend === 'basic_text' || backend === 'unknown') {
        return {
          available: false,
          reason:
            'No secret service (GNOME Keyring or KWallet) is running, so tokens would not be encrypted.',
        };
      }
    }
    return { available: true, reason: null };
  }

  async save(accountId: string, token: string): Promise<void> {
    this.assertId(accountId);
    if (!this.status().available) throw new AtlasError('HOSTING_CREDENTIAL_STORE_UNAVAILABLE');
    const encrypted = this.options.safeStorage().encryptString(token);
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const file = this.file(accountId);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await rename(temporary, file);
    this.options.logger.info('Hosting token stored', { accountId });
  }

  async remove(accountId: string): Promise<void> {
    this.assertId(accountId);
    await rm(this.file(accountId), { force: true });
  }

  /** Every stored token that can still be decrypted; others are reported and skipped. */
  async readAll(): Promise<{ accountId: string; token: string }[]> {
    const entries = await readdir(this.options.directory).catch(() => [] as string[]);
    const result: { accountId: string; token: string }[] = [];
    for (const entry of entries) {
      const accountId = FILE.exec(entry)?.[1];
      if (accountId === undefined || !ACCOUNT_ID.test(accountId)) continue;
      try {
        const encrypted = await readFile(path.join(this.options.directory, entry));
        result.push({ accountId, token: this.options.safeStorage().decryptString(encrypted) });
      } catch (error) {
        // Another computer, user or keychain: the token must be entered again (PLAN-059 R8).
        this.options.logger.warn('A stored hosting token could not be decrypted', {
          accountId,
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    return result;
  }

  private file(accountId: string): string {
    return path.join(this.options.directory, `hosting-${accountId.toLowerCase()}.bin`);
  }

  private assertId(accountId: string): void {
    if (!ACCOUNT_ID.test(accountId)) throw new AtlasError('HOSTING_ACCOUNT_NOT_FOUND');
  }
}
