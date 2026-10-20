import { existsSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';

test('shows the empty state and adds a project through the native picker', async ({ atlas }) => {
  const dir = atlas.workspace('alpha', { git: 'main' });
  const { app, page } = await atlas.launch();

  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByRole('button', { name: 'Add project' }).click();

  const dialog = page.getByTestId('project-form-dialog');
  await expect(dialog).toBeVisible();

  // Cancelling the picker keeps the dialog without a selection.
  await atlas.stubDirectoryPicker(app, undefined);
  await dialog.getByRole('button', { name: 'Choose…' }).click();
  await expect(dialog.getByTestId('selected-directory')).toHaveText('No directory selected');

  await atlas.stubDirectoryPicker(app, dir);
  await dialog.getByRole('button', { name: 'Choose…' }).click();
  await expect(dialog.getByTestId('selected-directory')).toHaveText(dir);
  await expect(dialog.getByTestId('directory-inspection')).toHaveText('Git: main');
  await expect(dialog.getByLabel('Name')).toHaveValue('alpha');

  await dialog.getByLabel('Description').fill('First project');
  await dialog.getByLabel(/Tags/).fill('core, desktop');
  await dialog.getByRole('button', { name: 'Add project' }).click();

  await expect(dialog).toBeHidden();
  const card = page.getByTestId('project-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('alpha');
  await expect(card.getByTestId('git-status')).toHaveText('main');
  await expect(card.getByTestId('availability')).toHaveText('Available');

  const details = page.getByTestId('project-details');
  await expect(details.getByTestId('details-path')).toHaveText(dir);
  await expect(details).toContainText('First project');
  await expect(details.getByRole('list', { name: 'Tags' })).toContainText('core');
});

test('keeps the project dialog within its bounds for long values', async ({ atlas }) => {
  const dir = atlas.workspace(`${'nested-client-folder/'.repeat(8)}backend-internet_banking`);
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();

  await page.getByTestId('project-card').click();
  await page.getByTestId('project-details').getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByTestId('project-form-dialog');
  await dialog.getByLabel('Description').fill(`Long description ${'x'.repeat(200)}`);
  await dialog.getByLabel(/Tags/).fill(Array.from({ length: 12 }, (_, i) => `tag-${i}`).join(', '));

  const bounds = (await dialog.boundingBox())!;
  const inside = async (name: string) => {
    const box = (await dialog.getByRole('button', { name }).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  };
  await inside('Change…');
  await inside('Save changes');
  const directory = dialog.getByTestId('selected-directory');
  await expect(directory).toHaveAttribute('title', dir);
  expect(await directory.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test('keeps confirmation dialogs within their bounds for long unbroken names', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace(`backend_${'internet_banking_'.repeat(5)}service`));
  const { page } = await atlas.launch();

  await page.getByTestId('project-card').click();
  await page.getByTestId('project-details').getByRole('button', { name: 'Remove' }).click();
  const dialog = page.getByTestId('remove-dialog');
  const bounds = (await dialog.boundingBox())!;
  const button = (await dialog
    .getByRole('button', { name: 'Remove from registry' })
    .boundingBox())!;
  expect(button.x + button.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  // The name wraps instead of overflowing the dialog.
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('rejects registering the same directory twice', async ({ atlas }) => {
  const dir = atlas.workspace('dup');
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();

  await page.getByRole('button', { name: 'Add project' }).click();
  const dialog = page.getByTestId('project-form-dialog');
  await atlas.stubDirectoryPicker(app, `${dir}/`);
  await dialog.getByRole('button', { name: 'Choose…' }).click();
  await dialog.getByRole('button', { name: 'Add project' }).click();

  await expect(dialog.getByTestId('form-error')).toHaveText(
    'This directory is already registered as a project.',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('project-card')).toHaveCount(1);
});

test('lists multiple projects and edits metadata', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('one'));
  atlas.cli('project', 'add', atlas.workspace('two', { git: 'dev' }));
  const { page } = await atlas.launch();

  await expect(page.getByTestId('project-card')).toHaveCount(2);
  await page.getByTestId('project-card').filter({ hasText: 'two' }).click();
  await page.getByTestId('project-details').getByRole('button', { name: 'Edit' }).click();

  const dialog = page.getByTestId('project-form-dialog');
  await dialog.getByLabel('Name').fill('');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByText('Name is required.')).toBeVisible();

  await dialog.getByLabel('Name').fill('Two Renamed');
  await dialog.getByLabel('Description').fill('Edited description');
  await dialog.getByLabel(/Tags/).fill('api');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();

  const details = page.getByTestId('project-details');
  await expect(details.getByRole('heading', { name: 'Two Renamed' })).toBeVisible();
  await expect(details).toContainText('Edited description');
  await expect(page.getByTestId('project-card').filter({ hasText: 'one' })).toHaveCount(1);
  expect(atlas.cli('project', 'list')).toContain('Two Renamed');
});

test('removes a registry entry after confirmation without deleting files', async ({ atlas }) => {
  const dir = atlas.workspace('keep-me', { git: 'main' });
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();

  await page.getByTestId('project-card').click();
  await page.getByTestId('project-details').getByRole('button', { name: 'Remove' }).click();
  const dialog = page.getByTestId('remove-dialog');
  await expect(dialog).toContainText('not modified or deleted');

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('project-card')).toHaveCount(1);

  await page.getByTestId('project-details').getByRole('button', { name: 'Remove' }).click();
  await dialog.getByRole('button', { name: 'Remove from registry' }).click();
  await expect(page.getByTestId('empty-state')).toBeVisible();

  expect(existsSync(dir)).toBe(true);
  expect(readdirSync(dir).sort()).toEqual(['.git', 'README.md']);
});

test('restores the last selected project after restart', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('first'));
  atlas.cli('project', 'add', atlas.workspace('second'));

  const first = await atlas.launch();
  let page = first.page;
  await page.getByTestId('project-card').filter({ hasText: 'second' }).click();
  await expect(page.getByTestId('project-details').getByRole('heading', { level: 2 })).toHaveText(
    'second',
  );
  await expect(page.getByTestId('project-card').filter({ hasText: 'second' })).not.toContainText(
    'Opened: Never',
  );
  await first.app.close();

  page = (await atlas.launch()).page;
  await expect(page.getByTestId('project-card')).toHaveCount(2);
  await expect(page.getByTestId('project-details').getByRole('heading', { level: 2 })).toHaveText(
    'second',
  );
  await expect(page.getByTestId('project-card').filter({ hasText: 'second' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('displays unavailable directories and allows relocating them', async ({ atlas }) => {
  const dir = atlas.workspace('wanderer');
  atlas.cli('project', 'add', dir);
  const moved = path.join(path.dirname(dir), 'wanderer-moved');
  renameSync(dir, moved);

  const { app, page } = await atlas.launch();
  const card = page.getByTestId('project-card');
  await expect(card.getByTestId('availability')).toHaveText('Unavailable');
  await card.click();
  await expect(page.getByTestId('unavailable-callout')).toContainText('directory not found');

  await page.getByRole('button', { name: 'Update directory' }).click();
  const dialog = page.getByTestId('project-form-dialog');
  await atlas.stubDirectoryPicker(app, moved);
  await dialog.getByRole('button', { name: 'Change…' }).click();
  await dialog.getByRole('button', { name: 'Save changes' }).click();

  await expect(card.getByTestId('availability')).toHaveText('Available');
  await expect(page.getByTestId('details-path')).toHaveText(moved);
  await expect(page.getByTestId('unavailable-callout')).toHaveCount(0);
});

test('future sections are visibly unavailable', async ({ atlas }) => {
  const { page } = await atlas.launch();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  for (const available of ['Projects', 'Terminals', 'Sessions', 'Settings']) {
    await expect(nav.getByRole('button', { name: available })).toBeEnabled();
  }
  for (const section of ['Agents', 'Skills', 'Accounts', 'Usage']) {
    await expect(
      nav.getByRole('button', { name: `${section} (not available yet)` }),
    ).toBeDisabled();
  }
});
