import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true })
    .click();

test('sets the global Git identity and overrides it for one repository', async ({ atlas }) => {
  const home = path.join(atlas.root, 'home');
  const repo = atlas.workspace('billing');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    }).trim();
  git('init', '-q', '-b', 'main');
  atlas.cli('project', 'add', repo);
  const { page } = await atlas.launch();

  // Global identity in Settings → Git.
  await nav(page, 'Settings');
  const global = page.getByTestId('git-global-identity');
  await global.getByLabel('Name').fill('Ana Dev');
  await global.getByLabel('Email').fill('ana');
  await expect(global.getByTestId('git-identity-email-warning')).toBeVisible();
  await global.getByLabel('Email').fill('ana@example.com');
  await expect(global.getByTestId('git-identity-email-warning')).toHaveCount(0);
  await global.getByRole('button', { name: 'Save global identity' }).click();
  await expect(global.getByRole('status')).toHaveText('Saved.');
  await expect(global.getByTestId('git-global-name-source')).toContainText('.gitconfig');
  expect(git('config', '--global', 'user.name')).toBe('Ana Dev');

  // The project inherits it until it overrides it.
  await nav(page, 'Projects');
  await page.getByTestId('project-card').filter({ hasText: 'billing' }).click();
  await page.getByRole('tab', { name: 'Commit checks' }).click();
  const identity = page.getByTestId('git-project-identity');
  await expect(identity.getByTestId('git-identity-name-effective')).toHaveText('Ana Dev');
  await expect(identity.getByTestId('git-identity-name-mode')).toHaveText('Inherited');
  await expect(identity.getByTestId('git-identity-name-source')).toContainText('global');

  await identity.getByLabel('Name').fill('Ana (Billing)');
  await identity.getByRole('button', { name: 'Save repository identity' }).click();
  await expect(identity.getByTestId('git-identity-name-mode')).toHaveText('Overridden');
  await expect(identity.getByTestId('git-identity-name-effective')).toHaveText('Ana (Billing)');
  await expect(identity.getByTestId('git-identity-name-source')).toContainText('this repository');
  expect(git('config', '--local', 'user.name')).toBe('Ana (Billing)');
  // The email still comes from the global configuration.
  await expect(identity.getByTestId('git-identity-email-mode')).toHaveText('Inherited');

  await identity.getByRole('button', { name: 'Use inherited name' }).click();
  await expect(identity.getByTestId('git-identity-name-mode')).toHaveText('Inherited');
  await expect(identity.getByTestId('git-identity-name-effective')).toHaveText('Ana Dev');
  expect(() => git('config', '--local', 'user.name')).toThrow();
});
