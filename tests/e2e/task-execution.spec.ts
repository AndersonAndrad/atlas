import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openProjectTerminal, test } from './fixtures';

/**
 * Task execution (SDD-025 Task 02) with a fake `claude` that records its first argument and
 * exits with the code written in `exitFile` (0 when absent). The ATLAS wrapper reports its
 * start and end, as with the real CLI.
 */
function fakeClaude(binDir: string, root: string) {
  const prompt = path.join(root, 'claude-prompt.txt');
  const exitFile = path.join(root, 'claude-exit');
  const file = path.join(binDir, 'claude');
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${prompt}"\necho "FAKE CLAUDE READY"\n` +
      `[ -f "${exitFile}" ] && exit "$(cat "${exitFile}")"\nexit 0\n`,
  );
  chmodSync(file, 0o755);
  return { prompt, exitFile };
}

async function openTasks(page: Page, project: string) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Context', exact: true })
    .click();
  await expect(page.getByTestId('context-view')).toBeVisible();
  const selector = page.getByRole('combobox', { name: 'Project or repository' });
  if (!(await selector.innerText()).includes(project)) {
    await selector.click();
    await page.getByRole('option', { name: new RegExp(`^${project}`) }).click();
  }
  await page.getByRole('tab', { name: 'Tasks' }).click();
}

async function createTask(page: Page, title: string, objective: string) {
  await page.getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByTestId('context-task-dialog');
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Objective').fill(objective);
  await dialog.getByRole('button', { name: 'Create task' }).click();
  return page.getByTestId('context-task').filter({ hasText: title });
}

async function terminalShows(page: Page, text: string) {
  await expect
    .poll(
      async () =>
        (await page.locator('[data-testid="terminal-pane"] .xterm-rows').allInnerTexts()).join(
          '\n',
        ),
      { timeout: 15_000 },
    )
    .toContain(text);
}

test('runs a task in a new terminal after confirmation and asks for review', async ({ atlas }) => {
  const { prompt } = fakeClaude(atlas.binDir, atlas.root);
  atlas.cli('project', 'add', atlas.workspace('api'));
  const { page } = await atlas.launch();
  await openTasks(page, 'api');
  const task = await createTask(page, 'JWT authentication', 'Validate the token audience.');

  await task.getByTestId('task-execute').click();
  const dialog = page.getByTestId('execute-task-dialog');
  await expect(dialog.getByRole('radio', { name: /ATLAS team/ })).toBeDisabled();
  await expect(dialog.getByTestId('execute-task-preview')).toContainText(
    'Validate the token audience.',
  );
  const summary = dialog.getByTestId('execute-task-summary');
  await expect(summary).toContainText('JWT authentication');
  await expect(summary).toContainText('Claude Code · default account');
  await expect(summary).toContainText('A new terminal in');
  // Nothing ran before the confirmation.
  expect(existsSync(prompt)).toBe(false);
  await dialog.getByRole('button', { name: 'Run task' }).click();

  // The dialog closes; the run continues in its terminal, which is shown.
  await expect(dialog).toBeHidden();
  await terminalShows(page, 'FAKE CLAUDE READY');
  expect(readFileSync(prompt, 'utf8')).toContain('Validate the token audience.');

  await openTasks(page, 'api');
  const execution = task.getByTestId('task-execution');
  await expect(execution).toHaveAttribute('data-status', 'REVIEW_REQUIRED', { timeout: 15_000 });
  await expect(task.getByTestId('task-execution-badge')).toHaveText('Review required');
  // The task stays open: only the user marks it done.
  await expect(task).toContainText('open');

  await page.getByTestId('notifications-button').click();
  await expect(page.getByTestId('notification').first()).toContainText('review required');
  await page.keyboard.press('Escape');

  await task.getByText(/Executions \(1\)/).click();
  await execution.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(execution).toContainText('Reviewed');
  await expect(task.getByTestId('task-execution-badge')).toHaveCount(0);
});

test('refuses busy terminals and asks before using another project', async ({ atlas }) => {
  const { prompt } = fakeClaude(atlas.binDir, atlas.root);
  atlas.cli('project', 'add', atlas.workspace('api'));
  atlas.cli('project', 'add', atlas.workspace('web'));
  const { page } = await atlas.launch();

  // A busy terminal in the task's project and an idle one in another project.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
  await openProjectTerminal(page, 'api');
  const busyPane = page.getByTestId('terminal-pane').first();
  await busyPane.getByTestId('terminal-host').click();
  await page.keyboard.type('sleep 120');
  await page.keyboard.press('Enter');
  await openProjectTerminal(page, 'web');

  await openTasks(page, 'api');
  const task = await createTask(page, 'Fix login', 'Return 401 on expired tokens.');
  await task.getByTestId('task-execute').click();
  const dialog = page.getByTestId('execute-task-dialog');
  await dialog.getByRole('radio', { name: /Existing terminal/ }).check();
  const choices = dialog.getByTestId('execute-task-terminal');
  await expect(choices).toHaveCount(2);
  const busy = choices.filter({ hasText: 'Busy' });
  await expect(busy).toContainText('sleep');
  await expect(busy.getByRole('radio')).toBeDisabled();

  const other = choices.filter({ hasText: 'other project' });
  await other.getByRole('radio').check();
  await expect(dialog.getByTestId('execute-task-other')).toContainText('it belongs to web');
  const run = dialog.getByRole('button', { name: 'Run task' });
  await expect(run).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await run.click();

  await expect(dialog).toBeHidden();
  await terminalShows(page, 'FAKE CLAUDE READY');
  expect(readFileSync(prompt, 'utf8')).toContain('Return 401 on expired tokens.');
});

test('reports a failed run with a notification that opens the task', async ({ atlas }) => {
  const { exitFile } = fakeClaude(atlas.binDir, atlas.root);
  writeFileSync(exitFile, '3');
  atlas.cli('project', 'add', atlas.workspace('api'));
  const { page } = await atlas.launch();
  await openTasks(page, 'api');
  const task = await createTask(page, 'Broken task', 'This run fails.');
  await task.getByRole('button', { name: 'More actions for Broken task' }).click();
  await page.getByRole('menuitem', { name: 'Execute…' }).click();
  await page.getByTestId('execute-task-dialog').getByRole('button', { name: 'Run task' }).click();
  await terminalShows(page, 'FAKE CLAUDE READY');

  await page.getByTestId('notifications-button').click();
  const notification = page.locator('[data-testid="notification"][data-type="ERROR"]');
  await expect(notification).toContainText('Claude Code task failed', { timeout: 15_000 });
  await expect(notification).toContainText('exit code 3');
  await notification.getByRole('button').first().click();

  await expect(page.getByTestId('context-view')).toBeVisible();
  const opened = page.getByTestId('context-task').filter({ hasText: 'Broken task' });
  await expect(opened.getByTestId('task-execution')).toHaveAttribute('data-status', 'FAILED');
  await opened.getByText(/Executions \(1\)/).click();
  await opened.getByRole('button', { name: 'Open terminal' }).click();
  await expect(page.getByTestId('terminal-pane').first()).toBeVisible();
});
