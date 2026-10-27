import type { Page } from '@playwright/test';
import { expect, openProjectsDrawer, test } from './fixtures';

// PLAN-052: projects are reached from a palette and a drawer, not listed in the sidebar.

const navigate = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name }).click();

test('the terminal sidebar lists only open terminals; the palette opens a project action', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('alpha'));
  atlas.cli('project', 'add', atlas.workspace('beta'));
  const { app, page } = await atlas.launch();
  await navigate(page, 'Terminals');

  const sidebar = page.getByRole('navigation', { name: 'Terminal groups' });
  await expect(sidebar).toBeVisible();
  await expect(sidebar).not.toContainText('alpha');
  await expect(sidebar).not.toContainText('beta');

  // Button: search, choose the project, then its action, with the keyboard only.
  await sidebar.getByRole('button', { name: 'Search projects' }).click();
  const palette = page.getByTestId('project-palette');
  const search = palette.getByRole('combobox');
  await expect(search).toBeFocused();
  await expect(palette.getByTestId('palette-project')).toHaveCount(2);
  await search.fill('ALP');
  await expect(palette.getByTestId('palette-project')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(palette.getByRole('combobox', { name: 'Search actions for alpha…' })).toBeFocused();
  await expect(palette.getByTestId('project-action-open-terminal')).toBeVisible();

  // Escape and Backspace in an empty search go back to the projects, keeping the palette.
  await page.keyboard.press('Escape');
  await expect(palette.getByRole('combobox', { name: 'Search projects…' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Backspace');
  await expect(palette.getByRole('combobox', { name: 'Search projects…' })).toBeVisible();
  await page.keyboard.press('Enter');

  await page.keyboard.type('open term');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(sidebar.getByTestId('sidebar-terminal')).toHaveCount(1);
  await expect(sidebar).not.toContainText('beta');

  // Shortcut: the project just used comes first, under "Recently opened".
  await atlas.menu(app, 'projects.palette');
  await expect(palette).toBeVisible();
  const recent = palette.getByRole('group', { name: 'Recently opened' });
  await expect(recent.getByTestId('palette-project')).toHaveText('alpha');
  await expect(
    palette.getByRole('group', { name: 'Projects' }).getByTestId('palette-project'),
  ).toHaveText('beta');
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  // The terminal that had the keyboard gets it back.
  await expect(page.locator('.xterm-helper-textarea').first()).toBeFocused();
});

test('the drawer and the palette open from their shortcuts in any view and close with Escape', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('gamma'));
  const { app, page } = await atlas.launch();

  // From the Projects view: the shortcut switches to Terminals and shows the drawer.
  await atlas.menu(app, 'projects.drawer');
  const drawer = page.getByTestId('projects-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('drawer-project')).toHaveCount(1);
  await drawer.getByRole('searchbox', { name: 'Filter projects' }).fill('nothing');
  await expect(drawer.getByRole('status')).toContainText('No project matches');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // The button opens it as well, without the previous filter; details close it and show
  // the project sheet.
  await openProjectsDrawer(page);
  await expect(drawer.getByRole('searchbox', { name: 'Filter projects' })).toHaveValue('');
  await drawer.getByRole('button', { name: 'gamma', exact: true }).click();
  await drawer.getByRole('button', { name: 'Project details' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId('project-sheet')).toContainText('gamma');
  await page.keyboard.press('Escape');

  await navigate(page, 'Sessions');
  await atlas.menu(app, 'projects.palette');
  await expect(page.getByTestId('project-palette')).toBeVisible();
  await page.getByTestId('project-palette').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('project-palette')).toBeHidden();
});
