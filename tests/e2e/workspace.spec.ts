import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import type { TerminalSession } from '@atlas/contracts';
import { expect, test, openProjectTerminal } from './fixtures';

// SDD-003 Milestone A: standalone terminals, names, groups, Git and version.
// Repositories are created in temporary directories with a temporary HOME.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopVersion = (
  JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8')) as {
    version: string;
  }
).version;
const engineVersion = (
  JSON.parse(readFileSync(path.join(root, 'apps/engine/package.json'), 'utf8')) as {
    version: string;
  }
).version;

const panes = (page: Page) => page.getByTestId('terminal-pane');
const tabs = (page: Page) => page.getByTestId('terminal-tab');
const screenText = (pane: Locator) => pane.locator('.xterm-rows').innerText();
/** Screen text without line breaks: long paths wrap across rows (e.g. after a long prompt). */
const unwrappedText = async (pane: Locator) => (await screenText(pane)).replace(/\n/g, '');

async function openTerminals(page: Page, workspace = 'Ungrouped') {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
  await page.getByTestId('workspace-button').filter({ hasText: workspace }).click();
}

async function run(page: Page, pane: Locator, command: string) {
  await expect.poll(() => screenText(pane), { timeout: 15_000 }).toMatch(/\$\s*$/m);
  await pane.locator('.xterm-screen').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

function terminalList(cli: (...args: string[]) => string): TerminalSession[] {
  return JSON.parse(cli('terminal', 'list', '--json')) as TerminalSession[];
}

function sidebarTerminal(page: Page, name: string) {
  return page.getByTestId('sidebar-terminal').filter({ hasText: name });
}

async function terminalAction(page: Page, name: string, ...path: string[]) {
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  const menu = page.getByTestId('terminal-actions');
  for (const [index, label] of path.entries()) {
    const item = (index === 0 ? menu : page).getByRole('menuitem', { name: label, exact: true });
    if (index < path.length - 1) await item.hover();
    else await item.click();
  }
}

/** A Git repository with a commit, a local upstream one commit behind, and a modified file. */
function gitRepository(dir: string, home: string) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Ana Dev');
  git('config', 'user.email', 'ana@example.com');
  git('add', '.');
  git('commit', '-qm', 'init');
  const remote = path.join(path.dirname(dir), `${path.basename(dir)}-remote.git`);
  git('clone', '-q', '--bare', dir, remote);
  git('remote', 'add', 'origin', remote);
  git('fetch', '-q', 'origin');
  git('branch', '-q', '-u', 'origin/main');
  git('checkout', '-q', '-b', 'feature/auth');
  git('checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'auth.ts'), 'export {};\n');
  git('add', 'auth.ts');
  git('commit', '-qm', 'auth');
  writeFileSync(path.join(dir, 'README.md'), '# changed\n');
}

test('opens standalone terminals and keeps custom names', async ({ atlas }) => {
  const { app, page } = await atlas.launch();
  await openTerminals(page);
  await page.getByRole('button', { name: 'New terminal', exact: true }).first().click();
  await expect(tabs(page)).toHaveCount(1);
  const pane = panes(page).first();

  // Default working directory: the (temporary) home directory.
  await expect(tabs(page).first()).toContainText('~');
  await run(page, pane, 'pwd');
  await expect.poll(() => unwrappedText(pane)).toContain(path.join(atlas.root, 'home'));
  expect(terminalList(atlas.cli)[0]).toMatchObject({ projectId: null });

  // The automatic name follows the shell's directory.
  await run(page, pane, 'mkdir -p scratch && cd scratch');
  await expect(tabs(page).first()).toContainText('scratch', { timeout: 10_000 });

  // A custom name survives directory changes and can be restored.
  await terminalAction(page, 'scratch', 'Rename…');
  await page.getByTestId('name-dialog').getByLabel('Name').fill('Docker Services');
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(tabs(page).first()).toContainText('Docker Services');
  await run(page, pane, 'cd ..');
  await page.waitForTimeout(1500);
  await expect(sidebarTerminal(page, 'Docker Services')).toBeVisible();
  expect(terminalList(atlas.cli)[0]).toMatchObject({
    customTitle: 'Docker Services',
    autoTitle: '~',
  });

  await terminalAction(page, 'Docker Services', 'Restore automatic name');
  await expect(tabs(page).first()).toContainText('~');

  // Open in a folder chosen in the native picker.
  const folder = atlas.workspace('tools');
  await atlas.stubDirectoryPicker(app, folder);
  await page.getByRole('button', { name: 'More ways to open a terminal' }).click();
  await page.getByRole('menuitem', { name: 'Open in folder…' }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(1)).toContainText('tools');
});

test('groups terminals from several projects without restarting them', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('nova'));
  atlas.cli('project', 'add', atlas.workspace('wii'));
  const first = await atlas.launch();
  let page = first.page;
  await openTerminals(page);

  for (const name of ['Desenvolvimento', 'Pessoal']) {
    await page.getByRole('button', { name: 'New group' }).click();
    await page.getByTestId('name-dialog').getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create group' }).click();
  }
  await openTerminals(page, 'Desenvolvimento');
  await openProjectTerminal(page, 'nova');
  await openProjectTerminal(page, 'wii');
  await expect(tabs(page)).toHaveCount(2);
  const group = page.getByTestId('terminal-group').filter({ hasText: 'Desenvolvimento' });
  await expect(group.getByTestId('sidebar-terminal')).toHaveCount(2);

  const before = terminalList(atlas.cli);
  expect(new Set(before.map((s) => s.projectId)).size).toBe(2);

  // Move "wii" to another group through its menu.
  await terminalAction(page, 'wii', 'Move to group', 'Pessoal');
  await expect(
    page
      .getByTestId('terminal-group')
      .filter({ hasText: 'Pessoal' })
      .getByTestId('sidebar-terminal'),
  ).toHaveCount(1);
  await expect(tabs(page)).toHaveCount(1);
  const after = terminalList(atlas.cli);
  expect(after.map((s) => [s.id, s.pid, s.status])).toEqual(
    before.map((s) => [s.id, s.pid, 'RUNNING']),
  );

  // Collapse and reorder groups; the state survives a restart.
  await page.getByRole('button', { name: 'Collapse Pessoal' }).click();
  await expect(page.getByRole('button', { name: 'Expand Pessoal' })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for group Pessoal' }).click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await expect(page.getByTestId('terminal-group').first()).toContainText('Pessoal');

  await first.app.close();
  page = (await atlas.launch()).page;
  await openTerminals(page);
  await expect(page.getByTestId('terminal-group').first()).toContainText('Pessoal');
  await expect(page.getByRole('button', { name: 'Expand Pessoal' })).toBeVisible();

  // Deleting a group keeps its terminals (now ungrouped).
  await page.getByRole('button', { name: 'Actions for group Desenvolvimento' }).click();
  await page.getByRole('menuitem', { name: 'Delete group…' }).click();
  await page
    .getByTestId('delete-group-dialog')
    .getByRole('button', { name: 'Delete group' })
    .click();
  await expect(
    page.getByTestId('terminal-group').filter({ hasText: 'Desenvolvimento' }),
  ).toHaveCount(0);
  await expect(
    page.getByTestId('terminal-group-ungrouped').getByTestId('sidebar-terminal'),
  ).toHaveCount(1);
});

