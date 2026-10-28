import { rmSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// SDD-023 Task A05: project navigation and creation actions in the upper toolbar.

const navigate = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name }).click();

const projectName = (page: Page) => page.getByTestId('toolbar-project-name');
const sidebarTerminals = (page: Page) =>
  page.getByRole('navigation', { name: 'Terminal groups' }).getByTestId('sidebar-terminal');

async function openSwitcher(page: Page) {
  await page.getByTestId('toolbar-project').click();
  const menu = page.getByTestId('toolbar-project-menu');
  await expect(menu).toBeVisible();
  return menu;
}

async function newMenuItem(page: Page, key: string) {
  await page.getByTestId('toolbar-new').click();
  return page.getByTestId(`toolbar-new-${key}`);
}

test('switches projects with search and keyboard, keeping running terminals as they are', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('alpha'));
  atlas.cli('project', 'add', atlas.workspace('beta'));
  atlas.cli('project', 'add', atlas.workspace('gamma'));
  const { page } = await atlas.launch();
  await expect(projectName(page)).toHaveText('No project');

  // Without a project, the project terminal is disabled with its reason.
  const projectTerminal = await newMenuItem(page, 'project-terminal');
  await expect(projectTerminal).toHaveAttribute('data-disabled', '');
  await expect(projectTerminal).toContainText('Select a project first.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('toolbar-new-menu')).toBeHidden();

  // Keyboard only: the search has the focus, arrows move, Enter selects.
  let menu = await openSwitcher(page);
  const search = menu.getByTestId('toolbar-project-search');
  await expect(search).toBeFocused();
  await expect(menu.getByTestId('toolbar-project-option')).toHaveCount(3);
  await search.fill('ALP');
  await expect(menu.getByTestId('toolbar-project-option')).toHaveText(['alpha']);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(projectName(page)).toHaveText('alpha');
  // Selecting opened nothing.
  await navigate(page, 'Terminals');
  await expect(sidebarTerminals(page)).toHaveCount(0);
  await expect(page.getByTestId('toolbar-group-name')).toHaveText('/ Ungrouped');

  // A terminal for the selected project, from the New menu; it gets the keyboard.
  await (await newMenuItem(page, 'project-terminal')).click();
  await expect(sidebarTerminals(page)).toHaveCount(1);
  await expect(page.locator('.xterm-helper-textarea').first()).toBeFocused();
  const pane = page.getByTestId('terminal-pane').first();
  await page.keyboard.type('pwd\n');
  await expect.poll(() => pane.locator('.xterm-rows').innerText()).toContain('alpha');
  const alphaSession = await page
    .getByTestId('terminal-tab')
    .first()
    .getAttribute('data-session-id');

  // Switching with arrows and Escape; the alpha terminal keeps running in its folder.
  menu = await openSwitcher(page);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  menu = await openSwitcher(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(projectName(page)).toHaveText('beta');
  await expect(sidebarTerminals(page)).toHaveCount(1);
  await expect(sidebarTerminals(page).first()).toContainText('alpha');

  // A new terminal inherits the selected project; the first one is unchanged.
  await (await newMenuItem(page, 'project-terminal')).click();
  await expect(sidebarTerminals(page)).toHaveCount(2);
  const newPane = page.getByTestId('terminal-pane').last();
  await page.keyboard.type('pwd\n');
  await expect.poll(() => newPane.locator('.xterm-rows').innerText()).toContain('beta');
  await expect(sidebarTerminals(page).filter({ hasText: 'alpha' })).toHaveCount(1);

  // Back on alpha, "Show terminals" brings its terminal forward; nothing new opens.
  menu = await openSwitcher(page);
  await menu.getByTestId('toolbar-project-search').fill('alpha');
  await page.keyboard.press('Enter');
  menu = await openSwitcher(page);
  await expect(menu.getByTestId('toolbar-project-show-terminals')).toHaveText('Show terminals (1)');
  await menu.getByTestId('toolbar-project-show-terminals').click();
  await expect(menu).toBeHidden();
  await expect(sidebarTerminals(page)).toHaveCount(2);
  await expect(
    page
      .locator(`[data-testid="terminal-tab"][data-session-id="${alphaSession}"]`)
      .getByRole('tab'),
  ).toHaveAttribute('aria-selected', 'true');

  // Project details opens the Projects view on it.
  menu = await openSwitcher(page);
  await menu.getByTestId('toolbar-project-details').click();
  await expect(page.getByTestId('project-details')).toContainText('alpha');
});

