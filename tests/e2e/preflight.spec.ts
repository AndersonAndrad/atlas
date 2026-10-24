import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// SDD-007 Milestone A: checks run locally without any AI account. act and Docker are
// fakes on the app's PATH; no container runs.

const navigate = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name }).click();

test('discovers, authorizes, runs and reports local checks of a project', async ({ atlas }) => {
  const dir = atlas.workspace('web');
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      scripts: { lint: 'echo LINT_OK', test: 'echo FAILING >&2; exit 3', dev: 'vite' },
    }),
  );
  writeFileSync(
    path.join(atlas.binDir, 'npm'),
    '#!/bin/sh\n[ "$1" = run ] && shift\ncase "$1" in lint) echo LINT_OK ;; test) echo FAILING >&2; exit 3 ;; esac\n',
  );
  chmodSync(path.join(atlas.binDir, 'npm'), 0o755);
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();

  await navigate(page, 'Preflight');
  const view = page.getByTestId('preflight-view');
  await expect(view.getByText('needs no AI account')).toBeVisible();
  await view.getByRole('combobox', { name: 'Workspace' }).click();
  await page.getByRole('option', { name: 'web' }).click();

  // Discovery reads package.json and suggests scripts; long-running ones are left out.
  await view.getByRole('tab', { name: /Checks/ }).click();
  const suggestions = view.getByTestId('preflight-suggestions');
  await expect(suggestions.getByText('npm run lint')).toBeVisible();
  await expect(suggestions.getByRole('button', { name: 'Add dev' })).toHaveCount(0);
  for (const script of ['lint', 'test']) {
    await suggestions.getByRole('button', { name: `Add ${script}` }).click();
    const form = page.getByTestId('preflight-check-form');
    await form.getByRole('checkbox', { name: /Required/ }).click();
    await form.getByRole('button', { name: 'Add check' }).click();
    await expect(form).toBeHidden();
  }
  await expect(view.getByTestId('preflight-checks').getByRole('listitem')).toHaveCount(2);

  // A profile groups checks.
  await view.getByRole('tab', { name: /Profiles/ }).click();
  await view.getByRole('button', { name: 'Add profile' }).click();
  const profile = page.getByTestId('preflight-profile-form');
  await profile.getByLabel('Name').fill('Quick');
  await profile.getByRole('checkbox', { name: 'lint' }).click();
  await profile.getByRole('checkbox', { name: 'test' }).click();
  await profile.getByRole('button', { name: 'Add profile' }).click();
  await expect(view.getByTestId('preflight-profiles').getByText('Quick')).toBeVisible();

  // The first run asks for authorization and shows what runs.
  await view.getByRole('tab', { name: 'Run' }).click();
  await view.getByRole('button', { name: 'Run profile' }).click();
  const authorize = page.getByTestId('preflight-authorize');
  await expect(authorize.getByText('npm run lint')).toBeVisible();
  await expect(authorize.getByText('The script runs: echo LINT_OK')).toBeVisible();
  await expect(authorize.getByText(/not sandboxed/).first()).toBeVisible();
  await authorize.getByRole('button', { name: 'Authorize and run' }).click();

  const run = page.getByTestId('preflight-run');
  await expect(run.getByTestId('preflight-run-status')).toHaveText('Failed', { timeout: 30_000 });
  await expect(run.getByRole('button', { name: /test.*Failed/ })).toBeVisible();
  await expect(run.getByTestId('preflight-log')).toContainText('FAILING');
  await run.getByRole('button', { name: /lint.*Passed/ }).click();
  await expect(run.getByTestId('preflight-log')).toContainText('LINT_OK');

  // The same definitions do not ask again; history keeps both runs.
  await view.getByRole('button', { name: 'Run profile' }).click();
  await expect(page.getByTestId('preflight-authorize')).toHaveCount(0);
  await expect(run.getByTestId('preflight-run-status')).toHaveText('Failed', { timeout: 30_000 });
  await view.getByRole('tab', { name: 'History' }).click();
  await expect(view.getByTestId('preflight-history').getByRole('listitem')).toHaveCount(2);

  // The run, its checks and logs fit narrow and wide windows.
  await view.getByTestId('preflight-history').getByRole('button').first().click();
  for (const width of [380, 1440]) {
    await app.evaluate(({ BrowserWindow }, w) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(w, 800);
    }, width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    await expect(run.getByTestId('preflight-log')).toBeVisible();
  }
});

test('reports GitHub Actions jobs it cannot run and never runs them without act', async ({
  atlas,
}) => {
  const dir = atlas.workspace('ci');
  const workflows = path.join(dir, '.github', 'workflows');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(
    path.join(workflows, 'ci.yml'),
    [
      'name: CI',
      'on: [push]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps: [{run: npm test}]',
      '  mac:',
      '    runs-on: macos-15',
      '    steps: [{run: xcodebuild}]',
      '  release:',
      '    name: Unit tests',
      '    runs-on: ubuntu-latest',
      '    steps: [{run: npm publish}]',
    ].join('\n'),
  );
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await navigate(page, 'Preflight');
  const view = page.getByTestId('preflight-view');
  await view.getByRole('combobox', { name: 'Workspace' }).click();
  await page.getByRole('option', { name: 'ci' }).click();
  await expect(view.getByTestId('preflight-environment')).toContainText('act: not installed');

  await view.getByRole('tab', { name: 'Workflows' }).click();
  const workflowsTab = view.getByTestId('preflight-workflows');
  await expect(workflowsTab.getByText('not a GitHub-hosted CI result')).toBeVisible();
  const mac = workflowsTab.getByRole('listitem').filter({ hasText: 'mac' });
  await expect(mac.getByText('Unsupported')).toBeVisible();
  await expect(mac.getByRole('button', { name: 'Add job' })).toBeDisabled();
  // Side effects are found in what a step does, whatever the job is called.
  await expect(
    workflowsTab.getByText('May change something outside this computer: publishes a package'),
  ).toBeVisible();

  await workflowsTab
    .getByRole('listitem')
    .filter({ hasText: 'test' })
    .first()
    .getByRole('button', { name: 'Add job' })
    .click();
  await view.getByRole('tab', { name: 'Run' }).click();
  await view.getByRole('checkbox', { name: 'CI · test' }).click();
  await view.getByRole('button', { name: 'Run selected' }).click();
  await page
    .getByTestId('preflight-authorize')
    .getByRole('button', { name: 'Authorize and run' })
    .click();
  const run = page.getByTestId('preflight-run');
  await expect(run.getByTestId('preflight-run-status')).toHaveText('Incomplete', {
    timeout: 30_000,
  });
  await expect(
    run.getByRole('definition').filter({ hasText: /act is not available/ }),
  ).toBeVisible();
});
