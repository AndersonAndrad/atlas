import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { noopLogger } from '@atlas/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir } from '../../../tests/support/temp.js';
import { HostingCredentialVault, type SafeStorageLike } from '../src/main/credential-vault.js';

const ID = '00000000-0000-4000-8000-00000000000a';

/** Reversible stand-in for the system secret store. */
function storage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
    decryptString: (data) => {
      const text = data.toString();
      if (!text.startsWith('enc:')) throw new Error('cannot decrypt');
      return Buffer.from(text.slice(4), 'base64').toString();
    },
    getSelectedStorageBackend: () => 'gnome_libsecret',
    ...overrides,
  };
}

describe('HostingCredentialVault (SDD-024 Task 04, FR-020)', () => {
  let temp: ReturnType<typeof createTempDir>;
  let directory: string;
  const vault = (safe: SafeStorageLike, platform: NodeJS.Platform = 'darwin') =>
    new HostingCredentialVault({
      directory,
      safeStorage: () => safe,
      platform,
      logger: noopLogger,
    });

  beforeEach(() => {
    temp = createTempDir();
    directory = path.join(temp.dir, 'credentials');
  });
  afterEach(() => temp.cleanup());

  it('encrypts each token in its own private file and reads it back', async () => {
    const store = vault(storage());
    await store.save(ID, 'ghp_secret');
    const file = path.join(directory, `hosting-${ID}.bin`);
    expect(readFileSync(file, 'utf8')).not.toContain('ghp_secret');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(await store.readAll()).toEqual([{ accountId: ID, token: 'ghp_secret' }]);
    await store.remove(ID);
    expect(await store.readAll()).toEqual([]);
  });

  it('refuses to store tokens without a real secret store (PLAN-059 Q2)', async () => {
    expect(vault(storage({ isEncryptionAvailable: () => false })).status().available).toBe(false);
    const linux = vault(storage({ getSelectedStorageBackend: () => 'basic_text' }), 'linux');
    expect(linux.status()).toMatchObject({ available: false });
    await expect(linux.save(ID, 'ghp_secret')).rejects.toMatchObject({
      code: 'HOSTING_CREDENTIAL_STORE_UNAVAILABLE',
    });
    expect(vault(storage(), 'linux').status()).toEqual({ available: true, reason: null });
  });

  it('skips tokens it cannot decrypt and ignores unrelated files', async () => {
    const store = vault(storage());
    await store.save(ID, 'ghp_secret');
    writeFileSync(path.join(directory, 'hosting-00000000-0000-4000-8000-00000000000b.bin'), 'x');
    writeFileSync(path.join(directory, 'notes.txt'), 'enc:eA==');
    expect(await store.readAll()).toEqual([{ accountId: ID, token: 'ghp_secret' }]);
    await expect(store.save('../../escape', 'x')).rejects.toMatchObject({
      code: 'HOSTING_ACCOUNT_NOT_FOUND',
    });
  });
});
