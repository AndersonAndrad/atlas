import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

/** Opens the operations side panel from the Git view and returns it. */
async function openOperations(page: Page) {
  await page.getByTestId('git-operations-button').click();
  const sheet = page.getByTestId('git-operations-sheet');
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Opens the Git view's Actions menu (PLAN-020). */
async function openActions(page: Page) {
  // A menu still closing (after Escape) would be matched instead of the new one.
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByTestId('git-actions-button').click();
  await expect(page.getByRole('menu')).toBeVisible();
}

/** Runs an item of the Actions menu, e.g. "Pull…". */
async function gitAction(page: Page, name: string) {
  await openActions(page);
  // Pull and Push also show how many commits they would transfer, e.g. "Pull… 1".
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('menuitem', { name: new RegExp(`^${escaped}(\\s+\\d+)?$`) }).click();
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
  await page.getByRole('button', { name: 'Approve README.md' }).click();
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

  // Operations live in a side panel instead of the bottom of the view.
  await expect(page.getByRole('region', { name: 'Operations' })).toHaveCount(0);
  const sheet = await openOperations(page);
  await expect(
    sheet.locator('[data-testid="git-operation"][data-kind="commit"]').first(),
  ).toHaveAttribute('data-status', 'succeeded');
  await expect(
    sheet.locator('[data-testid="git-operation"][data-kind="push"]').first(),
  ).toHaveAttribute('data-status', 'succeeded');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('git-ahead-behind')).toHaveAttribute('data-ahead', '0');
});

test('keeps the operation log across restarts and shows terminal changes in the reflog', async ({
  atlas,
}) => {
  const dir = atlas.workspace('logged');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const first = await atlas.launch();
  await openGit(first.page);
  await first.page.getByRole('button', { name: 'Approve README.md' }).click();
  await expect(file(first.page, 'staged', 'README.md')).toBeVisible();
  await first.app.close();

  // A change made outside ATLAS, e.g. `git commit` typed in a terminal.
  git('commit', '-qm', 'docs: from the terminal');

  const { page } = await atlas.launch();
  await openGit(page);
  const sheet = await openOperations(page);
  await sheet.getByRole('tab', { name: 'History' }).click();
  const logged = sheet.getByTestId('git-logged-operation');
  await expect(logged).toHaveCount(1);
  await expect(logged.locator('[data-testid="git-operation"]')).toHaveAttribute(
    'data-kind',
    'stage',
  );
  await logged.getByRole('button', { name: /Show \d+ Git commands?/ }).click();
  await expect(sheet.getByTestId('git-command').first()).toBeVisible();
  await expect(sheet.getByTestId('git-operation-details')).toContainText('git ');
  await expect(sheet.getByTestId('git-operation-details')).toContainText('README.md');
  await sheet.getByRole('button', { name: 'Copy log' }).click();
  await expect(sheet.getByRole('button', { name: 'Copied' })).toBeVisible();

  await sheet.getByRole('tab', { name: 'Reflog' }).click();
  const latest = sheet.getByTestId('git-reflog-entry').first();
  await expect(latest).toContainText('docs: from the terminal');
  await expect(latest).toHaveAttribute('data-source', 'outside');
  await expect(latest).toContainText('Outside ATLAS');

  await page.keyboard.press('Escape');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings' })
    .click();
  const retention = page.getByTestId('git-log-settings');
  await retention.getByRole('combobox', { name: 'Keep operations for' }).click();
  await page.getByRole('option', { name: '30 days' }).click();
  await expect(retention.getByRole('combobox', { name: 'Keep operations for' })).toContainText(
    '30 days',
  );
});