test('shows Git details for projects and terminals, and plain folders without Git', async ({
  atlas,
}) => {
  const nova = atlas.workspace('nova');
  gitRepository(nova, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', nova);
  atlas.cli('project', 'add', atlas.workspace('plain'));
  const { page } = await atlas.launch();

  await page.getByTestId('project-card').filter({ hasText: 'nova' }).click();
  const details = page.getByTestId('git-details');
  await expect(details.getByTestId('git-identity')).toContainText('Ana Dev · ana@example.com');
  await expect(details.getByTestId('git-current-branch')).toHaveText('main');
  await expect(details.getByTestId('git-branch-count')).toHaveText('2');
  await expect(details.getByTestId('git-recent-branches')).toContainText('main');
  await expect(details.getByTestId('git-recent-branches')).toContainText('feature/auth');
  await expect(details.getByTestId('git-changes')).toContainText('Modified: 1');
  await expect(details.getByTestId('git-tracking')).toContainText('↑ 1 ahead · ↓ 0 behind');
  await expect(details.getByTestId('git-tracking')).toContainText('as of the last fetch');

  await page.getByTestId('project-card').filter({ hasText: 'plain' }).click();
  await expect(page.getByTestId('git-none')).toContainText('No Git repository');

  // Branding: logo and short name in the sidebar, full name in the window title.
  await expect(page.getByTestId('atlas-logo')).toBeVisible();
  await expect(page).toHaveTitle('A.T.L.A.S — Autonomous Task Leadership & Agent System');

  // Sidebar projects: commits to push/pull; nothing for plain folders.
  await openTerminals(page);
  const novaSync = page
    .getByTestId('sidebar-project')
    .filter({ hasText: 'nova' })
    .getByTestId('sidebar-project-sync');
  await expect(novaSync.getByTestId('git-ahead')).toContainText('1');
  await expect(novaSync.getByTestId('git-behind')).toContainText('0');
  await expect(
    page
      .getByTestId('sidebar-project')
      .filter({ hasText: 'plain' })
      .getByTestId('sidebar-project-sync'),
  ).toHaveCount(0);

  // Terminal header: branch, modified count, ahead/behind; nothing for plain folders.
  await openProjectTerminal(page, 'nova');
  const header = panes(page).first();
  await expect(header.getByTestId('git-branch')).toContainText('main', { timeout: 10_000 });
  await expect(header.getByTestId('git-modified')).toHaveText('M:1');
  await expect(header.getByTestId('git-ahead')).toContainText('1');
  await expect(header.getByTestId('git-behind')).toContainText('0');

  // Changes made in the terminal are reflected after the command settles.
  await run(page, header, 'echo more >> auth.ts');
  await expect(header.getByTestId('git-modified')).toHaveText('M:2', { timeout: 10_000 });
  await run(page, header, 'echo more >> README.md && git add README.md');
  await expect(header.getByTestId('git-staged')).toHaveText('S:1', { timeout: 10_000 });

  await openProjectTerminal(page, 'plain');
  await expect(panes(page).first()).toHaveAttribute('data-active', 'true');
  await expect(panes(page).first().getByTestId('git-badges')).toHaveCount(0);
});

test('opens project details from a terminal and registers a standalone directory', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('nova'));
  const { app, page } = await atlas.launch();
  await openTerminals(page);
  await openProjectTerminal(page, 'nova');
  await panes(page).first().getByRole('button', { name: 'Project details' }).click();
  const sheet = page.getByTestId('project-sheet');
  await expect(sheet.getByTestId('project-details')).toContainText('nova');
  await page.keyboard.press('Escape');
  // The terminal kept running.
  expect(terminalList(atlas.cli)[0]?.status).toBe('RUNNING');

  const folder = atlas.workspace('scripts');
  await atlas.stubDirectoryPicker(app, folder);
  await page.getByRole('button', { name: 'More ways to open a terminal' }).click();
  await page.getByRole('menuitem', { name: 'Open in folder…' }).click();
  await expect(tabs(page)).toHaveCount(2);
  await panes(page).first().getByRole('button', { name: 'Project details' }).click();
  await sheet
    .getByTestId('register-directory')
    .getByLabel(/Register this directory/)
    .fill('Scripts');
  await sheet.getByRole('button', { name: 'Register project' }).click();
  await expect(sheet.getByTestId('project-details')).toContainText('Scripts');
  const registered = terminalList(atlas.cli).find((s) => s.cwd === folder);
  expect(registered?.projectId).not.toBeNull();
  expect(atlas.cli('project', 'list')).toContain('Scripts');
});

