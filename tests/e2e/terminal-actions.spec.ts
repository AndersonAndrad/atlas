import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, openProjectTerminal, test } from './fixtures';

/** A repository with a second branch and an uncommitted change. */
function repository(dir: string, home: string) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Ana Dev');
  git('config', 'user.email', 'ana@example.com');
  git('add', '.');
  git('commit', '-qm', 'chore: init');
  git('branch', 'feature');
  writeFileSync(path.join(dir, 'README.md'), '# changed\n');
  return git;
}

async function terminals(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals', exact: true })
    .click();
}

async function openActions(pane: Locator, page: Page) {
  await pane.getByRole('button', { name: 'Actions' }).click();
  const menu = page.getByTestId('terminal-actions-menu');
  await expect(menu).toBeVisible();
  return menu;
}

test('Git actions of a project terminal use the existing dialogs', async ({ atlas }) => {
  const dir = atlas.workspace('api');
  const git = repository(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await terminals(page);
  await openProjectTerminal(page, 'api');
  const pane = page.getByTestId('terminal-pane').first();

  // Wait until the terminal's repository is known.
  let menu = await openActions(pane, page);
  await expect(menu.getByTestId('terminal-action-branch')).toBeEnabled({ timeout: 15_000 });
  await page.keyboard.press('Escape');

  // Keyboard: the menu opens with Enter on the first action; arrows move between them.
  await pane.getByRole('button', { name: 'Actions' }).focus();
  await page.keyboard.press('Enter');
  menu = page.getByTestId('terminal-actions-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByText('Git', { exact: true })).toBeVisible();
  await expect(menu.getByText('Project', { exact: true })).toBeVisible();
  await expect(menu.getByText('Terminal', { exact: true })).toBeVisible();
  const branch = menu.getByTestId('terminal-action-branch');
  await expect(branch).toBeFocused();
  await expect(menu.getByTestId('terminal-action-restart')).toBeDisabled();
  await expect(menu.getByTestId('terminal-action-restart')).toContainText(
    'Restart is available after the process ends.',
  );
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByTestId('terminal-action-status')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(branch).toBeFocused();
  // Opening the menu ran nothing: still on main.
  expect(git('branch', '--show-current').trim()).toBe('main');

  // Switch branch warns about the uncommitted change and never discards it.
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('branches-dialog');
  await expect(dialog).toBeVisible();
  await dialog
    .getByTestId('local-branch')
    .filter({ hasText: 'feature' })
    .getByRole('button', { name: 'Switch' })
    .click();
  await expect(dialog.getByTestId('switch-warning')).toContainText('uncommitted changes');
  await dialog.getByRole('button', { name: 'Switch anyway' }).click();
  await expect
    .poll(() => git('branch', '--show-current').trim(), { timeout: 15_000 })
    .toBe('feature');
  expect(git('status', '--porcelain')).toContain('README.md');
  await page.keyboard.press('Escape');

  // Push goes through its usual dialog; nothing is pushed by opening it.
  await (await openActions(pane, page)).getByTestId('terminal-action-push').click();
  await expect(page.getByTestId('push-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('push-dialog')).toBeHidden();

  // Commit opens the Git view on this repository with its commit dialog.
  await (await openActions(pane, page)).getByTestId('terminal-action-commit').click();
  await expect(page.getByTestId('git-repository-name')).toHaveText('api');
  await expect(page.getByTestId('commit-dialog')).toBeVisible({ timeout: 15_000 });
});

test('explains what is unavailable without Git, without a project, and once ended', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('notes'));
  const { page } = await atlas.launch();
  await terminals(page);

  // A project without Git: Git actions explain why; project actions work.
  await openProjectTerminal(page, 'notes');
  const pane = page.getByTestId('terminal-pane').first();
  let menu = await openActions(pane, page);
  await expect(menu.getByTestId('terminal-action-push')).toBeDisabled();
  await expect(menu.getByTestId('terminal-action-push')).toContainText('Not a Git repository.');
  await expect(menu.getByTestId('terminal-action-editor')).toBeEnabled();
  await page.keyboard.press('Escape');

  // A terminal without a project.
  await page.getByRole('button', { name: 'New terminal' }).click();
  await expect(page.getByTestId('terminal-pane')).toHaveCount(1);
  const standalone = page.getByTestId('terminal-pane').first();
  await expect(standalone.getByTestId('pane-project')).toHaveCount(0);
  menu = await openActions(standalone, page);
  await expect(menu.getByTestId('terminal-action-tasks')).toContainText(
    'This terminal is not in a registered project.',
  );
  await expect(menu.getByTestId('terminal-action-project-details')).toBeEnabled();
  await page.keyboard.press('Escape');

  // Busy: closing asks first.
  await standalone.getByTestId('terminal-host').click();
  await page.keyboard.type('sleep 120');
  await page.keyboard.press('Enter');
  await expect
    .poll(
      async () => {
        menu = await openActions(standalone, page);
        await menu.getByTestId('terminal-action-close').click();
        return page.getByTestId('close-terminal-dialog').isVisible();
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await page
    .getByTestId('close-terminal-dialog')
    .getByRole('button', { name: 'Keep running' })
    .click();
  await expect(page.getByTestId('terminal-pane')).toHaveCount(1);

  // Ended: Git actions say so and Restart becomes available.
  await standalone.getByTestId('terminal-host').click();
  await page.keyboard.press('Control+C');
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(standalone.getByTestId('terminal-ended')).toBeVisible({ timeout: 15_000 });
  menu = await openActions(standalone, page);
  await expect(menu.getByTestId('terminal-action-fetch')).toContainText('The terminal ended.');
  await menu.getByTestId('terminal-action-restart').click();
  await expect(page.getByTestId('terminal-pane').first().getByTestId('terminal-ended')).toHaveCount(
    0,
    { timeout: 15_000 },
  );
});

test('split and duplicate continue the terminal; rename edits its tab', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('web'));
  const { page } = await atlas.launch();
  await terminals(page);
  await openProjectTerminal(page, 'web');
  const pane = page.getByTestId('terminal-pane').first();

  await (await openActions(pane, page)).getByTestId('terminal-action-split-right').click();
  await expect(page.getByTestId('terminal-pane')).toHaveCount(2);
  await expect(page.getByTestId('pane-project')).toHaveCount(2);

  await (await openActions(pane, page)).getByTestId('terminal-action-duplicate').click();
  await expect(page.getByRole('tab')).toHaveCount(3);

  await (
    await openActions(page.getByTestId('terminal-pane').first(), page)
  )
    .getByTestId('terminal-action-rename')
    .click();
  const name = page.getByLabel('Terminal name');
  await expect(name).toBeFocused();
  await name.fill('api server');
  await name.press('Enter');
  await expect(page.getByRole('tab', { name: /api server/ })).toBeVisible();
});