test('creates a project and a terminal group from the New menu', async ({ atlas }) => {
  const dir = atlas.workspace('delta');
  const { app, page } = await atlas.launch();

  // No registered projects: the switcher offers to create one.
  let menu = await openSwitcher(page);
  await expect(menu).toContainText('No projects registered yet.');
  await page.keyboard.press('Escape');

  await (await newMenuItem(page, 'project')).click();
  const dialog = page.getByTestId('project-form-dialog');
  await expect(dialog).toBeVisible();
  await atlas.stubDirectoryPicker(app, dir);
  await dialog.getByRole('button', { name: 'Choose…' }).click();
  await dialog.getByRole('button', { name: 'Add project' }).click();
  await expect(dialog).toBeHidden();
  await expect(projectName(page)).toHaveText('delta');
  menu = await openSwitcher(page);
  await expect(menu.getByTestId('toolbar-project-option')).toHaveText(['delta']);
  await page.keyboard.press('Escape');

  // From another view, the group dialog opens in Terminals and the toolbar names it.
  await (await newMenuItem(page, 'group')).click();
  const nameDialog = page.getByRole('dialog', { name: 'New terminal group' });
  await expect(nameDialog).toBeVisible();
  await nameDialog.getByLabel('Name').fill('Backend');
  await nameDialog.getByRole('button', { name: 'Create group' }).click();
  await expect(nameDialog).toBeHidden();
  await expect(page.getByTestId('toolbar-group-name')).toHaveText('/ Backend');

  // New terminal opens in the group, in the default folder (not the project).
  await (await newMenuItem(page, 'terminal')).click();
  await expect(sidebarTerminals(page)).toHaveCount(1);
  await expect(sidebarTerminals(page).first()).not.toContainText('delta');
  // The group stays shown after visiting another view.
  await navigate(page, 'Projects');
  await expect(page.getByTestId('toolbar-group-name')).toHaveCount(0);
  await navigate(page, 'Terminals');
  await expect(page.getByTestId('toolbar-group-name')).toHaveText('/ Backend');
});

test('runs the selected project quick commands from the toolbar', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('web'));
  const { page } = await atlas.launch();

  // Without a project only commands of all projects are offered; none exist yet.
  await page.getByTestId('toolbar-quick-commands').click();
  const menu = page.getByTestId('toolbar-quick-commands-menu');
  await expect(menu).toContainText('No quick commands for all projects.');
  await menu.getByTestId('toolbar-quick-commands-manage').click();
  const view = page.getByTestId('quick-commands-view');
  await expect(view).toBeVisible();

  await view.getByRole('button', { name: 'Add command' }).click();
  const dialog = page.getByTestId('quick-command-dialog');
  await dialog.getByLabel('Name').fill('Say hi');
  await dialog.getByLabel('Command').fill('echo TOOLBAR_$((40+2))');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const switcher = await openSwitcher(page);
  await switcher.getByTestId('toolbar-project-option').click();
  await expect(projectName(page)).toHaveText('web');

  // Opening the menu runs nothing; choosing the command opens a terminal running it.
  await page.getByTestId('toolbar-quick-commands').click();
  await expect(menu.getByTestId('toolbar-quick-command')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await navigate(page, 'Terminals');
  await expect(sidebarTerminals(page)).toHaveCount(0);
  await page.getByTestId('toolbar-quick-commands').click();
  await menu.getByTestId('toolbar-quick-command').click();
  await expect(page.getByTestId('terminal-tab').filter({ hasText: 'Say hi' })).toBeVisible();
  const pane = page.getByTestId('terminal-pane').first();
  await expect
    .poll(() => pane.locator('.xterm-rows').innerText(), { timeout: 15_000 })
    .toContain('TOOLBAR_42');
});

test('restores the selected project after a restart and handles a missing folder', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('alpha'));
  const goneDir = atlas.workspace('gone');
  atlas.cli('project', 'add', goneDir);
  const first = await atlas.launch();
  let page = first.page;
  const menu = await openSwitcher(page);
  await menu.getByTestId('toolbar-project-search').fill('gone');
  await page.keyboard.press('Enter');
  await expect(projectName(page)).toHaveText('gone');
  await first.app.close();

  rmSync(goneDir, { recursive: true, force: true });
  ({ page } = await atlas.launch());
  await expect(projectName(page)).toHaveText('gone');
  const switcher = await openSwitcher(page);
  await expect(
    switcher.getByTestId('toolbar-project-option').filter({ hasText: 'gone' }),
  ).toContainText('Folder missing');
  await expect(switcher.getByTestId('toolbar-project-new-terminal')).toBeDisabled();
  await expect(switcher.getByTestId('toolbar-project-new-terminal')).toContainText(
    'The project folder is missing.',
  );
  await expect(switcher.getByTestId('toolbar-project-show-terminals')).toContainText(
    'No open terminals.',
  );
  await page.keyboard.press('Escape');

  // Removed while selected: the toolbar no longer shows it as current.
  const listed = JSON.parse(atlas.cli('project', 'list', '--json')) as {
    project: { id: string; name: string };
  }[];
  const gone = listed.find((item) => item.project.name === 'gone')!;
  atlas.cli('project', 'remove', gone.project.id, '--yes');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(projectName(page)).toHaveText('No project');
});

test('keeps the toolbar usable in a narrow window', async ({ atlas }) => {
  atlas.cli(
    'project',
    'add',
    atlas.workspace('a-project-with-a-rather-long-directory-name-to-test-truncation'),
  );
  const { app, page } = await atlas.launch();
  const menu = await openSwitcher(page);
  await menu.getByTestId('toolbar-project-option').click();

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(380, 700);
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(380);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  for (const id of ['toolbar-project', 'toolbar-new', 'toolbar-quick-commands']) {
    await expect(page.getByTestId(id)).toBeInViewport();
  }
  const bar = await page.getByTestId('app-bar').boundingBox();
  const bell = await page.getByRole('button', { name: /Notifications/ }).boundingBox();
  const quick = await page.getByTestId('toolbar-quick-commands').boundingBox();
  expect(bar && bell && quick).toBeTruthy();
  // Nothing overlaps: the creation actions end before the global indicators start.
  expect(quick!.x + quick!.width).toBeLessThanOrEqual(bell!.x);
  // The menus still open.
  await page.getByTestId('toolbar-new').click();
  await expect(page.getByTestId('toolbar-new-menu')).toBeInViewport();
});
