import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Execute with ATLAS (SDD-026 Task 02) with a fake `claude` that appends its arguments
 * to `prompts` and exits with the code in `exitFile` (0 when absent). The ATLAS wrapper
 * reports each run's start and end, as with the real CLI.
 */
function fakeClaude(binDir: string, root: string) {
  const prompts = path.join(root, 'claude-prompts.txt');
  const exitFile = path.join(root, 'claude-exit');
  const file = path.join(binDir, 'claude');
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\n---\\n' "$@" >> "${prompts}"\necho "FAKE CLAUDE STAGE"\n` +
      `[ -f "${exitFile}" ] && exit "$(cat "${exitFile}")"\nexit 0\n`,
  );
  chmodSync(file, 0o755);
  return { prompts, exitFile };
}

async function createTask(page: Page, title: string, objective: string) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Context', exact: true })
    .click();
  await expect(page.getByTestId('context-view')).toBeVisible();
  await page.getByRole('tab', { name: 'Tasks' }).click();
  await page.getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByTestId('context-task-dialog');
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Objective').fill(objective);
  await dialog.getByRole('button', { name: 'Create task' }).click();
  return page.getByTestId('context-task').filter({ hasText: title });
}

async function backToTasks(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Context', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Tasks' }).click();
}

test('proposes a team, runs the approved members in order and asks for review', async ({
  atlas,
}) => {
  const { prompts } = fakeClaude(atlas.binDir, atlas.root);
  atlas.cli('project', 'add', atlas.workspace('api'));
  const { page } = await atlas.launch();
  const task = await createTask(
    page,
    'Login with tokens',
    'Add a login endpoint to the API and a login form page in the UI.\n- Wrong passwords show an error\n- The form is responsive',
  );

  await task.getByTestId('task-execute-atlas').click();
  const dialog = page.getByTestId('team-proposal-dialog');
  await expect(dialog.getByTestId('team-complexity')).toHaveText('Moderate task');
  const stages = dialog.getByTestId('team-stage');
  await expect(stages).toHaveCount(3);
  await expect(stages.nth(0)).toContainText('Backend Engineer');
  await expect(stages.nth(1)).toContainText('Frontend Engineer');
  await expect(stages.nth(2)).toContainText('Security Reviewer');
  // The user edits the team: the security review is removed.
  await stages.nth(2).getByRole('button', { name: 'Remove Security Reviewer' }).click();
  await expect(stages).toHaveCount(2);
  // Nothing ran before the approval.
  expect(existsSync(prompts)).toBe(false);
  await dialog.getByRole('button', { name: 'Approve and run' }).click();
  await expect(dialog).toBeHidden();

  await backToTasks(page);
  const team = task.getByTestId('team-execution');
  await expect(team.getByTestId('team-status')).toHaveText('Team finished · review required', {
    timeout: 30_000,
  });
  await expect(team.getByTestId('team-stage-status')).toHaveCount(2);
  await expect(team.getByTestId('team-stage-status').nth(0)).toContainText('finished');
  await expect(team.getByTestId('team-stage-status').nth(1)).toContainText('finished');
  await expect(team.getByTestId('team-summary')).toContainText('file(s) changed');
  await expect(task.getByTestId('task-team-badge')).toHaveText('Team finished · review required');

  // Each member got its role, in order, and the second one a handoff.
  const sent = readFileSync(prompts, 'utf8');
  const backend = sent.indexOf('You are the Backend Engineer');
  const frontend = sent.indexOf('You are the Frontend Engineer');
  expect(backend).toBeGreaterThanOrEqual(0);
  expect(frontend).toBeGreaterThan(backend);
  expect(sent).toContain('Handoff from the earlier members (from Git):');
  expect(sent).not.toContain('Security Reviewer of an ATLAS team');

  // One notification for the team, none per member; the task stays open.
  await page.getByTestId('notifications-button').click();
  await expect(page.getByTestId('notification')).toHaveCount(1);
  await expect(page.getByTestId('notification').first()).toContainText('ATLAS team finished');
  await page.keyboard.press('Escape');
  await expect(task).toContainText('open');

  await team.getByTestId('team-review').click();
  await expect(team.getByTestId('team-status')).toContainText('reviewed');
  await expect(task.getByTestId('task-team-badge')).toHaveCount(0);
});

test('a rejected proposal runs nothing; a failed member pauses until retried', async ({
  atlas,
}) => {
  const { prompts, exitFile } = fakeClaude(atlas.binDir, atlas.root);
  atlas.cli('project', 'add', atlas.workspace('api'));
  const { page } = await atlas.launch();
  const task = await createTask(page, 'Fix greeting typo', 'The greeting says Helo.');

  await task.getByTestId('task-execute-atlas').click();
  const dialog = page.getByTestId('team-proposal-dialog');
  await expect(dialog.getByTestId('team-complexity')).toHaveText('Simple task');
  await expect(dialog.getByTestId('team-stage')).toHaveCount(1);
  await expect(dialog.getByTestId('team-stage')).toContainText('Engineer');
  await dialog.getByTestId('team-reject').click();
  await expect(dialog).toBeHidden();
  expect(existsSync(prompts)).toBe(false);
  await expect(task.getByTestId('team-execution')).toHaveCount(0);

  writeFileSync(exitFile, '1');
  await task.getByTestId('task-execute-atlas').click();
  await dialog.getByRole('button', { name: 'Approve and run' }).click();
  await expect(dialog).toBeHidden();
  await backToTasks(page);
  const team = task.getByTestId('team-execution');
  await expect(team.getByTestId('team-pause')).toContainText('A member failed', {
    timeout: 30_000,
  });
  await expect(team.getByTestId('team-stage-status')).toContainText('failed (exit 1)');

  writeFileSync(exitFile, '0');
  await team.getByRole('button', { name: 'Retry member' }).click();
  await backToTasks(page);
  await expect(task.getByTestId('team-status')).toHaveText('Team finished · review required', {
    timeout: 30_000,
  });
});
