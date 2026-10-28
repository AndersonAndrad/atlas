import type { Page } from '@playwright/test';
import { expect, projectActions, test } from './fixtures';

// PLAN-023, SDD-025 Task 03: quick commands run from each project's actions (Projects drawer,
// PLAN-052), available in all projects or in selected ones.

const navigate = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name }).click();

test('quick commands are available in all projects or in the selected ones (SDD-025 Task 03)', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('web'));
  atlas.cli('project', 'add', atlas.workspace('api'));
  atlas.cli('project', 'add', atlas.workspace('other'));
  const { page } = await atlas.launch();

  await navigate(page, 'Quick commands');
  const view = page.getByTestId('quick-commands-view');
  await expect(view.getByText('No quick commands yet')).toBeVisible();

  const add = async (name: string, command: string, projects: string[]) => {
    await view.getByRole('button', { name: 'Add command' }).click();
    const dialog = page.getByTestId('quick-command-dialog');
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('Command').fill(command);
    const summary = dialog.getByTestId('quick-command-scope-summary');
    await expect(summary).toHaveText(
      'No projects selected: this command is available in all projects.',
    );
    for (const project of projects) {
      // Keyboard: the checkbox takes the focus and Space toggles it.
      await dialog.getByRole('listitem').filter({ hasText: project }).getByRole('checkbox').focus();
      await page.keyboard.press('Space');
    }
    if (projects.length > 0) {
      await expect(summary).toHaveText(
        `Available in ${projects.length} project${projects.length === 1 ? '' : 's'}.`,
      );
    }
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
  };

  // Validated before saving: a name is required.
  await view.getByRole('button', { name: 'Add command' }).click();
  let dialog = page.getByTestId('quick-command-dialog');
  await dialog.getByLabel('Command').fill('echo nope');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Name is required.')).toBeVisible();
  // Clear selection returns to all projects.
  await dialog.getByRole('listitem').filter({ hasText: 'web' }).getByRole('checkbox').click();
  await expect(dialog.getByTestId('quick-command-scope-summary')).toHaveText(
    'Available in 1 project.',
  );
  await dialog.getByRole('button', { name: 'Clear selection' }).click();
  await expect(dialog.getByTestId('quick-command-scope-summary')).toContainText('all projects');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await add('Say hi', 'echo QUICK_$((40+2))', []);
  await add('Web only', 'echo web', ['web']);
  await add('Two', 'echo two', ['web', 'api']);
  await add('Other only', 'echo other', ['other']);
  const rows = view.getByTestId('quick-command');
  await expect(rows.getByTestId('quick-command-scope')).toHaveText([
    'All projects',
    '1 project',
    '2 projects',
    '1 project',
  ]);
  await expect(rows.filter({ hasText: 'Two' }).getByTestId('quick-command-projects')).toHaveText(
    'web, api',
  );

  // Each project offers its commands; running one opens a single terminal there.
  await navigate(page, 'Terminals');
  const commandsOf = async (project: string) => {
    const actions = await projectActions(page, project);
    return actions.getByTestId('project-action-command');
  };
  await expect(await commandsOf('api')).toHaveText([/Say hi/, /Two/]);
  await expect(await commandsOf('other')).toHaveText([/Say hi/, /Other only/]);
  const web = await commandsOf('web');
  await expect(web).toHaveText([/Say hi/, /Web only/, /Two/]);
  await web.filter({ hasText: 'Say hi' }).click();
  await expect(page.getByTestId('projects-drawer')).toBeHidden();
  await expect(page.getByTestId('terminal-tab')).toHaveCount(1);
  const pane = page.getByTestId('terminal-pane').first();
  await expect
    .poll(() => pane.locator('.xterm-rows').innerText(), { timeout: 15_000 })
    .toContain('QUICK_42');

  // No project selected: the toolbar offers only the commands of all projects.
  await expect(page.getByTestId('toolbar-project-name')).toHaveText('No project');
  await page.getByTestId('toolbar-quick-commands').click();
  await expect(page.getByTestId('toolbar-quick-command')).toHaveText([/Say hi/]);
  await page.keyboard.press('Escape');

  // The project's tab adds it to a command; commands of all projects stay on.
  await navigate(page, 'Projects');
  await page.getByTestId('project-card').filter({ hasText: 'api' }).click();
  await page.getByRole('tab', { name: 'Quick commands' }).click();
  const tab = page.getByTestId('project-quick-commands');
  const global = tab.getByRole('checkbox', { name: 'Offer Say hi in this project' });
  await expect(global).toBeChecked();
  await expect(global).toBeDisabled();
  const webOnly = tab.getByRole('checkbox', { name: 'Offer Web only in this project' });
  await expect(webOnly).not.toBeChecked();
  await webOnly.click();
  await expect(webOnly).toBeChecked();

  // A removed project leaves its command available nowhere, never everywhere.
  const listed = JSON.parse(atlas.cli('project', 'list', '--json')) as {
    project: { id: string; name: string };
  }[];
  atlas.cli(
    'project',
    'remove',
    listed.find((item) => item.project.name === 'other')!.project.id,
    '--yes',
  );
  await navigate(page, 'Quick commands');
  const orphan = rows.filter({ hasText: 'Other only' });
  await expect(orphan.getByTestId('quick-command-scope')).toHaveText('No project');
  await orphan.getByRole('button', { name: 'Edit Other only' }).click();
  dialog = page.getByTestId('quick-command-dialog');
  await expect(dialog).toContainText('Saving without projects makes it available in all projects.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // From projects to all projects, in place.
  await rows.filter({ hasText: 'Web only' }).getByRole('button', { name: 'Edit Web only' }).click();
  dialog = page.getByTestId('quick-command-dialog');
  await dialog.getByRole('button', { name: 'Clear selection' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: 'Web only' }).getByTestId('quick-command-scope')).toHaveText(
    'All projects',
  );
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

test('a terminal opened from the project actions receives the keyboard', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('focus'));
  const { page } = await atlas.launch();
  await navigate(page, 'Terminals');
  const actions = await projectActions(page, 'focus');
  await actions.getByRole('button', { name: 'Open terminal' }).click();
  const pane = page.getByTestId('terminal-pane').first();
  await expect
    .poll(() => pane.locator('.xterm-rows').innerText(), { timeout: 15_000 })
    .toMatch(/\$\s*$/m);
  // No click on the terminal: the drawer must not have taken the focus back.
  await page.keyboard.type('echo FOCUS_$((1+1))');
  await page.keyboard.press('Enter');
  await expect.poll(() => pane.locator('.xterm-rows').innerText()).toContain('FOCUS_2');
});
