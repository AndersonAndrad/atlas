import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// SDD-012 Milestone A: background jobs run in the Engine, independent of views and
// terminals, and stop with ATLAS. Commands are plain shell commands; no AI runs.

const navigate = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true })
    .click();

async function openNotifications(page: Page) {
  await page.getByTestId('notifications-button').click();
  const center = page.getByTestId('notification-center');
  await expect(center).toBeVisible();
  return center;
}

const jobRow = (page: Page, title: string) =>
  page.getByTestId('job-row').filter({ has: page.getByText(title, { exact: true }) });

async function queueCommand(page: Page, command: string, options: { project?: string } = {}) {
  await page
    .getByTestId('operations-view')
    .getByRole('button', { name: 'New command job' })
    .click();
  const dialog = page.getByTestId('new-command-job');
  if (options.project) {
    await dialog.getByRole('combobox', { name: 'Project' }).click();
    await page.getByRole('option', { name: options.project }).click();
  }
  await dialog.getByLabel('Command').fill(command);
  await dialog.getByRole('button', { name: 'Queue job' }).click();
  return dialog;
}

test('runs a command job in the background with its log and a notification (Scenario B)', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('payments'));
  const { page } = await atlas.launch();
  await navigate(page, 'Operations');
  const view = page.getByTestId('operations-view');
  await expect(view.getByText('Nothing is running or queued.')).toBeVisible();

  const dialog = await queueCommand(page, 'sleep 2; echo "hello from $(basename "$PWD")"');
  await expect(dialog).toBeHidden();
  // The header shows it while it runs, from any view; leaving the view does not stop it.
  const indicator = page.getByTestId('operations-indicator');
  await expect(indicator).toContainText('1 running');
  await navigate(page, 'Terminals');
  await expect(indicator).toContainText('1 running');
  await indicator.click();

  const row = jobRow(page, 'sleep 2; echo "hello from $(basename "$PWD")"');
  await expect(row).toHaveAttribute('data-status', 'COMPLETED', { timeout: 15_000 });
  await expect(indicator).toBeHidden();
  await row.locator('button[aria-pressed]').click();
  const details = page.getByTestId('job-details');
  await expect(details.getByTestId('job-status')).toHaveText('Completed');
  await expect(details.getByTestId('job-log')).toContainText('hello from payments');
  await expect(details.getByTestId('job-history')).toContainText('Started');

  await expect((await openNotifications(page)).getByText('Background job completed')).toBeVisible();
});

