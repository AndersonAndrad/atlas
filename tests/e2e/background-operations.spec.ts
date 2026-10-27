import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** A clone of a bare remote with one local commit to push; `hook` becomes its pre-push hook. */
function cloneToPush(root: string, name: string, hook: string) {
  const home = path.join(root, 'home');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  const origin = path.join(root, `${name}-origin.git`);
  const clone = path.join(root, 'workspaces', name);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, clone);
  git(clone, 'config', 'user.name', 'Ana Dev');
  git(clone, 'config', 'user.email', 'ana@example.com');
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'chore: initial');
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
  git(clone, 'branch', '-q', '-u', 'origin/main');
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'feat: to push');
  writeFileSync(path.join(clone, '.git', 'hooks', 'pre-push'), hook, { mode: 0o755 });
  return { clone, origin, git };
}

const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true })
    .click();

async function openPushDialog(page: Page) {
  await nav(page, 'Git');
  await expect(page.getByTestId('git-view')).toBeVisible();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByTestId('git-actions-button').click();
  await page.getByRole('menuitem', { name: /^Push…/ }).click();
  return page.getByTestId('push-dialog');
}

test('a confirmed push keeps running after its dialog closes and is tracked in Operations', async ({
  atlas,
}) => {
  // The hook keeps the push running long enough to move around ATLAS meanwhile.
  const { clone, origin, git } = cloneToPush(atlas.root, 'web', '#!/bin/sh\nsleep 4\nexit 0\n');
  atlas.cli('project', 'add', clone);
  const { page } = await atlas.launch();

  const dialog = await openPushDialog(page);
  await expect(dialog.getByTestId('git-route')).toContainText('origin/main');
  await dialog.getByRole('button', { name: 'Push', exact: true }).click();
  // Released as soon as the Engine accepted the job.
  await expect(dialog).toHaveCount(0, { timeout: 5_000 });
  const notice = page.getByTestId('background-submitted');
  await expect(notice).toContainText('Push main → origin/main started in the background');

  // Navigating elsewhere, and even reloading the window, does not stop it.
  await nav(page, 'Terminals');
  await nav(page, 'Projects');
  await page.reload();
  await nav(page, 'Operations');
  const row = page.getByTestId('job-row').filter({ hasText: 'Push main → origin/main' });
  await expect(row).toBeVisible();
  await row.locator('button[aria-pressed]').click();
  const details = page.getByTestId('job-details');
  await expect(details.getByTestId('job-status')).toHaveText('Completed', { timeout: 20_000 });
  await expect(details.getByTestId('job-git')).toContainText('git push');
  await expect(details.getByTestId('job-log')).toContainText('push --progress');
  await expect(details.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  expect(git(origin, 'log', '-1', '--format=%s', 'main').trim()).toBe('feat: to push');

  // One notification for the push (the Git operation's).
  await page.getByTestId('notifications-button').click();
  await expect(page.getByTestId('notification-center')).toContainText(/push/i);
});

test('a rejected submission keeps the dialog; a failed push is reported in Operations', async ({
  atlas,
}) => {
  const { clone } = cloneToPush(
    atlas.root,
    'api',
    '#!/bin/sh\necho blocked by policy >&2\nexit 1\n',
  );
  atlas.cli('project', 'add', clone);
  const { page } = await atlas.launch();

  const dialog = await openPushDialog(page);
  await dialog.getByRole('button', { name: 'Push', exact: true }).click();
  await expect(page.getByTestId('background-submitted')).toBeVisible();
  // A failed push opens the Git operations panel by itself, as before.
  const sheet = page.getByTestId('git-operations-sheet');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  // "View in Operations" opens the job.
  await page.getByRole('button', { name: 'View in Operations' }).click();
  const details = page.getByTestId('job-details');
  await expect(details.getByTestId('job-status')).toHaveText('Failed', { timeout: 20_000 });
  await expect(details.getByTestId('job-log')).toContainText('blocked by policy');

  // Detached HEAD: the Engine refuses the push before accepting anything.
  execFileSync('git', ['switch', '-q', '--detach', 'HEAD'], { cwd: clone });
  const again = await openPushDialog(page);
  await expect(again).toContainText('Switch to a branch before pushing');
  await expect(again.getByRole('button', { name: 'Push', exact: true })).toBeDisabled();
});
