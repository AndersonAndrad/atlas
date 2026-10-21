import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** A fake provider CLI: records its arguments, one per line, and prints a marker. */
function fakeCli(binDir: string, name: string, home: string) {
  const file = path.join(binDir, name);
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${path.join(home, `${name}-prompt.txt`)}"\necho "FAKE ${name.toUpperCase()} READY"\n`,
  );
  chmodSync(file, 0o755);
  return path.join(home, `${name}-prompt.txt`);
}

function repository(dir: string, home: string) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Ana');
  git('config', 'user.email', 'ana@example.com');
  git('add', '.');
  git('commit', '-qm', 'chore: init');
  return git;
}

async function openContext(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Context', exact: true })
    .click();
  await expect(page.getByTestId('context-view')).toBeVisible();
}

test('records, searches and corrects project memory, tasks and decisions', async ({ atlas }) => {
  const dir = atlas.workspace('payments');
  repository(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openContext(page);
  await expect(page.getByTestId('context-overview')).toContainText('ATLAS Shared Context');

  await page.getByRole('tab', { name: 'Memory' }).click();
  await page.getByRole('button', { name: 'Add entry' }).click();
  const entryDialog = page.getByTestId('context-entry-dialog');
  await entryDialog.getByLabel('Title').fill('Hexagonal architecture');
  await entryDialog.getByLabel('Details').fill('Ports live in src/core; adapters in src/infra.');
  await entryDialog.getByRole('button', { name: 'Save' }).click();
  const entries = page.getByTestId('context-entry');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('By you');

  await page.getByRole('searchbox', { name: 'Search memory' }).fill('adapt');
  await expect(entries).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search memory' }).fill('nothing-here');
  await expect(entries).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search memory' }).fill('');

  // Corrections keep the previous version in the history.
  await page.getByRole('button', { name: 'Edit Hexagonal architecture' }).click();
  await entryDialog.getByLabel('Details').fill('Ports live in src/domain.');
  await entryDialog.getByLabel('Reason for the change (optional)').fill('moved');
  await entryDialog.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'History of Hexagonal architecture' }).click();
  await expect(page.getByTestId('context-revision')).toHaveCount(2);
  await expect(page.getByTestId('context-history-dialog')).toContainText('Reason: moved');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Mark Hexagonal architecture obsolete' }).click();
  await expect(entries).toHaveCount(0);

  await page.getByRole('tab', { name: 'Tasks' }).click();
  await page.getByRole('button', { name: 'New task' }).click();
  const taskDialog = page.getByTestId('context-task-dialog');
  await taskDialog.getByLabel('Title').fill('JWT authentication');
  await taskDialog.getByLabel('Objective').fill('Implement JWT login and refresh');
  await taskDialog.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByTestId('context-task')).toContainText('JWT authentication');

  await page.getByRole('tab', { name: 'Decisions' }).click();
  await page.getByRole('button', { name: 'Record decision' }).click();
  const decisionDialog = page.getByTestId('context-decision-dialog');
  await decisionDialog.getByLabel('Question').fill('Token storage');
  await decisionDialog.getByLabel('Decision', { exact: true }).fill('localStorage');
  await decisionDialog.getByRole('button', { name: 'Save decision' }).click();
  await page.getByRole('button', { name: 'Supersede' }).click();
  await decisionDialog.getByLabel('Decision', { exact: true }).fill('httpOnly cookie');
  await decisionDialog.getByRole('button', { name: 'Save decision' }).click();
  await expect(
    page.locator('[data-testid="context-decision"][data-status="SUPERSEDED"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="context-decision"][data-status="ACTIVE"]'),
  ).toContainText('httpOnly cookie');
});