test('confirms destructive commands, limits concurrency and cancels (Scenario D)', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('billing'));
  const { page } = await atlas.launch();
  await navigate(page, 'Operations');
  const view = page.getByTestId('operations-view');

  // A destructive command is queued only after an explicit confirmation.
  const dialog = await queueCommand(page, 'rm -rf build');
  await expect(dialog.getByTestId('job-dangers')).toContainText('deletes files recursively');
  await expect(dialog.getByRole('button', { name: 'Queue job' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /queue it anyway/ }).click();
  await dialog.getByRole('button', { name: 'Queue job' }).click();
  await expect(jobRow(page, 'rm -rf build')).toHaveAttribute('data-status', 'COMPLETED', {
    timeout: 15_000,
  });

  // One job at a time: the second waits in the queue.
  await view.getByRole('button', { name: 'Limits' }).click();
  const limits = page.getByTestId('job-limits');
  await limits.getByLabel('Jobs at once').fill('1');
  await limits.getByRole('button', { name: 'Save' }).click();
  await expect(limits).toBeHidden();
  await queueCommand(page, 'sleep 30');
  await queueCommand(page, 'echo second');
  await expect(jobRow(page, 'sleep 30')).toHaveAttribute('data-status', 'RUNNING');
  await expect(jobRow(page, 'echo second')).toHaveAttribute('data-status', 'QUEUED');
  await expect(page.getByTestId('operations-indicator')).toContainText('1 running · 1 queued');

  // Cancelling the running job lets the queued one start.
  await jobRow(page, 'sleep 30').getByRole('button', { name: 'Cancel' }).click();
  await expect(jobRow(page, 'sleep 30')).toHaveAttribute('data-status', 'CANCELLED', {
    timeout: 15_000,
  });
  await expect(jobRow(page, 'echo second')).toHaveAttribute('data-status', 'COMPLETED', {
    timeout: 15_000,
  });
  // A cancelled job can run again.
  await expect(jobRow(page, 'sleep 30').getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('runs a Preflight profile in the background and opens its result (Scenario A)', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('web'));
  const { page } = await atlas.launch();
  // Configure a profile through the bridge; the Preflight screens are covered elsewhere.
  await page.evaluate(async () => {
    type Result<T> = { ok: true; data: T };
    const atlasApi = (
      window as unknown as {
        atlas: {
          projects: { list(): Promise<Result<{ project: { id: string } }[]>> };
          preflight: {
            openProject(id: string): Promise<Result<{ id: string }>>;
            saveConfig(id: string, config: unknown): Promise<unknown>;
          };
        };
      }
    ).atlas;
    const [details] = (await atlasApi.projects.list()).data;
    const workspace = (await atlasApi.preflight.openProject(details!.project.id)).data;
    const check = (id: string, command: string) => ({
      id,
      name: id,
      type: 'COMMAND',
      category: 'CUSTOM',
      workingDirectory: '',
      command,
      packageManager: null,
      script: null,
      workflowPath: null,
      workflowJob: null,
      act: null,
      required: true,
      enabled: true,
      timeoutSeconds: 60,
      executionTriggers: ['MANUAL'],
      dependsOn: [],
      exclusive: false,
      requiredTools: [],
      env: {},
    });
    await atlasApi.preflight.saveConfig(workspace.id, {
      checks: [check('lint', 'echo LINT_OK'), check('slow', 'sleep 1; echo SLOW_OK')],
      profiles: [{ id: 'quick', name: 'Quick', checkIds: ['lint', 'slow'], concurrency: 1 }],
    });
  });

  await navigate(page, 'Preflight');
  const preflight = page.getByTestId('preflight-view');
  await preflight.getByRole('combobox', { name: 'Workspace' }).click();
  await page.getByRole('option', { name: 'web' }).click();
  await preflight.getByRole('button', { name: 'Run in background' }).click();
  // The same authorization as a run started here.
  await page
    .getByTestId('preflight-authorize')
    .getByRole('button', { name: 'Authorize and run' })
    .click();
  await expect(preflight.getByTestId('preflight-queued')).toContainText('Preflight: Quick');

  // The user switches to another view; the validation continues.
  await navigate(page, 'Operations');
  const row = jobRow(page, 'Preflight: Quick');
  await expect(row).toHaveAttribute('data-status', 'COMPLETED', { timeout: 20_000 });
  const center = await openNotifications(page);
  // Preflight reports the run; the job adds no second notification.
  await expect(center.getByText('Preflight passed')).toBeVisible();
  await expect(center.getByText('Background job completed')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await row.getByRole('button', { name: 'Open result' }).click();
  await expect(page.getByTestId('preflight-view')).toBeVisible();
  await expect(page.getByTestId('preflight-view')).toContainText('Passed');
});

test('reports jobs stopped by quitting as interrupted after a restart (Scenario C)', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('infra'));
  const first = await atlas.launch();
  let page = first.page;
  await navigate(page, 'Operations');
  await queueCommand(page, 'sleep 60');
  await expect(jobRow(page, 'sleep 60')).toHaveAttribute('data-status', 'RUNNING');

  // Quitting asks first, then stops the job.
  await atlas.stubMessageBox(first.app, 0);
  await first.app.close();

  page = (await atlas.launch()).page;
  await navigate(page, 'Operations');
  const row = jobRow(page, 'sleep 60');
  await expect(row).toHaveAttribute('data-status', 'INTERRUPTED');
  // Stopped by the quit (or, if the Engine was killed first, found unfinished on start).
  await expect(row).toContainText(/ATLAS (quit while|stopped before) the job/);
  // Nothing started again by itself; the user may retry.
  await expect(page.getByTestId('operations-indicator')).toBeHidden();
  await expect(row.getByRole('button', { name: 'Retry' })).toBeVisible();
});