test('shows the real application and Engine versions', async ({ atlas }) => {
  const { app, page } = await atlas.launch();
  await expect(page.getByTestId('sidebar-version')).toContainText(`v${desktopVersion}-dev`);
  // The application is presented as A.T.L.A.S (PLAN-025), also when run from source.
  await expect(page.getByTestId('sidebar-version')).toContainText('A.T.L.A.S');
  await expect(page.getByLabel('A.T.L.A.S', { exact: true })).toBeVisible();
  expect(await app.evaluate(({ app: electronApp }) => electronApp.getName())).toBe('A.T.L.A.S');
  const appMenu = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.items.flatMap((item) => [
      item.label,
      ...(item.submenu?.items.map((sub) => sub.label) ?? []),
    ]),
  );
  expect(appMenu).toContain('About A.T.L.A.S');

  await atlas.menu(app, 'app.about');
  const about = page.getByTestId('about-dialog');
  await expect(about.getByRole('heading', { name: 'About A.T.L.A.S' })).toBeVisible();
  await expect(about.getByTestId('app-info-desktop-version')).toHaveText(desktopVersion);
  await expect(about.getByTestId('app-info-engine-version')).toHaveText(engineVersion);
  await expect(about.getByTestId('app-info-channel')).toHaveText('Development');
  await page.keyboard.press('Escape');

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await expect(page.getByTestId('app-info-data-directory')).toHaveText(atlas.dataDir);
  await expect(page.getByTestId('app-info-database-schema')).toHaveText('13');
});
