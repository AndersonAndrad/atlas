import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const openSessions = async (page: Page) => {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Sessions' })
    .click();
  await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible();
};

const choose = async (page: Page, trigger: string, option: string) => {
  await page.getByTestId(trigger).click();
  await page.getByRole('option', { name: option }).click();
};

const addTask = async (page: Page, title: string, dependsOn: string[] = []) => {
  await page.getByRole('button', { name: 'Add task' }).click();
  const dialog = page.getByTestId('task-form-dialog');
  await dialog.getByLabel('Title').fill(title);
  for (const dependency of dependsOn) await dialog.getByLabel(dependency).check();
  await dialog.getByRole('button', { name: 'Add task' }).click();
  await expect(dialog).toBeHidden();
};

test('creates a session from a project, plans tasks and starts it without fake execution', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('nova', { git: 'main' }), '--name', 'NOVA');
  const { page } = await atlas.launch();

  await page.getByTestId('project-card').click();
  await page.getByTestId('project-details').getByRole('button', { name: 'New session' }).click();
  const form = page.getByTestId('session-form-dialog');
  await expect(form.getByTestId('session-workspace')).toHaveText('Project: NOVA');
  await form.getByRole('button', { name: 'Create session' }).click();
  await expect(form.getByText('Name is required.')).toBeVisible();
  await form.getByLabel('Name').fill('NOVA auth');
  await form.getByLabel('Objective').fill('Implement authentication');
  await choose(page, 'session-profile', 'Economy');
  await form.getByLabel(/Constraints/).fill('Keep the public API\nNo new dependencies');
  await form.getByRole('button', { name: 'Create session' }).click();
  await expect(form).toBeHidden();

  await expect(page.getByTestId('no-executor-banner')).toBeVisible();
  const details = page.getByTestId('session-details');
  await expect(details.getByTestId('session-status')).toHaveText('Draft');
  await expect(details.getByTestId('session-execution-state')).toHaveText(
    'Not executing — configuration only',
  );
  await expect(details.getByTestId('session-objective')).toHaveText('Implement authentication');
  await expect(details.getByTestId('session-workspace-details')).toContainText('NOVA');
  await expect(details.getByTestId('session-profile-details')).toHaveText('Economy');
  await expect(details).toContainText('No new dependencies');

  await details.getByRole('tab', { name: /Tasks/ }).click();
  await addTask(page, 'Design');
  await addTask(page, 'Build', ['Design']);
  const tasks = details.getByTestId('session-task');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(1)).toContainText('Depends on: Design');
  await expect(tasks.nth(1).getByTestId('task-blocked')).toBeVisible();

  // A cycle is rejected by the Engine and explained.
  await tasks.nth(0).getByRole('button', { name: 'Task actions: Design' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const taskForm = page.getByTestId('task-form-dialog');
  await taskForm.getByLabel('Build').check();
  await taskForm.getByRole('button', { name: 'Save task' }).click();
  await expect(taskForm.getByTestId('task-form-error')).toHaveText(
    'Task dependencies cannot form a cycle.',
  );
  await taskForm.getByRole('button', { name: 'Cancel' }).click();

  const actions = details.getByTestId('session-actions');
  await actions.getByRole('button', { name: 'Mark ready' }).click();
  await expect(details.getByTestId('session-status')).toHaveText('Ready');
  await actions.getByRole('button', { name: 'Start' }).click();
  await expect(details.getByTestId('session-status')).toHaveText('Waiting for executor');
  await expect(details.getByTestId('waiting-executor')).toBeVisible();
  await expect(details.getByTestId('session-execution-state')).toHaveText(
    'Not executing — configuration only',
  );

  await details.getByRole('tab', { name: 'Events' }).click();
  const events = details.getByTestId('session-event');
  await expect(events.first()).toContainText('Started — waiting for an executor');
  await expect(details.getByTestId('session-events')).toContainText('Task added');
  await expect(details.getByTestId('session-events')).toContainText('Session created');

  await details.getByRole('tab', { name: 'Agents' }).click();
  await expect(details.getByTestId('session-agents')).toContainText('No agents assigned.');
  await details.getByRole('tab', { name: /Approvals/ }).click();
  await expect(details).toContainText('No pending approvals.');
});