test('searches the reflog and opens an entry to see its commit files (PLAN-022)', async ({
  atlas,
}) => {
  const dir = atlas.workspace('searchable');
  repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openGit(page);
  const sheet = await openOperations(page);
  await sheet.getByRole('tab', { name: 'Reflog' }).click();
  const entries = sheet.getByTestId('git-reflog-entry');
  await expect(entries).toHaveCount(2);

  const search = sheet.getByRole('searchbox', { name: 'Search the reflog by message or commit' });
  await search.fill('AUTH');
  await expect(entries).toHaveCount(1);
  await expect(sheet.getByRole('status').filter({ hasText: '1 result' })).toBeVisible();
  const entry = entries.first();
  await expect(entry).toContainText('feat: auth');

  await entry.getByRole('button').click();
  await expect(entry.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  const changed = entry.getByTestId('git-commit-file');
  await expect(changed).toHaveCount(1);
  await expect(changed).toHaveAttribute('data-change', 'added');
  await expect(changed).toContainText('auth.ts');
  await expect(changed).toContainText('+1');
  await entry.getByRole('button').press('Enter');
  await expect(entry.getByRole('button')).toHaveAttribute('aria-expanded', 'false');

  await search.fill('nothing like this');
  await expect(sheet.getByText('No matches')).toBeVisible();
  await expect(entries).toHaveCount(0);
  await search.fill('');
  await expect(entries).toHaveCount(2);
});
test('commit checks never inherit the NODE_ENV of ATLAS development builds', async ({ atlas }) => {
  const dir = atlas.workspace('fresh-env');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  const out = path.join(atlas.root, 'step-env.txt');
  const project = JSON.parse(atlas.cli('project', 'add', dir, '--json')) as {
    project: { id: string };
  };
  // As when ATLAS is started with `pnpm dev`.
  const { page } = await atlas.launch({
    env: { NODE_ENV: 'development', NODE_ENV_ELECTRON_VITE: 'development' },
  });
  // The check is stored through the app's own API, as Settings does.
  await page.evaluate(
    async ({ id, file }) => {
      const api = (
        window as unknown as {
          atlas: { git: { setProjectSettings: (id: string, s: unknown) => Promise<unknown> } };
        }
      ).atlas;
      await api.git.setProjectSettings(id, {
        enforceConventionalCommits: true,
        preCommitSteps: [
          {
            name: 'env',
            command: `printf '%s' "\${NODE_ENV:-unset}" > '${file}'`,
            mode: 'complete',
            timeoutSeconds: 30,
            readyAfterSeconds: 2,
            readyText: null,
          },
        ],
      });
    },
    { id: project.project.id, file: out },
  );
  await openGit(page);
  await page.getByRole('button', { name: 'Approve README.md' }).click();
  await expect(file(page, 'staged', 'README.md')).toBeVisible();
  await page.getByRole('button', { name: 'Commit…' }).click();
  const dialog = page.getByTestId('commit-dialog');
  await dialog.getByLabel('Commit message').fill('docs(readme): fresh environment');
  await dialog.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  expect(git('log', '-1', '--format=%s').trim()).toBe('docs(readme): fresh environment');
  expect(readFileSync(out, 'utf8')).toBe('unset');
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

  await gitAction(page, 'Fetch');
  await expect(page.getByTestId('git-ahead-behind')).toHaveAttribute('data-behind', '1', {
    timeout: 15_000,
  });
  // A successful fetch does not open the panel; its record is there on demand.
  await expect(page.getByTestId('git-operations-sheet')).toHaveCount(0);
  const operations = await openOperations(page);
  await expect(
    operations.locator('[data-testid="git-operation"][data-kind="fetch"]').first(),
  ).toHaveAttribute('data-status', 'succeeded');
  await page.keyboard.press('Escape');

  await gitAction(page, 'Pull…');
  const pull = page.getByTestId('pull-dialog');
  await expect(pull.getByTestId('pull-behind')).toContainText('1 commit to pull');
  await expect(pull.getByRole('radio', { name: /Fast-forward only/ })).toBeChecked();
  await pull.getByRole('button', { name: 'Pull', exact: true }).click();
  await expect(pull).toBeHidden({ timeout: 15_000 });
  expect(git('log', '-1', '--format=%s').trim()).toBe('feat: remote');

  // Branches: create and switch, then switch back.
  await gitAction(page, 'Branches…');
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
  await pane.getByRole('button', { name: 'Git actions' }).click({ timeout: 15_000 });
  const gitMenu = page.getByTestId('terminal-git-menu');
  await expect(gitMenu.getByRole('menuitem', { name: /Operations/ })).toBeVisible();
  await gitMenu.getByRole('menuitem', { name: 'Open Git panel' }).click();
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
  const conventionsSaved = settings.getByTestId('git-conventions-saved');
  await settings.getByLabel('Allowed commit types').fill('feat, fix');
  await settings.getByRole('button', { name: 'Save conventions' }).click();
  await expect(conventionsSaved).toHaveText('Saved.');
  // Editing again makes "Saved." stale; an invalid value reports an error that editing clears.
  await settings.getByLabel('Maximum header length').fill('abc');
  await expect(conventionsSaved).toBeHidden();
  await settings.getByRole('button', { name: 'Save conventions' }).click();
  await expect(settings.getByTestId('git-settings-error')).toContainText('whole number');
  await settings.getByLabel('Maximum header length').fill('');
  await expect(settings.getByTestId('git-settings-error')).toBeHidden();
  // A checkbox reports its own outcome, never next to "Save conventions".
  await settings.getByLabel(/Require a scope/).click();
  await expect(settings.getByTestId('git-preferences-status')).toHaveText('Saved.');
  await expect(conventionsSaved).toBeHidden();
  await expect(settings.getByLabel(/Require a scope/)).toBeChecked();

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

test('persists commit checks and blocks a commit until they pass', async ({ atlas }) => {
  const dir = atlas.workspace('checks');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  const head = git('rev-parse', 'HEAD');
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();
  await openGit(page);
  await gitAction(page, 'Commit checks…');
  const settings = page.getByTestId('commit-settings');
  await settings.getByLabel('Enforce Conventional Commits').click();
  await settings.getByRole('button', { name: 'Add step' }).click();
  await settings.getByLabel('Name, step 1').fill('Tests');
  await settings.getByLabel('Command, step 1').fill('echo check-failed >&2; exit 1');
  await settings.getByRole('button', { name: 'Save commit checks' }).click();
  await expect(settings.getByRole('status')).toHaveText('Saved.');

  for (const width of [380, 760, 1440]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(size, 800);
    }, width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    expect(await settings.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    await expect(settings.getByRole('button', { name: 'Save commit checks' })).toBeVisible();
    if (process.env.ATLAS_SCREENSHOTS) {
      await page.screenshot({
        path: path.join(process.env.ATLAS_SCREENSHOTS, `commit-checks-${width}.png`),
      });
    }
  }
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Commit…' }).click();
  const dialog = page.getByTestId('commit-dialog');
  await dialog.getByLabel('Include README.md', { exact: true }).click();
  await dialog.getByLabel('Commit message').fill('Updated readme');
  await expect(dialog.getByTestId('commit-checks')).toContainText('Tests');
  await dialog.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(dialog.getByTestId('commit-failure')).toContainText('Nothing was committed.');
  expect(git('rev-parse', 'HEAD')).toBe(head);
  expect(git('diff', '--cached', '--name-only').trim()).toBe('');
  await page.keyboard.press('Escape');

  await gitAction(page, 'Commit checks…');
  await expect(settings.getByLabel('Enforce Conventional Commits')).not.toBeChecked();
  await expect(settings.getByLabel('Command, step 1')).toHaveValue('echo check-failed >&2; exit 1');
  await settings.getByLabel('Command, step 1').fill('echo checks-passed');
  await settings.getByRole('button', { name: 'Save commit checks' }).click();
  await expect(settings.getByRole('status')).toHaveText('Saved.');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Commit…' }).click();
  await dialog.getByLabel('Include README.md', { exact: true }).click();
  await dialog.getByLabel('Commit message').fill('Updated readme');
  await dialog.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(git('log', '-1', '--format=%s').trim()).toBe('Updated readme');
});

test('adds, reorders and removes commit steps by their visible labels', async ({ atlas }) => {
  const dir = atlas.workspace('steps');
  repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openGit(page);
  await gitAction(page, 'Commit checks…');
  const settings = page.getByTestId('commit-settings');
  const steps = settings.getByTestId('commit-step-editor');

  await settings.getByRole('button', { name: 'Add step' }).click();
  await settings.getByLabel('Name, step 1').fill('Tests');
  await settings.getByLabel('Command, step 1').fill('npm test');
  await settings.getByRole('button', { name: 'Add step' }).click();
  await settings.getByLabel('Name, step 2').fill('Server');
  await settings.getByLabel('Command, step 2').fill('npm start');

  // A "start" step shows its own fields, named as they are labelled.
  await settings.getByRole('combobox', { name: 'Mode, step 2' }).click();
  await page.getByRole('option', { name: 'Start and stop' }).click();
  await expect(settings.getByLabel('Must keep running (s), step 2')).toHaveValue('15');
  await settings.getByLabel('Ready text (optional), step 2').fill('listening on');
  // Validation names the field by its visible label; editing clears the message.
  await settings.getByLabel('Ready text timeout (s), step 2').fill('1');
  await settings.getByRole('button', { name: 'Save commit checks' }).click();
  await expect(settings.getByTestId('commit-settings-error')).toContainText(
    'Step 2 — Ready text timeout (s):',
  );
  await settings.getByLabel('Ready text timeout (s), step 2').fill('60');
  await expect(settings.getByTestId('commit-settings-error')).toBeHidden();

  // Moving a step keeps keyboard focus on it; at the top, focus goes to its other move button.
  await settings.getByRole('button', { name: 'Move step 2 up' }).click();
  await expect(steps.nth(0).getByLabel('Name, step 1')).toHaveValue('Server');
  await expect(steps.nth(1).getByLabel('Name, step 2')).toHaveValue('Tests');
  await expect(settings.getByRole('button', { name: 'Move step 1 down' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(steps.nth(0).getByLabel('Name, step 1')).toHaveValue('Tests');
  await expect(settings.getByRole('button', { name: 'Move step 2 up' })).toBeFocused();

  await settings.getByRole('button', { name: 'Remove step 1' }).click();
  await expect(steps).toHaveCount(1);
  await expect(settings.getByLabel('Name, step 1')).toHaveValue('Server');
  await settings.getByRole('button', { name: 'Save commit checks' }).click();
  await expect(settings.getByRole('status')).toHaveText('Saved.');

  await page.keyboard.press('Escape');
  await gitAction(page, 'Commit checks…');
  await expect(steps).toHaveCount(1);
  await expect(settings.getByLabel('Name, step 1')).toHaveValue('Server');
  await expect(settings.getByLabel('Ready text (optional), step 1')).toHaveValue('listening on');
  await expect(settings.getByLabel('Ready text timeout (s), step 1')).toHaveValue('60');
});

test('approves a file from its diff and moves on only once it is staged', async ({ atlas }) => {
  const dir = atlas.workspace('approve');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  writeFileSync(path.join(dir, 'notes.txt'), 'draft\n');
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openGit(page);

  await file(page, 'unstaged', 'README.md').locator('button[aria-pressed]').click();
  await expect(page.getByTestId('git-diff-path')).toHaveText('README.md');

  // Staging fails while another Git process holds the index lock: the file stays shown.
  const lock = path.join(dir, '.git', 'index.lock');
  writeFileSync(lock, '');
  await page.getByTestId('git-diff-review').click();
  // A failed stage does not open the panel, but the button shows an unseen failure.
  await expect(page.getByTestId('git-operations-failure-dot')).toBeVisible({ timeout: 15_000 });
  const operations = await openOperations(page);
  await expect(
    operations.locator('[data-testid="git-operation"][data-kind="stage"]').first(),
  ).toHaveAttribute('data-status', 'failed');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('git-operations-failure-dot')).toHaveCount(0);
  await expect(page.getByTestId('git-diff-path')).toHaveText('README.md');
  expect(git('diff', '--cached', '--name-only').trim()).toBe('');

  rmSync(lock);
  await page.getByTestId('git-diff-review').click();
  await expect(file(page, 'staged', 'README.md')).toBeVisible();
  await expect(page.getByTestId('git-diff-path')).toHaveText('notes.txt');
  expect(git('diff', '--cached', '--name-only').trim()).toBe('README.md');
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

test('blocks committing until the commit checks load, then retries', async ({ atlas }) => {
  const dir = atlas.workspace('retry');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  git('add', 'README.md');
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();
  await openGit(page);
  // The first request for the commit checks fails; later ones answer (no projects apply).
  await app.evaluate(({ ipcMain }) => {
    let calls = 0;
    ipcMain.removeHandler('atlas:git:commit-context');
    ipcMain.handle('atlas:git:commit-context', () => {
      calls += 1;
      if (calls === 1) throw new Error('unavailable');
      return { ok: true, data: { projects: [] } };
    });
  });

  await page.getByRole('button', { name: 'Commit…' }).click();
  const dialog = page.getByTestId('commit-dialog');
  await dialog.getByLabel('Commit message').fill('docs: update readme');
  const contextError = dialog.getByTestId('commit-context-error');
  await expect(contextError).toContainText('could not be loaded');
  await expect(dialog.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  await contextError.getByRole('button', { name: 'Retry' }).click();
  await expect(contextError).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Commit', exact: true })).toBeEnabled();
});

test('keeps the commit and shows the push failure when pushing fails', async ({ atlas }) => {
  const dir = atlas.workspace('offline');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  // The upstream stays configured, but its remote points to a missing directory.
  git('remote', 'set-url', 'origin', path.join(atlas.root, 'missing-origin.git'));
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openGit(page);

  await page.getByRole('button', { name: 'Commit…' }).click();
  const dialog = page.getByTestId('commit-dialog');
  await dialog.getByRole('checkbox', { name: 'Include README.md' }).click();
  await dialog.getByLabel('Commit message').fill('docs: update readme');
  await dialog.getByRole('button', { name: 'Commit & Push' }).click();

  const result = dialog.getByTestId('commit-result');
  await expect(result.locator('[data-testid="git-operation"][data-kind="commit"]')).toHaveAttribute(
    'data-status',
    'succeeded',
    { timeout: 15_000 },
  );
  await expect(result.locator('[data-testid="git-operation"][data-kind="push"]')).toHaveAttribute(
    'data-status',
    'failed',
    { timeout: 15_000 },
  );
  expect(git('log', '-1', '--format=%s').trim()).toBe('docs: update readme');
  // Committing again is not offered; closing keeps the commit.
  await expect(dialog.getByRole('button', { name: 'Commit', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(dialog).toBeHidden();
});

test('commits listed staged files while other changes are not all listed', async ({ atlas }) => {
  const dir = atlas.workspace('many');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  git('add', 'README.md');
  // More untracked files than the Engine lists; the staged file is listed first.
  const untracked = path.join(dir, 'generated');
  mkdirSync(untracked);
  for (let index = 0; index < 2001; index += 1) {
    writeFileSync(path.join(untracked, `file-${index}.txt`), `${index}\n`);
  }
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openGit(page);

  await page.getByRole('button', { name: 'Commit…' }).click();
  const dialog = page.getByTestId('commit-dialog');
  await expect(dialog.getByTestId('commit-truncated')).toContainText('not listed', {
    timeout: 15_000,
  });
  await expect(dialog.getByTestId('commit-staged-truncated')).toHaveCount(0);
  await expect(dialog.getByTestId('commit-file-count')).toHaveText('1 file');
  await dialog.getByLabel('Commit message').fill('docs: update readme');
  await dialog.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  expect(git('log', '-1', '--format=%s').trim()).toBe('docs: update readme');
  expect(git('diff', '--cached', '--name-only').trim()).toBe('');
});

test('refuses commits while the stored commit checks are invalid', async ({ atlas }) => {
  const dir = atlas.workspace('invalid');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  git('add', 'README.md');
  const { project } = JSON.parse(atlas.cli('project', 'add', dir, '--json')) as {
    project: { id: string };
  };
  // Stored settings that no longer match the contract, as left by a broken edit.
  const db = new DatabaseSync(path.join(atlas.dataDir, 'atlas.db'));
  db.prepare('INSERT INTO application_settings (key, value) VALUES (?, ?)').run(
    `git.project.${project.id}`,
    '{"preCommitSteps":"npm test"}',
  );
  db.close();
  const { page } = await atlas.launch();
  await openGit(page);

  await page.getByRole('button', { name: 'Commit…' }).click();
  const dialog = page.getByTestId('commit-dialog');
  await dialog.getByLabel('Commit message').fill('docs: update readme');
  await expect(dialog.getByTestId('commit-settings-invalid')).toContainText(
    'commit checks settings are invalid; open settings to fix',
  );
  await expect(dialog.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  await gitAction(page, 'Commit checks…');
  const settings = page.getByTestId('commit-settings');
  await expect(settings.getByTestId('commit-settings-invalid')).toBeVisible();
  await settings.getByRole('button', { name: 'Save commit checks' }).click();
  await expect(settings.getByRole('status')).toHaveText('Saved.');
  await expect(settings.getByTestId('commit-settings-invalid')).toBeHidden();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Commit…' }).click();
  await dialog.getByLabel('Commit message').fill('docs: update readme');
  await expect(dialog.getByTestId('commit-settings-invalid')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  expect(git('log', '-1', '--format=%s').trim()).toBe('docs: update readme');
});

test('refuses commits while the stored Git preferences are invalid', async ({ atlas }) => {
  const dir = atlas.workspace('invalid-preferences');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  git('add', 'README.md');
  atlas.cli('project', 'add', dir);
  // Stored preferences that no longer match the contract, as left by a broken edit.
  const db = new DatabaseSync(path.join(atlas.dataDir, 'atlas.db'));
  db.prepare('INSERT INTO application_settings (key, value) VALUES (?, ?)').run(
    'git.preferences',
    '{"headerMaxLength":"short"}',
  );
  db.close();
  const { page } = await atlas.launch();
  await openGit(page);

  await page.getByRole('button', { name: 'Commit…' }).click();
  const dialog = page.getByTestId('commit-dialog');
  await dialog.getByLabel('Commit message').fill('docs: update readme');
  await expect(dialog.getByTestId('commit-preferences-invalid')).toHaveText(
    'Stored Git preferences are invalid; save to replace them.',
  );
  await expect(dialog.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  const settings = page.getByTestId('git-settings');
  await expect(settings.getByTestId('git-preferences-invalid')).toBeVisible();
  await settings.getByRole('button', { name: 'Save conventions' }).click();
  await expect(settings.getByTestId('git-conventions-saved')).toHaveText('Saved.');
  await expect(settings.getByTestId('git-preferences-invalid')).toHaveCount(0);

  await openGit(page);
  await page.getByRole('button', { name: 'Commit…' }).click();
  await dialog.getByLabel('Commit message').fill('docs: update readme');
  await expect(dialog.getByTestId('commit-preferences-invalid')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  expect(git('log', '-1', '--format=%s').trim()).toBe('docs: update readme');
});

test('opens the operations panel from a terminal and on remote failures', async ({ atlas }) => {
  const dir = atlas.workspace('ops');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();

  // From a terminal: the panel opens without leaving the Terminals view.
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
  await page.getByRole('button', { name: 'New terminal in ops' }).click();
  const pane = page.getByTestId('terminal-pane').first();
  await pane.getByRole('button', { name: 'Git actions' }).click({ timeout: 15_000 });
  await page
    .getByTestId('terminal-git-menu')
    .getByRole('menuitem', { name: /Operations/ })
    .click();
  const sheet = page.getByTestId('git-operations-sheet');
  await expect(sheet).toContainText('ops');
  await expect(sheet).toContainText('No Git operations yet.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('terminal-pane')).toHaveCount(1);

  // A failed fetch opens the panel by itself in the Git view.
  git('remote', 'set-url', 'origin', path.join(atlas.root, 'missing-remote.git'));
  await openGit(page);
  await gitAction(page, 'Fetch');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(
    sheet.locator('[data-testid="git-operation"][data-kind="fetch"]').first(),
  ).toHaveAttribute('data-status', 'failed');
});

test('shows commits to push and pull on the buttons and merges with a manual commit', async ({
  atlas,
}) => {
  const dir = atlas.workspace('merging');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  git('checkout', '-q', '--', 'README.md');
  git('switch', '-q', '-c', 'feature');
  writeFileSync(path.join(dir, 'feature.txt'), 'feature\n');
  git('add', 'feature.txt');
  git('commit', '-qm', 'feat: feature');
  git('switch', '-q', 'main');
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openGit(page);

  // One local commit to push, nothing to pull (as of the last fetch).
  await openActions(page);
  await expect(page.getByTestId('git-push-count')).toHaveText('1');
  await expect(page.getByTestId('git-pull-count')).toHaveText('0');
  await page.keyboard.press('Escape');

  await gitAction(page, 'Merge…');
  const dialog = page.getByTestId('merge-dialog');
  // Typing filters the branches; Enter chooses the highlighted one.
  const search = dialog.getByRole('combobox', { name: 'Branch to merge' });
  await search.fill('feat');
  await expect(dialog.getByTestId('branch-picker').getByRole('option')).toHaveCount(1);
  await search.press('Enter');
  await expect(dialog.getByTestId('merge-selected')).toContainText('feature');
  await expect(dialog.getByTestId('merge-preview')).toContainText('1 commit of feature');
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(dialog.getByTestId('merge-success')).toContainText('Merge ready — no conflicts');
  expect(git('log', '-1', '--format=%s').trim()).toBe('feat: auth');

  // Committing is manual, with Git's merge message, although Conventional Commits are enforced.
  await dialog.getByRole('button', { name: 'Commit merge' }).click();
  const commit = page.getByTestId('commit-dialog');
  await expect(commit.getByTestId('commit-merge-notice')).toBeVisible();
  await expect(commit.getByLabel('Commit message')).toHaveValue("Merge branch 'feature'");
  await expect(commit.getByTestId('commit-validation-badge')).toHaveText('Merge commit');
  await commit.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(commit).toBeHidden({ timeout: 15_000 });
  expect(git('log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2);
  expect(git('log', '-1', '--format=%s').trim()).toBe("Merge branch 'feature'");
  await expect(page.getByTestId('git-merge-banner')).toHaveCount(0);
  await openActions(page);
  await expect(page.getByTestId('git-push-count')).toHaveText('3');
  await page.keyboard.press('Escape');
});

test('shows merge conflicts with a copyable message and aborts on confirmation', async ({
  atlas,
}) => {
  const dir = atlas.workspace('conflicts');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  git('checkout', '-q', '--', 'README.md');
  git('switch', '-q', '-c', 'feature');
  writeFileSync(path.join(dir, 'README.md'), 'from feature\n');
  git('commit', '-qam', 'docs: feature readme');
  git('switch', '-q', 'main');
  writeFileSync(path.join(dir, 'README.md'), 'from main\n');
  git('commit', '-qam', 'docs: main readme');
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();
  await openGit(page);

  await gitAction(page, 'Merge…');
  const dialog = page.getByTestId('merge-dialog');
  await dialog.getByRole('combobox', { name: 'Branch to merge' }).click();
  await page.getByRole('option', { name: 'feature', exact: true }).click();
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
  const conflict = dialog.getByTestId('merge-conflict');
  await expect(conflict).toContainText('README.md');
  await expect(conflict.getByTestId('merge-conflict-output')).toContainText('CONFLICT');
  await conflict.getByRole('button', { name: 'Copy message' }).click();
  await expect(conflict.getByRole('button', { name: 'Copied' })).toBeVisible();
  const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(clipboard).toContain('README.md');
  expect(clipboard).toContain('CONFLICT');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const banner = page.getByTestId('git-merge-banner');
  await expect(banner).toContainText('Resolve the conflicts');
  await openActions(page);
  await expect(page.getByRole('menuitem', { name: 'Merge…', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
  await banner.getByRole('button', { name: 'Abort merge…' }).click();
  await page.getByTestId('abort-merge-dialog').getByRole('button', { name: 'Abort merge' }).click();
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  expect(git('status', '--porcelain').trim()).toBe('');
});

test('searches long branch lists in the Branches dialog', async ({ atlas }) => {
  const dir = atlas.workspace('many-branches');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  git('checkout', '-q', '--', 'README.md');
  for (let i = 0; i < 30; i += 1) git('branch', `feature/task-${i}`);
  git('branch', 'hotfix/login-timeout');
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openGit(page);

  await gitAction(page, 'Branches…');
  const dialog = page.getByTestId('branches-dialog');
  const search = dialog.getByRole('searchbox', { name: 'Search branches' });
  await expect(search).toBeFocused();
  await expect(dialog.getByTestId('local-branch')).toHaveCount(32);

  await search.fill('LOGIN');
  await expect(dialog.getByTestId('local-branch')).toHaveCount(1);
  await expect(dialog.getByTestId('local-branch-count')).toHaveText('(1 of 32)');
  await expect(dialog.getByTestId('remote-branch')).toHaveCount(0);

  await search.fill('task-2');
  // task-2 and task-20…task-29.
  await expect(dialog.getByTestId('local-branch')).toHaveCount(11);

  await search.fill('nothing-like-this');
  await expect(dialog.getByTestId('branches-empty')).toContainText('nothing-like-this');

  // Escape clears the search first, then closes the dialog.
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('local-branch')).toHaveCount(32);

  // Actions work on filtered results.
  await search.fill('hotfix');
  await dialog
    .locator('[data-testid="local-branch"][data-name="hotfix/login-timeout"]')
    .getByRole('button', { name: 'Switch' })
    .click();
  await expect.poll(() => git('branch', '--show-current').trim()).toBe('hotfix/login-timeout');

  await search.press('Escape');
  await search.press('Escape');
  await expect(dialog).toBeHidden();
});

test('cherry-picks commits of another branch, keeping them, and aborts a conflicting one (PLAN-019)', async ({
  atlas,
}) => {
  const dir = atlas.workspace('picks');
  const { git } = repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  git('checkout', '-q', '--', 'README.md');
  git('switch', '-q', '-c', 'feature');
  writeFileSync(path.join(dir, 'one.ts'), 'export const one = 1;\n');
  git('add', 'one.ts');
  git('commit', '-qm', 'feat: add one');
  writeFileSync(path.join(dir, 'two.ts'), 'export const two = 2;\n');
  git('add', 'two.ts');
  git('commit', '-qm', 'feat: add two');
  writeFileSync(path.join(dir, 'README.md'), 'from feature\n');
  git('commit', '-qam', 'docs: feature readme');
  git('switch', '-q', 'main');
  writeFileSync(path.join(dir, 'README.md'), 'from main\n');
  git('commit', '-qam', 'docs: main readme');
  const before = git('rev-parse', 'HEAD').trim();
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openGit(page);

  await gitAction(page, 'Cherry-pick…');
  const dialog = page.getByTestId('cherry-pick-dialog');
  await dialog.getByRole('combobox', { name: 'Take commits from' }).click();
  // The current branch is never offered as a source.
  await expect(page.getByRole('option', { name: 'main', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'feature', exact: true }).click();
  await expect(dialog.getByTestId('cherry-pick-commit')).toHaveCount(3);
  await dialog.getByRole('checkbox', { name: /Pick .* feat: add two/ }).click();
  await dialog.getByRole('checkbox', { name: /Pick .* feat: add one/ }).click();
  await expect(dialog.getByTestId('cherry-pick-summary')).toContainText(
    '2 commits will be applied',
  );
  await dialog.getByRole('button', { name: 'Cherry-pick 2 commits' }).click();
  await expect(dialog.getByTestId('cherry-pick-success')).toContainText(
    'Applied 2 commits of feature to main.',
  );
  // Normal cherry-pick: one commit each, original messages, in the source order.
  expect(git('log', '--format=%s', '-3').trim().split('\n')).toEqual([
    'feat: add two',
    'feat: add one',
    'docs: main readme',
  ]);
  expect(git('log', '-1', '--format=%B')).toContain('(cherry picked from commit');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // A conflicting commit stops; the banner continues, skips or aborts.
  await gitAction(page, 'Cherry-pick…');
  await dialog.getByRole('combobox', { name: 'Take commits from' }).click();
  await page.getByRole('option', { name: 'feature', exact: true }).click();
  await expect(
    dialog.getByTestId('cherry-pick-commit').filter({ hasText: 'feat: add one' }),
  ).toHaveAttribute('data-applied', 'true');
  await dialog.getByRole('checkbox', { name: /Pick .* docs: feature readme/ }).click();
  await dialog.getByRole('button', { name: 'Cherry-pick 1 commit' }).click();
  await expect(dialog.getByTestId('cherry-pick-stopped')).toContainText('README.md');
  await page.keyboard.press('Escape');
  const banner = page.getByTestId('git-cherry-pick-banner');
  await expect(banner).toContainText('docs: feature readme');
  await expect(banner.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await banner.getByRole('button', { name: 'Abort cherry-pick…' }).click();
  await page
    .getByTestId('abort-cherry-pick-dialog')
    .getByRole('button', { name: 'Abort cherry-pick' })
    .click();
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  expect(git('status', '--porcelain').trim()).toBe('');
  expect(git('log', '--format=%s', '-1').trim()).toBe('feat: add two');
  expect(git('rev-parse', 'HEAD~2').trim()).toBe(before);
});

test('keeps the Git actions at the top right and truncates long names (PLAN-020)', async ({
  atlas,
}) => {
  const dir = atlas.workspace(
    'a-repository-with-a-very-long-name-that-would-push-everything-else-out-of-the-way',
  );
  repositoryWithRemote(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();
  await openGit(page);

  for (const width of [1440, 900, 380]) {
    await app.evaluate(({ BrowserWindow }, w) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(w, 800);
    }, width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    const name = (await page.getByTestId('git-repository-name').boundingBox())!;
    const actions = (await page.getByTestId('git-actions').boundingBox())!;
    const summary = (await page.getByTestId('git-summary').boundingBox())!;
    // Same row as the name, at the right edge of the summary.
    expect(Math.abs(actions.y - name.y), `actions on the name's row at ${width}px`).toBeLessThan(8);
    expect(summary.x + summary.width - (actions.x + actions.width)).toBeLessThan(24);
    expect(actions.x).toBeGreaterThan(name.x + name.width - 1);
    const truncated = await page
      .getByTestId('git-repository-name')
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(truncated, `name truncated at ${width}px`).toBe(width < 1440 || truncated);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
  }
  await expect(page.getByTestId('git-repository-name')).toHaveAttribute(
    'title',
    'a-repository-with-a-very-long-name-that-would-push-everything-else-out-of-the-way',
  );
});
