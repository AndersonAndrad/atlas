import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// PLAN-023: quick commands run from each project's Actions menu in Terminals.

const navigate = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name }).click();

test('runs quick commands from a project Actions menu, hidden or enabled per project', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('web'));
  atlas.cli('project', 'add', atlas.workspace('api'));
  const { page } = await atlas.launch();

  await navigate(page, 'Quick commands');
  const view = page.getByTestId('quick-commands-view');
  await expect(view.getByText('No quick commands yet')).toBeVisible();

  // Validated before saving: a name is required.
  await view.getByRole('button', { name: 'Add command' }).click();
  let dialog = page.getByTestId('quick-command-dialog');
  await dialog.getByLabel('Command').fill('echo QUICK_$((40+2))');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Name is required.')).toBeVisible();
  await dialog.getByLabel('Name').fill('Say hi');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  await view.getByRole('button', { name: 'Add command' }).click();
  dialog = page.getByTestId('quick-command-dialog');
  await dialog.getByLabel('Name').fill('Not in menus');
  await dialog.getByLabel('Command').fill('echo nope');
  await dialog.getByRole('checkbox', { name: 'Prioritized' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(view.getByTestId('quick-command')).toHaveCount(2);
  await expect(view.getByTestId('quick-command').nth(1)).toHaveAttribute(
    'data-prioritized',
    'false',
  );

  // The Actions menu opens a terminal, or one that runs the command.
  await navigate(page, 'Terminals');
  await page.getByRole('button', { name: 'Project actions for web' }).click();
  const menu = page.getByTestId('project-actions-menu');
  await expect(menu.getByRole('menuitem', { name: 'Open terminal' })).toBeVisible();
  await expect(menu.getByTestId('project-action-command')).toHaveCount(1);
  await menu.getByRole('menuitem', { name: /Say hi/ }).click();
  await expect(page.getByTestId('terminal-tab').filter({ hasText: 'Say hi' })).toBeVisible();
  const pane = page.getByTestId('terminal-pane').first();
  // The shell computed the result: the command ran, it was not only shown.
  await expect
    .poll(() => pane.locator('.xterm-rows').innerText(), { timeout: 15_000 })
    .toContain('QUICK_42');

  // Hidden in the api project only.
  await navigate(page, 'Projects');
  await page.getByTestId('project-card').filter({ hasText: 'api' }).click();
  await page.getByRole('tab', { name: 'Quick commands' }).click();
  const show = page
    .getByTestId('project-quick-commands')
    .getByRole('checkbox', { name: 'Show Say hi in this project' });
  await expect(show).toBeChecked();
  await show.click();
  await expect(show).not.toBeChecked();

  // A command that is not prioritized is offered only where it is enabled: here, web.
  await page.getByTestId('project-card').filter({ hasText: 'web' }).click();
  await page.getByRole('tab', { name: 'Quick commands' }).click();
  const enable = page
    .getByTestId('project-quick-commands')
    .getByRole('checkbox', { name: 'Show Not in menus in this project' });
  await expect(enable).not.toBeChecked();
  await enable.click();
  await expect(enable).toBeChecked();

  await navigate(page, 'Terminals');
  await page.getByRole('button', { name: 'Project actions for api' }).click();
  await expect(menu.getByRole('menuitem', { name: 'Open terminal' })).toBeVisible();
  await expect(menu.getByTestId('project-action-command')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Project actions for web' }).click();
  await expect(menu.getByTestId('project-action-command')).toHaveCount(2);
  await expect(menu.getByRole('menuitem', { name: /Not in menus/ })).toBeVisible();
});

test('project details are organized in tabs that work with the keyboard', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('tabs'));
  const { page } = await atlas.launch();
  await page.getByTestId('project-card').click();
  const overview = page.getByRole('tab', { name: 'Overview' });
  await expect(overview).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('details-path')).toBeVisible();
  await overview.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'AI & context' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('project-ai-settings')).toBeVisible();
  await expect(page.getByTestId('details-path')).toBeHidden();
});

test('a terminal opened from the project actions menu receives the keyboard', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('focus'));
  const { page } = await atlas.launch();
  await navigate(page, 'Terminals');
  // The menu button shows options (three dots), not "+".
  await expect(
    page
      .getByRole('button', { name: 'Project actions for focus' })
      .locator('[data-icon="ellipsis"]'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Project actions for focus' }).click();
  await page.getByRole('menuitem', { name: 'Open terminal' }).click();
  const pane = page.getByTestId('terminal-pane').first();
  await expect
    .poll(() => pane.locator('.xterm-rows').innerText(), { timeout: 15_000 })
    .toMatch(/\$\s*$/m);
  // No click on the terminal: the menu must not have taken the focus back.
  await page.keyboard.type('echo FOCUS_$((1+1))');
  await page.keyboard.press('Enter');
  await expect.poll(() => pane.locator('.xterm-rows').innerText()).toContain('FOCUS_2');
});