test('uses a standalone folder, cancels and archives sessions', async ({ atlas }) => {
  const folder = atlas.workspace('scratch');
  const { app, page } = await atlas.launch();
  await openSessions(page);
  await expect(page.getByTestId('sessions-empty')).toBeVisible();

  await page.getByRole('button', { name: 'New session' }).first().click();
  const form = page.getByTestId('session-form-dialog');
  await form.getByLabel('Name').fill('Scratch');
  await form.getByLabel('Objective').fill('Try things');
  await choose(page, 'session-workspace', 'Folder…');
  await atlas.stubDirectoryPicker(app, folder);
  await form.getByRole('button', { name: 'Choose…' }).click();
  await expect(form.getByTestId('session-folder')).toHaveText(folder);
  await form.getByRole('button', { name: 'Create session' }).click();
  await expect(form).toBeHidden();

  const details = page.getByTestId('session-details');
  await expect(details.getByTestId('session-workspace-details')).toHaveText(folder);

  await details.getByRole('button', { name: 'Edit' }).click();
  await form.getByLabel('Name').fill('Scratch work');
  await form.getByRole('button', { name: 'Save draft' }).click();
  await expect(details.getByRole('heading', { name: 'Scratch work' })).toBeVisible();

  await details
    .getByTestId('session-actions')
    .getByRole('button', { name: 'Cancel session' })
    .click();
  const confirm = page.getByTestId('cancel-session-dialog');
  await confirm.getByRole('button', { name: 'Cancel session' }).click();
  await expect(details.getByTestId('session-status')).toHaveText('Cancelled');

  await details.getByTestId('session-actions').getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByTestId('sessions-empty')).toBeVisible();
  await page.getByLabel('Show archived').check();
  await expect(page.getByTestId('session-card')).toContainText('Archived');
});

test('restores sessions after a restart and shows CLI changes live', async ({ atlas }) => {
  atlas.cli('session', 'create', '--name', 'From CLI', '--objective', 'Created offline');
  const first = await atlas.launch();
  let { page } = first;
  await openSessions(page);
  await expect(page.getByTestId('session-card')).toHaveCount(1);
  await expect(page.getByTestId('session-card')).toContainText('From CLI');

  // With A.T.L.A.S running, the CLI goes through its Engine and the view updates.
  const id = (
    JSON.parse(atlas.cli('session', 'list', '--json')) as { session: { id: string } }[]
  )[0]!.session.id;
  atlas.cli('session', 'ready', id);
  await expect(page.getByTestId('session-details').getByTestId('session-status')).toHaveText(
    'Ready',
  );
  atlas.cli('session', 'create', '--name', 'Second', '--objective', 'Live');
  await expect(page.getByTestId('session-card')).toHaveCount(2);

  await first.app.close();
  ({ page } = await atlas.launch());
  await openSessions(page);
  await expect(page.getByTestId('session-card')).toHaveCount(2);
  await page.getByTestId('session-card').filter({ hasText: 'From CLI' }).click();
  await expect(page.getByTestId('session-details').getByTestId('session-status')).toHaveText(
    'Ready',
  );
});

test('requests from the Projects view are applied once', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('once'), '--name', 'Once');
  const { page } = await atlas.launch();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await page.getByTestId('project-card').click();
  const details = page.getByTestId('project-details');

  await details.getByRole('button', { name: 'Open terminal' }).click();
  await expect(page.getByTestId('terminal-tab')).toHaveCount(1);
  await nav.getByRole('button', { name: 'Projects' }).click();
  await nav.getByRole('button', { name: 'Terminals' }).click();
  await expect(page.getByTestId('terminal-pane')).toHaveCount(1);
  await expect(page.getByTestId('terminal-tab')).toHaveCount(1);
  expect(JSON.parse(atlas.cli('terminal', 'list', '--json'))).toHaveLength(1);

  await nav.getByRole('button', { name: 'Projects' }).click();
  await details.getByRole('button', { name: 'New session' }).click();
  await page.getByTestId('session-form-dialog').getByRole('button', { name: 'Cancel' }).click();
  await nav.getByRole('button', { name: 'Projects' }).click();
  await nav.getByRole('button', { name: 'Sessions' }).click();
  await expect(page.getByTestId('sessions-empty')).toBeVisible();
  await expect(page.getByTestId('session-form-dialog')).toBeHidden();
});
