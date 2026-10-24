import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// SDD-009 Milestone A (PLAN-030): background work is reported in the notification center,
// which survives restarts. No AI provider is involved.

const navigate = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true })
    .click();

const bell = (page: Page) => page.getByTestId('notifications-button');

async function openCenter(page: Page) {
  await bell(page).click();
  const center = page.getByTestId('notification-center');
  await expect(center).toBeVisible();
  return center;
}

function repository(dir: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Ana');
  git('config', 'user.email', 'ana@example.com');
  writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  git('add', '.');
  git('commit', '-qm', 'chore: init');
  writeFileSync(path.join(dir, 'README.md'), '# changed\n');
  git('add', 'README.md');
  return git;
}

test('runs a commit in the background and reports it in the notification center', async ({
  atlas,
}) => {
  const dir = atlas.workspace('background');
  const git = repository(dir);
  const flag = path.join(atlas.root, 'step-may-finish');
  const { project } = JSON.parse(atlas.cli('project', 'add', dir, '--json')) as {
    project: { id: string };
  };
  const first = await atlas.launch();
  let page = first.page;
  // A step that keeps running until the test lets it finish.
  await page.evaluate(
    async ({ id, file }) => {
      const api = (
        window as unknown as {
          atlas: { git: { setProjectSettings: (id: string, s: unknown) => Promise<unknown> } };
        }
      ).atlas;
      await api.git.setProjectSettings(id, {
        enforceConventionalCommits: true,
        preCommitSteps: [
          {
            name: 'Slow tests',
            command: `while [ ! -f '${file}' ]; do sleep 0.1; done`,
            mode: 'complete',
            timeoutSeconds: 60,
            readyAfterSeconds: 2,
            readyText: null,
          },
        ],
      });
    },
    { id: project.id, file: flag },
  );
  await expect(bell(page)).toHaveAccessibleName('Notifications');

  await navigate(page, 'Git');
  await page.getByRole('button', { name: 'Commit…' }).click();
  const dialog = page.getByTestId('commit-dialog');
  await dialog.getByLabel('Commit message').fill('docs: background commit');
  await dialog.getByRole('button', { name: 'Commit', exact: true }).click();

  // The dialog does not wait for the steps: the operations panel shows them running.
  await expect(dialog).toBeHidden();
  const sheet = page.getByTestId('git-operations-sheet');
  const operation = sheet.locator('[data-testid="git-operation"][data-kind="commit"]').first();
  await expect(operation).toHaveAttribute('data-status', 'running');
  await expect(operation.getByTestId('git-steps')).toContainText('Slow tests');
  await page.keyboard.press('Escape');

  // Other work goes on meanwhile.
  await navigate(page, 'Projects');
  writeFileSync(flag, '');
  const toast = page.getByTestId('toast').filter({ hasText: 'Commit created' });
  await expect(toast).toBeVisible({ timeout: 20_000 });
  await expect(toast).toContainText('Git · background');
  expect(git('log', '-1', '--format=%s').trim()).toBe('docs: background commit');
  await expect(bell(page)).toHaveAccessibleName('Notifications (1 unread)');

  // The notification leads back to the operation and is then read.
  const center = await openCenter(page);
  const item = center.getByTestId('notification').filter({ hasText: 'Commit created' });
  await expect(item).toHaveAttribute('data-read', 'false');
  await item.getByRole('button', { name: /^Commit created/ }).click();
  await expect(page.getByTestId('git-view')).toBeVisible();
  await expect(sheet).toBeVisible();
  await expect(operation).toHaveAttribute('data-status', 'succeeded');
  await page.keyboard.press('Escape');
  await expect(bell(page)).toHaveAccessibleName('Notifications');

  // History survives a restart.
  await first.app.close();
  ({ page } = await atlas.launch());
  const restored = await openCenter(page);
  await expect(restored.getByTestId('notification')).toHaveCount(1);
  await expect(restored.getByTestId('notification')).toHaveAttribute('data-read', 'true');
  await restored.getByRole('button', { name: 'Delete "Commit created"' }).click();
  await expect(restored.getByText('No notifications yet.')).toBeVisible();
});

test('reports Preflight runs, opens their result and fits narrow windows', async ({ atlas }) => {
  const dir = atlas.workspace('checks');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  writeFileSync(path.join(atlas.binDir, 'npm'), '#!/bin/sh\necho FAILING >&2; exit 3\n');
  chmodSync(path.join(atlas.binDir, 'npm'), 0o755);
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();

  await navigate(page, 'Preflight');
  const view = page.getByTestId('preflight-view');
  await view.getByRole('combobox', { name: 'Workspace' }).click();
  await page.getByRole('option', { name: 'checks' }).click();
  await view.getByRole('tab', { name: /Checks/ }).click();
  await view.getByTestId('preflight-suggestions').getByRole('button', { name: 'Add test' }).click();
  await page.getByTestId('preflight-check-form').getByRole('button', { name: 'Add check' }).click();
  await view.getByRole('tab', { name: 'Run' }).click();
  await view.getByRole('checkbox', { name: 'test' }).click();
  await view.getByRole('button', { name: 'Run selected' }).click();
  await page
    .getByTestId('preflight-authorize')
    .getByRole('button', { name: 'Authorize and run' })
    .click();
  // Leaving the view does not stop the run; its end is notified.
  await navigate(page, 'Projects');
  await expect(page.getByTestId('toast').filter({ hasText: 'Preflight failed' })).toBeVisible({
    timeout: 30_000,
  });

  for (const width of [380, 1440]) {
    await app.evaluate(({ BrowserWindow }, w) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(w, 800);
    }, width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    const center = await openCenter(page);
    const box = await center.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    await page.keyboard.press('Escape');
  }

  const center = await openCenter(page);
  await center.getByRole('tab', { name: 'Unread' }).click();
  const item = center.getByTestId('notification').filter({ hasText: 'Preflight failed' });
  await expect(item).toContainText('0 of 1 check passed, 1 failed.');
  await expect(item).toContainText('Preflight · checks');
  await item.getByRole('button', { name: /^Preflight failed/ }).click();
  await expect(view.getByTestId('preflight-run').getByTestId('preflight-run-status')).toHaveText(
    'Failed',
  );

  // Clearing removes everything.
  const again = await openCenter(page);
  await expect(again.getByText('No unread notifications.')).toBeVisible();
  await again.getByRole('tab', { name: 'All' }).click();
  await again.getByRole('button', { name: 'Clear all' }).click();
  await expect(again.getByText('No notifications yet.')).toBeVisible();
});