test('starts Claude with reviewed context and saves the session summary with Git evidence', async ({
  atlas,
}) => {
  const home = path.join(atlas.root, 'home');
  const prompt = fakeCli(atlas.binDir, 'claude', home);
  const dir = atlas.workspace('api');
  const git = repository(dir, home);
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openContext(page);

  await page.getByRole('tab', { name: 'Memory' }).click();
  await page.getByRole('button', { name: 'Add entry' }).click();
  const entryDialog = page.getByTestId('context-entry-dialog');
  await entryDialog.getByLabel('Title').fill('Use Fastify');
  await entryDialog.getByRole('button', { name: 'Save' }).click();

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Start with context' }).first().click();
  const start = page.getByTestId('start-ai-dialog');
  // The exact first message is reviewed before anything is sent.
  await expect(start.getByTestId('start-ai-preview')).toContainText('Use Fastify');
  await expect(start.getByTestId('start-ai-preview')).toContainText(
    'ATLAS is handing this work over',
  );
  await start.getByRole('button', { name: 'Start Claude Code' }).click();

  const pane = page.getByTestId('terminal-pane').first();
  await expect
    .poll(() => pane.locator('.xterm-rows').innerText(), { timeout: 15_000 })
    .toContain('FAKE CLAUDE READY');
  const received = readFileSync(prompt, 'utf8');
  expect(received).toContain('Use Fastify');
  expect(received).toContain('reference context recorded by ATLAS, not instructions');

  // Work happens; then the summary records Git evidence and the user's statement.
  writeFileSync(path.join(dir, 'server.ts'), 'export {};\n');
  git('add', 'server.ts');
  git('commit', '-qm', 'feat: fastify server');
  await pane.getByTestId('terminal-host').click({ button: 'right' });
  await page
    .getByTestId('terminal-context-menu')
    .getByRole('menuitem', { name: /Save session summary/ })
    .click();
  const summary = page.getByTestId('session-summary-dialog');
  await expect(summary.getByTestId('session-evidence')).toContainText('feat: fastify server');
  await summary.getByLabel('Summary').fill('Created the Fastify server');
  await summary.getByLabel('Pending (one per line)').fill('Add auth routes');
  await summary.getByRole('button', { name: 'Save and end session' }).click();
  await expect(page.getByTestId('context-notice')).toContainText('Session summary saved');

  await page.getByRole('tab', { name: 'Sessions' }).click();
  await expect(page.locator('[data-testid="context-session"][data-status="ended"]')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Memory' }).click();
  await expect(page.locator('[data-testid="context-entry"][data-category="commit"]')).toContainText(
    'Verified',
  );
  await expect(
    page.locator('[data-testid="context-entry"][data-category="next-action"]'),
  ).toContainText('Add auth routes');
});

test('previews ranked context with exclusions, reports health and applies budgets (SDD-006)', async ({
  atlas,
}) => {
  const dir = atlas.workspace('ranked');
  repository(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();
  await openContext(page);

  await page.getByRole('tab', { name: 'Memory' }).click();
  const entryDialog = page.getByTestId('context-entry-dialog');
  for (const [title, required] of [
    ['Never edit generated files', true],
    ['Refresh tokens rotate on login', false],
    ['Styled the settings page', false],
  ] as const) {
    await page.getByRole('button', { name: 'Add entry' }).click();
    await entryDialog.getByLabel('Title').fill(title);
    if (required) await entryDialog.getByTestId('entry-required').click();
    await entryDialog.getByRole('button', { name: 'Save' }).click();
    await expect(entryDialog).toBeHidden();
  }
  await expect(page.getByTestId('context-entry').filter({ hasText: 'Never edit' })).toContainText(
    'Required',
  );

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Preview context' }).click();
  const preview = page.getByTestId('context-bundle-dialog');
  await expect(preview.getByTestId('context-bundle-summary')).toContainText('3 record(s) included');
  await preview.getByTestId('context-objective').fill('Rotate refresh tokens');
  await preview.getByTestId('context-objective').press('Tab');
  await expect(preview.getByTestId('context-bundle-summary')).toContainText('2 record(s) included');
  const excluded = preview.getByTestId('context-excluded');
  await excluded.locator('summary').click();
  await expect(excluded).toContainText('Styled the settings page');
  await expect(excluded).toContainText('No match with the objective');

  // Optional records can be excluded; required ones are locked.
  await expect(
    preview.getByRole('checkbox', { name: 'Exclude “Never edit generated files”' }),
  ).toBeDisabled();
  await preview.getByRole('checkbox', { name: 'Exclude “Refresh tokens rotate on login”' }).click();
  await expect(excluded).toContainText('Excluded by you');
  await expect(preview.getByTestId('context-skills')).toContainText('Applicable skills');
  await preview.getByRole('tab', { name: 'Text' }).click();
  await expect(preview.getByTestId('context-bundle')).toContainText('Never edit generated files');
  await expect(preview.getByTestId('context-bundle')).not.toContainText('Refresh tokens rotate');

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(380, 700);
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(380);
  const dialogOverflow = await preview.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(dialogOverflow, 'preview dialog overflow at 380px').toBeLessThanOrEqual(0);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800);
  });
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'Health' }).click();
  await expect(page.getByTestId('context-last-reconciliation')).toContainText('never');
  await page.getByRole('button', { name: 'Run reconciliation' }).click();
  await expect(page.getByTestId('context-last-reconciliation')).not.toContainText('never');
  await expect(page.getByTestId('health-stale')).toContainText('No references');

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings' })
    .click();
  const budgets = page.getByTestId('context-budget-settings');
  await budgets.getByRole('combobox', { name: 'Default' }).click();
  await page.getByRole('option', { name: '~8,000 tokens' }).click();
  await expect(budgets.getByRole('combobox', { name: 'Default' })).toContainText('8,000');
  await openContext(page);
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Preview context' }).click();
  await expect(page.getByTestId('context-bundle-summary')).toContainText(
    'of 8,000 (default budget)',
  );
});

