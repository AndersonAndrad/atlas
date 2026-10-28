import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures';

// SDD-024 Task 04 Milestone A: hosting accounts and repositories, against a fake GitHub API.

const navigate = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name }).click();

/** Stands in for the system secret store, which Xvfb containers do not have. */
async function stubSecretStore(app: ElectronApplication, available: boolean) {
  await app.evaluate(({ safeStorage }, enabled) => {
    const storage = safeStorage as unknown as Record<string, unknown>;
    storage.isEncryptionAvailable = () => enabled;
    storage.getSelectedStorageBackend = () => 'gnome_libsecret';
    storage.encryptString = (text: string) =>
      Buffer.from(`e2e:${Buffer.from(text).toString('base64')}`);
    storage.decryptString = (data: Buffer) =>
      Buffer.from(data.toString().slice(4), 'base64').toString();
  }, available);
}

function fakeGitHub() {
  const server = http.createServer((req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (token !== 'ghp_good' && token !== 'ghp_other')
      return send(401, { message: 'Bad credentials' });
    if (req.url === '/user') return send(200, { login: token === 'ghp_good' ? 'ana' : 'bia' });
    if (req.url === '/repos/acme/site' && token === 'ghp_good') return send(200, {});
    return send(404, { message: 'Not Found' });
  });
  return server;
}

test('connects GitHub accounts and assigns them to project remotes', async ({ atlas }) => {
  const server = fakeGitHub();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const home = path.join(atlas.root, 'home');
    mkdirSync(path.join(home, '.ssh'), { recursive: true });
    writeFileSync(path.join(home, '.ssh', 'config'), 'Host gh-work\n  HostName github.com\n');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd });
    const api = atlas.workspace('api');
    git(api, 'init', '-q');
    git(api, 'remote', 'add', 'origin', 'git@gh-work:acme/api.git');
    git(api, 'remote', 'add', 'mirror', 'https://gitlab.com/acme/api.git');
    const site = atlas.workspace('site');
    git(site, 'init', '-q');
    git(site, 'remote', 'add', 'origin', 'https://github.com/acme/site.git');
    atlas.cli('project', 'add', api);
    atlas.cli('project', 'add', site);

    const { app, page } = await atlas.launch({ env: { ATLAS_GITHUB_API_URL: apiUrl } });
    await stubSecretStore(app, true);
    await navigate(page, 'Pull requests');
    const view = page.getByTestId('pull-requests-view');
    const remotes = view.getByTestId('hosting-remote');
    await expect(remotes).toHaveCount(3);
    await expect(remotes.filter({ hasText: 'mirror' })).toContainText('Other host');
    await expect(remotes.filter({ hasText: 'site' })).toContainText(
      'No account for this provider yet.',
    );

    // Two accounts: one connects, the other's token is rejected with an explanation.
    await view.getByRole('tab', { name: 'Accounts' }).click();
    await expect(view.getByText('No accounts connected')).toBeVisible();
    const addAccount = async (name: string, token: string, aliases = '') => {
      await view.getByTestId('hosting-add-account').click();
      const dialog = page.getByTestId('hosting-account-dialog');
      await dialog.getByLabel('Name').fill(name);
      if (aliases) await dialog.getByLabel('SSH aliases (optional)').fill(aliases);
      await dialog.getByLabel('Personal access token').fill(token);
      await dialog.getByRole('button', { name: /Save and test/ }).click();
      await expect(dialog).toBeHidden();
    };
    await addAccount('Work', 'ghp_good', 'gh-work');
    await addAccount('Personal', 'ghp_wrong');
    const accounts = view.getByTestId('hosting-account');
    await expect(accounts.filter({ hasText: 'Work' })).toContainText('Connected');
    await expect(accounts.filter({ hasText: 'Work' })).toContainText('@ana');
    await expect(accounts.filter({ hasText: 'Personal' })).toContainText('Token rejected');
    await expect(accounts.filter({ hasText: 'Personal' })).toContainText(
      'GitHub rejected the token',
    );

    // A new token for the rejected account.
    await accounts.filter({ hasText: 'Personal' }).getByRole('button', { name: 'Token…' }).click();
    const tokenDialog = page.getByTestId('hosting-account-dialog');
    await tokenDialog.getByLabel('Personal access token').fill('ghp_other');
    await tokenDialog.getByRole('button', { name: 'Save and test' }).click();
    await expect(accounts.filter({ hasText: 'Personal' })).toContainText('@bia');

    // The alias picks Work; the other repository needs an access check.
    await view.getByRole('tab', { name: 'Repositories' }).click();
    await expect(remotes.filter({ hasText: 'gh-work' })).toContainText('From its SSH alias');
    const siteRemote = remotes.filter({ hasText: 'acme/site' });
    await expect(siteRemote).toContainText('Several accounts could be used');
    await view.getByTestId('hosting-check-access').click();
    await expect(siteRemote).toContainText('Only account with access · Accessible');

    // A manual choice wins, and is shown as such.
    await siteRemote.getByTestId('hosting-remote-account').click();
    await page.getByRole('option', { name: 'Personal (GitHub)' }).click();
    await expect(siteRemote).toContainText('Chosen by you · No access');

    // Tokens are stored encrypted, outside the database.
    const dataFiles = readdirSync(atlas.dataDir);
    for (const file of dataFiles.filter((name) => name.startsWith('atlas.db'))) {
      expect(readFileSync(path.join(atlas.dataDir, file)).includes('ghp_good')).toBe(false);
    }
    const stored = readdirSync(path.join(atlas.dataDir, 'credentials'));
    expect(stored).toHaveLength(2);
    for (const file of stored) {
      expect(readFileSync(path.join(atlas.dataDir, 'credentials', file)).includes('ghp_')).toBe(
        false,
      );
    }

    // Removing an account deletes its token; its manual choices return to automatic.
    await view.getByRole('tab', { name: 'Accounts' }).click();
    await accounts
      .filter({ hasText: 'Personal' })
      .getByRole('button', { name: 'Remove Personal' })
      .click();
    await page.getByRole('button', { name: 'Remove account' }).click();
    await expect(accounts).toHaveCount(1);
    expect(readdirSync(path.join(atlas.dataDir, 'credentials'))).toHaveLength(1);
    await view.getByRole('tab', { name: 'Repositories' }).click();
    await expect(siteRemote).toContainText('Only account');
  } finally {
    server.close();
  }
});

test('does not accept tokens without a secret store', async ({ atlas }) => {
  const { app, page } = await atlas.launch();
  await stubSecretStore(app, false);
  await navigate(page, 'Pull requests');
  const view = page.getByTestId('pull-requests-view');
  await expect(view.getByText('No Git remotes found')).toBeVisible();
  await view.getByRole('tab', { name: 'Accounts' }).click();
  await view.getByRole('button', { name: 'Refresh accounts and repositories' }).click();
  await expect(view.getByTestId('hosting-store-unavailable')).toContainText(
    'tokens cannot be encrypted',
  );
  await expect(view.getByTestId('hosting-add-account')).toBeDisabled();
});
