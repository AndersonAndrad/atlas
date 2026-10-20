import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * A repository with one pushed commit and its bare "origin" (both inside the
 * test's temporary root), plus one unpushed commit and a modified file.
 */
function repositoryWithRemote(dir: string, home: string) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ana Dev');
  git(dir, 'config', 'user.email', 'ana@example.com');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'chore: init');
  const origin = `${dir}-origin.git`;
  git(path.dirname(dir), 'clone', '-q', '--bare', dir, origin);
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'fetch', '-q', 'origin');
  git(dir, 'branch', '-q', '-u', 'origin/main');
  writeFileSync(path.join(dir, 'auth.ts'), 'export {};\n');
  git(dir, 'add', 'auth.ts');
  git(dir, 'commit', '-qm', 'feat: auth');
  writeFileSync(path.join(dir, 'README.md'), '# changed\n');
  return { origin, git: (...args: string[]) => git(dir, ...args), gitIn: git };
}

async function openGit(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Git', exact: true })
    .click();
  await expect(page.getByTestId('git-view')).toBeVisible();
}

const file = (page: Page, section: string, name: string) =>
  page.locator(`[data-testid="git-file"][data-section="${section}"][data-path="${name}"]`);

test('inspects, stages and commits with Conventional Commits, then pushes', async ({ atlas }) => {
  const dir = atlas.workspace('nova');
  const { origin, git, gitIn } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  writeFileSync(path.join(dir, 'notes.txt'), 'draft\n');
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();

  // Entry point: project details.
  await page.getByTestId('project-card').click();
  await page
    .getByTestId('project-details')
    .getByRole('button', { name: 'Git', exact: true })
    .click();
  await expect(page.getByTestId('git-repository-name')).toHaveText('nova');
  await expect(page.getByTestId('git-branch-name')).toHaveText('main');
  await expect(page.getByTestId('git-upstream')).toHaveText('origin/main');
  await expect(page.getByTestId('git-ahead-behind')).toHaveAttribute('data-ahead', '1');
  await expect(page.getByTestId('git-identity')).toContainText('Ana Dev');

  // Diff inspection of an unstaged file.
  await file(page, 'unstaged', 'README.md').locator('button[aria-pressed]').click();
  await expect(page.getByTestId('git-diff-path')).toHaveText('README.md');
  await expect(page.getByTestId('git-diff')).toContainText('+# changed');

  // Staging is per file and does not touch other files.
  await page.getByRole('button', { name: 'Stage README.md' }).click();
  await expect(file(page, 'staged', 'README.md')).toBeVisible();
  await expect(file(page, 'untracked', 'notes.txt')).toBeVisible();

  // Commit dialog: only staged content is selected by default.
  await page.getByRole('button', { name: 'Commit…' }).click();
  const dialog = page.getByTestId('commit-dialog');
  await expect(dialog.getByTestId('commit-branch')).toHaveText('main');
  await expect(dialog.getByTestId('commit-file-count')).toHaveText('1 file');
  await expect(dialog.getByTestId('commit-file')).toHaveCount(1);
  // Unselecting a staged file says it will leave the index; selecting it again restores it.
  const include = dialog.getByRole('checkbox', { name: 'Include README.md' });
  await include.click();
  await expect(dialog.getByTestId('commit-file')).toContainText('will be unstaged');
  await include.click();
  await expect(dialog.getByTestId('commit-file')).toContainText('staged');
  const message = dialog.getByLabel('Commit message');
  await message.fill('updated readme');
  await expect(dialog.getByTestId('commit-validation-badge')).toHaveText('Not conventional');
  await expect(dialog.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Commit & Push' })).toBeDisabled();
  await message.fill('docs(readme): describe the change\n\nRefs: #12');
  await expect(dialog.getByTestId('commit-validation-badge')).toHaveText('Conventional');

  await dialog.getByRole('button', { name: 'Commit & Push' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  expect(git('log', '-1', '--format=%B').trim()).toBe(
    'docs(readme): describe the change\n\nRefs: #12',
  );
  expect(gitIn(origin, 'rev-parse', 'main')).toBe(git('rev-parse', 'HEAD'));
  // The untracked file was not committed.
  expect(git('status', '--porcelain')).toContain('?? notes.txt');

  await expect(
    page.locator('[data-testid="git-operation"][data-kind="commit"]').first(),
  ).toHaveAttribute('data-status', 'succeeded');
  await expect(
    page.locator('[data-testid="git-operation"][data-kind="push"]').first(),
  ).toHaveAttribute('data-status', 'succeeded');
  await expect(page.getByTestId('git-ahead-behind')).toHaveAttribute('data-ahead', '0');
});

test('includes unstaged files only when chosen and reports hook failures', async ({ atlas }) => {
  const dir = atlas.workspace('hooks');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "lint failed in README.md" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openGit(page);

  await page.getByRole('button', { name: 'Commit…' }).click();
  const dialog = page.getByTestId('commit-dialog');
  // Nothing staged: unstaged files are listed but not selected.
  await expect(dialog.getByTestId('commit-file-count')).toHaveText('0 files');
  await dialog.getByRole('checkbox', { name: 'Include README.md' }).click();
  await expect(dialog.getByTestId('commit-will-stage')).toContainText('README.md');
  // The deterministic suggestion is shown for review and fills an empty message.
  await dialog.getByRole('button', { name: 'Suggest message' }).click();
  await expect(dialog.getByTestId('commit-suggestion')).toContainText('docs: update README.md');
  await expect(dialog.getByLabel('Commit message')).toHaveValue('docs: update README.md');
  await expect(dialog.getByTestId('commit-validation-badge')).toHaveText('Conventional');
  await dialog.getByRole('button', { name: 'Commit', exact: true }).click();

  const failure = dialog.getByTestId('commit-failure');
  await expect(failure).toContainText('remains staged', { timeout: 15_000 });
  await failure.getByText('Git output').click();
  await expect(failure.getByTestId('git-operation-output')).toContainText(
    'lint failed in README.md',
  );
  expect(git('log', '-1', '--format=%s').trim()).toBe('feat: auth');
  expect(git('diff', '--cached', '--name-only').trim()).toBe('README.md');
});

test('fetches, pulls fast-forward only and manages branches', async ({ atlas }) => {
  const dir = atlas.workspace('sync');
  const home = path.join(atlas.root, 'home');
  const { origin, git, gitIn } = repositoryWithRemote(dir, home);
  git('push', '-q', 'origin', 'main');
  git('checkout', '-q', '--', 'README.md');
  // Another clone pushes a commit the repository does not have yet.
  const other = path.join(atlas.root, 'other');
  gitIn(atlas.root, 'clone', '-q', origin, other);
  gitIn(other, 'config', 'user.name', 'Bob');
  gitIn(other, 'config', 'user.email', 'bob@example.com');
  writeFileSync(path.join(other, 'remote.txt'), 'from bob\n');
  gitIn(other, 'add', 'remote.txt');
  gitIn(other, 'commit', '-qm', 'feat: remote');
  gitIn(other, 'push', '-q', 'origin', 'main');
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openGit(page);
  await expect(page.getByTestId('git-last-fetch')).toContainText('Fetched');

  await page.getByRole('button', { name: 'Fetch', exact: true }).click();
  await expect(
    page.locator('[data-testid="git-operation"][data-kind="fetch"]').first(),
  ).toHaveAttribute('data-status', 'succeeded', { timeout: 15_000 });
  await expect(page.getByTestId('git-ahead-behind')).toHaveAttribute('data-behind', '1', {
    timeout: 10_000,
  });

  await page.getByRole('button', { name: 'Pull…' }).click();
  const pull = page.getByTestId('pull-dialog');
  await expect(pull.getByTestId('pull-behind')).toContainText('1 commit to pull');
  await expect(pull.getByRole('radio', { name: /Fast-forward only/ })).toBeChecked();
  await pull.getByRole('button', { name: 'Pull', exact: true }).click();
  await expect(pull).toBeHidden({ timeout: 15_000 });
  expect(git('log', '-1', '--format=%s').trim()).toBe('feat: remote');

  // Branches: create and switch, then switch back.
  await page.getByRole('button', { name: 'Branches…' }).click();
  const branches = page.getByTestId('branches-dialog');
  await branches.getByLabel('Branch name').fill('feature/login');
  await branches.getByRole('button', { name: 'Create branch' }).click();
  await expect(
    branches.locator('[data-testid="local-branch"][data-name="feature/login"]'),
  ).toBeVisible();
  await expect.poll(() => git('branch', '--show-current').trim()).toBe('feature/login');
  await branches
    .locator('[data-testid="local-branch"][data-name="main"]')
    .getByRole('button', { name: 'Switch' })
    .click();
  await expect.poll(() => git('branch', '--show-current').trim()).toBe('main');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('git-branch-name')).toHaveText('main');
});

test('opens the Git view from standalone terminals, the context menu and the shortcut', async ({
  atlas,
}) => {
  const { app, page } = await atlas.launch();
  await atlas.menu(app, 'view.git');
  await expect(page.getByTestId('git-empty')).toBeVisible();

  // A terminal inside a repository that is not a registered project.
  const dir = atlas.workspace('loose');
  repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  await atlas.stubDirectoryPicker(app, dir);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
  await page.getByRole('button', { name: 'More ways to open a terminal' }).click();
  await page.getByRole('menuitem', { name: 'Open in folder…' }).click();
  const pane = page.getByTestId('terminal-pane').first();
  await pane.getByRole('button', { name: 'Open Git panel' }).click({ timeout: 15_000 });
  await expect(page.getByTestId('git-repository-name')).toHaveText('loose');

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
  await pane.getByTestId('terminal-host').click({ button: 'right' });
  await page
    .getByTestId('terminal-context-menu')
    .getByRole('menuitem', { name: /Open Git panel/ })
    .click();
  await expect(page.getByTestId('git-repository-name')).toHaveText('loose');
});

test('applies stricter project conventions from Settings', async ({ atlas }) => {
  const dir = atlas.workspace('rules');
  repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  const settings = page.getByTestId('git-settings');
  await settings.getByLabel('Allowed commit types').fill('feat, fix');
  await settings.getByRole('button', { name: 'Save conventions' }).click();
  await expect(settings.getByRole('status')).toHaveText('Saved.');
  await settings.getByLabel(/Require a scope/).click();

  await openGit(page);
  await page.getByRole('button', { name: 'Commit…' }).click();
  const dialog = page.getByTestId('commit-dialog');
  const message = dialog.getByLabel('Commit message');
  await message.fill('docs(readme): x');
  await expect(dialog.getByTestId('commit-validation-errors')).toContainText('not allowed');
  await message.fill('fix: x');
  await expect(dialog.getByTestId('commit-validation-errors')).toContainText('requires a scope');
  await message.fill('fix(readme): x');
  await expect(dialog.getByTestId('commit-validation-badge')).toHaveText('Conventional');
});

test('Git view has no horizontal overflow across window sizes', async ({ atlas }) => {
  const dir = atlas.workspace('a-repository-with-a-rather-long-directory-name-to-test-wrapping');
  repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  const nested = path.join(dir, 'src/some/deeply/nested/folder/structure');
  execFileSync('mkdir', ['-p', nested]);
  writeFileSync(
    path.join(nested, 'a-file-with-a-very-long-name-for-layout-checks.ts'),
    'x\n'.repeat(50),
  );
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();
  await openGit(page);
  await page
    .locator('[data-testid="git-file"][data-section="unstaged"] button[aria-pressed]')
    .first()
    .click();
  await expect(page.getByTestId('git-diff')).toBeVisible();

  for (const size of [
    { width: 380, height: 700 },
    { width: 760, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await app.evaluate(({ BrowserWindow }, s) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height);
    }, size);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(size.width);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${size.width}px`).toBeLessThanOrEqual(0);
    await expect(page.getByRole('button', { name: 'Commit…' })).toBeVisible();
    if (process.env.ATLAS_SCREENSHOTS) {
      await page.screenshot({
        path: path.join(process.env.ATLAS_SCREENSHOTS, `git-${size.width}.png`),
      });
    }
  }
  if (process.env.ATLAS_SCREENSHOTS) {
    await page.getByRole('button', { name: 'Commit…' }).click();
    await page.getByTestId('commit-dialog').getByLabel('Include unstaged changes').click();
    await page
      .getByTestId('commit-dialog')
      .getByLabel('Commit message')
      .fill('fix(ui): prevent modal flickering during close animation');
    await page.screenshot({ path: path.join(process.env.ATLAS_SCREENSHOTS, 'commit-1440.png') });
  }
});