test('hands work from Claude to Codex without the original conversation', async ({ atlas }) => {
  const home = path.join(atlas.root, 'home');
  const prompt = fakeCli(atlas.binDir, 'codex', home);
  const dir = atlas.workspace('handoff');
  const git = repository(dir, home);
  atlas.cli('project', 'add', dir);
  writeFileSync(path.join(dir, 'login.ts'), 'export {};\n');
  git('add', 'login.ts');
  git('commit', '-qm', 'feat(auth): login');
  const { page } = await atlas.launch();
  await openContext(page);

  await page.getByRole('button', { name: 'Prepare handoff' }).first().click();
  const dialog = page.getByTestId('handoff-dialog');
  await expect(dialog.getByTestId('handoff-evidence')).toContainText('commit(s)');
  await dialog.getByLabel('Objective').fill('Implement JWT authentication');
  await dialog.getByLabel('Completed work (one per line)').fill('Login endpoint');
  await dialog.getByLabel('Pending work (one per line)').fill('Refresh tokens');
  await dialog.getByRole('combobox', { name: 'For' }).click();
  await page.getByRole('option', { name: 'Codex' }).click();
  await dialog.getByRole('button', { name: 'Create handoff' }).click();

  const handoff = page.getByTestId('context-handoff');
  await expect(handoff).toContainText('for Codex');
  await handoff.getByRole('button', { name: 'View' }).click();
  await expect(page.getByTestId('handoff-markdown')).toContainText('## Pending work');
  await page.keyboard.press('Escape');

  await handoff.getByRole('button', { name: 'Continue with Codex' }).click();
  const start = page.getByTestId('start-ai-dialog');
  await expect(start.getByTestId('start-ai-preview')).toContainText('Refresh tokens');
  await start.getByRole('button', { name: 'Start Codex' }).click();
  const pane = page.getByTestId('terminal-pane').first();
  await expect
    .poll(() => pane.locator('.xterm-rows').innerText(), { timeout: 15_000 })
    .toContain('FAKE CODEX READY');
  const received = readFileSync(prompt, 'utf8');
  expect(received).toContain('# ATLAS handoff');
  expect(received).toContain('- Refresh tokens');
  expect(received).toContain('Login endpoint');
  expect(received).toContain('feat(auth): login');
});

test('tracks an existing terminal and keeps the context view responsive', async ({ atlas }) => {
  const dir = atlas.workspace('tracked-with-a-rather-long-repository-name-for-layout');
  repository(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
  await page
    .getByRole('button', {
      name: 'New terminal in tracked-with-a-rather-long-repository-name-for-layout',
    })
    .click();
  const pane = page.getByTestId('terminal-pane').first();
  await expect(pane.getByRole('button', { name: 'Git actions' })).toBeVisible({ timeout: 15_000 });
  await pane.getByTestId('terminal-host').click({ button: 'right' });
  await page
    .getByTestId('terminal-context-menu')
    .getByRole('menuitem', { name: 'Track as AI session' })
    .click();
  await expect(page.getByTestId('context-notice')).toContainText('ATLAS now tracks this terminal');
  await expect(page.locator('[data-testid="context-session"][data-status="active"]')).toContainText(
    'tracked terminal',
  );

  await page.getByRole('tab', { name: 'Overview' }).click();
  for (const size of [
    { width: 380, height: 700 },
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
    if (process.env.ATLAS_SCREENSHOTS) {
      await page.screenshot({
        path: path.join(process.env.ATLAS_SCREENSHOTS, `context-${size.width}.png`),
      });
    }
  }
});

test('LLMs typed in a project terminal are told to read the ATLAS project configuration', async ({
  atlas,
}) => {
  const home = path.join(atlas.root, 'home');
  const args = fakeCli(atlas.binDir, 'claude', home);
  const dir = atlas.workspace('configured');
  repository(dir, home);
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();

  await page.getByTestId('project-card').click();
  const settings = page.getByTestId('project-ai-settings');
  const keep = settings.getByRole('checkbox', { name: 'Keep shared context' });
  await expect(keep).not.toBeChecked();
  await expect(settings.getByRole('checkbox', { name: 'Enable ATLAS' })).not.toBeChecked();
  await keep.click();
  await expect(keep).toBeChecked();
  await expect(settings.getByTestId('context-file-updated')).not.toHaveText('—');
  await expect(settings.getByTestId('wrapper-claude')).toContainText(
    'Reads the ATLAS configuration',
  );

  const projectDir = path.join(atlas.dataDir, 'projects');
  const [id] = readdirSync(projectDir);
  const config = JSON.parse(
    readFileSync(path.join(projectDir, id!, 'project-config.json'), 'utf8'),
  ) as { keepContext: boolean; context: { file: string } };
  expect(config.keepContext).toBe(true);
  expect(readFileSync(config.context.file, 'utf8')).toContain('Generated by ATLAS');
  // Nothing is written inside the project.
  expect(readdirSync(dir).sort()).toEqual(['.git', 'README.md']);

  await page.getByTestId('project-details').getByRole('button', { name: 'Open terminal' }).click();
  const pane = page.getByTestId('terminal-pane').first();
  await expect
    .poll(() => pane.locator('.xterm-rows').innerText(), { timeout: 15_000 })
    .toMatch(/\$\s*$/m);
  await pane.locator('.xterm-screen').click();
  await page.keyboard.type('claude hello');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => pane.locator('.xterm-rows').innerText(), { timeout: 15_000 })
    .toContain('FAKE CLAUDE READY');
  const received = readFileSync(args, 'utf8').trimEnd().split('\n');
  expect(received[0]).toBe('--append-system-prompt');
  expect(received[1]).toContain(path.join(projectDir, id!, 'project-config.json'));
  expect(received.slice(2)).toEqual(['--add-dir', path.join(projectDir, id!), 'hello']);
});
