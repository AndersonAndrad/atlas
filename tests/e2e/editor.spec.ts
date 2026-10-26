import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, openProjectTerminal, test } from './fixtures';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

function initRepository(dir: string, home: string) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const answer = 41;\n');
  writeFileSync(path.join(dir, 'src', 'util.ts'), 'export const util = true;\n');
  writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), '');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Ana Dev');
  git('config', 'user.email', 'ana@example.com');
  git('add', '.');
  git('commit', '-qm', 'chore: init');
  return git;
}

async function openEditor(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Editor' })
    .click();
  await expect(page.getByTestId('editor-view')).toBeVisible();
  await expect(page.getByTestId('file-tree')).toBeVisible();
}

const row = (page: Page, name: string) =>
  page.getByTestId('file-tree').getByRole('treeitem', { name, exact: true });

async function openFile(page: Page, ...segments: string[]) {
  for (const folder of segments.slice(0, -1)) {
    const item = row(page, folder);
    if ((await item.getAttribute('aria-expanded')) !== 'true') await item.click();
  }
  await row(page, segments.at(-1)!).click();
  await expect(page.locator('.monaco-editor .view-lines')).toBeVisible();
}

/** Text of the visible editor lines (Monaco renders non-breaking spaces). */
const editorText = (page: Page) =>
  page
    .locator('.monaco-editor .view-lines')
    .innerText()
    .then((text) => text.replace(/\u00a0/g, ' '));

async function typeAtEnd(page: Page, text: string) {
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type(text);
}

async function stubTrash(app: ElectronApplication) {
  // Never touch the real Trash: the stub removes the file and records the call.
  await app.evaluate(({ shell }) => {
    const calls: string[] = [];
    (globalThis as { trashed?: string[] }).trashed = calls;
    shell.trashItem = (async (target: string) => {
      calls.push(target);
      const fs = process.getBuiltinModule('node:fs');
      fs.rmSync(target, { recursive: true, force: true });
    }) as typeof shell.trashItem;
  });
}

test('edits, saves and shows the change in Git without any AI (Scenario A)', async ({ atlas }) => {
  const dir = atlas.workspace('shop');
  const git = initRepository(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openEditor(page);

  // node_modules is ignored by the repository: hidden until asked for.
  await expect(row(page, 'node_modules')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show ignored files' }).click();
  await expect(row(page, 'node_modules')).toBeVisible();
  await page.getByRole('button', { name: 'Hide ignored files' }).click();
  await expect(row(page, 'node_modules')).toHaveCount(0);

  await openFile(page, 'src', 'app.ts');
  await expect.poll(() => editorText(page)).toContain('export const answer = 41;');
  await typeAtEnd(page, 'export const next = 42;');
  const tab = page.getByTestId('editor-tab').filter({ hasText: 'app.ts' });
  await expect(tab).toHaveAttribute('data-dirty', 'true');
  await page.keyboard.press(`${mod}+S`);
  await expect(tab).toHaveAttribute('data-dirty', 'false');
  expect(readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe(
    'export const answer = 41;\nexport const next = 42;',
  );
  expect(git('status', '--porcelain')).toContain(' M src/app.ts');

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Git', exact: true })
    .click();
  await expect(page.getByTestId('git-changes')).toContainText('app.ts');
});

test('reloads files changed outside and never overwrites unsaved edits (Scenario B)', async ({
  atlas,
}) => {
  const dir = atlas.workspace('agent');
  initRepository(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openEditor(page);
  await openFile(page, 'src', 'app.ts');
  const file = path.join(dir, 'src', 'app.ts');

  // An agent rewrites the file while the tab has no edits: it reloads by itself.
  writeFileSync(file, 'export const answer = 42; // by Claude\n');
  await expect.poll(() => editorText(page), { timeout: 10_000 }).toContain('by Claude');
  await expect(page.getByTestId('editor-banner')).toContainText('Reloaded');

  // With unsaved edits, a new external change is a conflict.
  await typeAtEnd(page, '// mine');
  writeFileSync(file, 'export const answer = 43; // by Codex\n');
  const banner = page.getByTestId('editor-banner');
  await expect(banner).toContainText('changed on disk', { timeout: 10_000 });
  await expect(banner).toContainText('Your edits are not saved');
  expect(await editorText(page)).toContain('// mine');
  // Saving does not overwrite the agent's version.
  await page.keyboard.press(`${mod}+S`);
  await expect(banner).toContainText('changed on disk');
  expect(readFileSync(file, 'utf8')).toBe('export const answer = 43; // by Codex\n');

  await banner.getByRole('button', { name: 'Reload (discard my edits)' }).click();
  await expect.poll(() => editorText(page)).toContain('by Codex');
  await expect(page.getByTestId('editor-tab').first()).toHaveAttribute('data-dirty', 'false');

  // "Save my version" replaces the file only on request.
  await typeAtEnd(page, '// mine again');
  writeFileSync(file, 'export const answer = 44;\n');
  await expect(banner).toContainText('Your edits are not saved', { timeout: 10_000 });
  await banner.getByRole('button', { name: 'Save my version' }).click();
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('// mine again');
});

test('asks before closing a tab with unsaved changes', async ({ atlas }) => {
  const dir = atlas.workspace('unsaved');
  initRepository(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openEditor(page);
  await openFile(page, 'src', 'util.ts');
  await typeAtEnd(page, '// draft');

  await page.keyboard.press(`${mod}+W`);
  const dialog = page.getByTestId('unsaved-dialog');
  await expect(dialog).toContainText('Save changes to util.ts?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('editor-tab')).toHaveCount(1);

  await page.keyboard.press(`${mod}+W`);
  await page.getByTestId('unsaved-dialog').getByRole('button', { name: "Don't save" }).click();
  await expect(page.getByTestId('editor-tab')).toHaveCount(0);
  expect(readFileSync(path.join(dir, 'src', 'util.ts'), 'utf8')).toBe(
    'export const util = true;\n',
  );
});

test('creates, renames, saves as and moves files to the Trash', async ({ atlas }) => {
  const dir = atlas.workspace('ops');
  initRepository(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();
  await stubTrash(app);
  await openEditor(page);

  await page.getByTestId('file-explorer').getByRole('button', { name: 'New file' }).click();
  const nameDialog = page.getByTestId('name-dialog');
  await nameDialog.getByLabel('Name').fill('notes.md');
  await nameDialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('editor-tab').filter({ hasText: 'notes.md' })).toBeVisible();
  expect(existsSync(path.join(dir, 'notes.md'))).toBe(true);
  // An existing name is never overwritten.
  await page.getByTestId('file-explorer').getByRole('button', { name: 'New file' }).click();
  await nameDialog.getByLabel('Name').fill('README.md');
  await nameDialog.getByRole('button', { name: 'Create' }).click();
  await expect(nameDialog).toContainText('already exists');
  await nameDialog.getByRole('button', { name: 'Cancel' }).click();

  // Save As to an existing file asks before replacing it.
  await typeAtEnd(page, '# Notes');
  await page.keyboard.press(`${mod}+Shift+S`);
  await nameDialog.getByLabel('Path').fill('README.md');
  await nameDialog.getByRole('button', { name: 'Save' }).click();
  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toContainText('Replace README.md?');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# ops\n');
  await page.keyboard.press(`${mod}+Shift+S`);
  await nameDialog.getByLabel('Path').fill('docs-notes.md');
  await nameDialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('editor-tab').filter({ hasText: 'docs-notes.md' })).toBeVisible();
  expect(readFileSync(path.join(dir, 'docs-notes.md'), 'utf8')).toBe('# Notes');

  await row(page, 'src').click();
  await row(page, 'util.ts').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await nameDialog.getByLabel('Name').fill('helpers.ts');
  await nameDialog.getByRole('button', { name: 'Rename' }).click();
  await expect(row(page, 'helpers.ts')).toBeVisible();
  expect(existsSync(path.join(dir, 'src', 'helpers.ts'))).toBe(true);

  await row(page, 'helpers.ts').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Trash…' }).click();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Move to Trash' }).click();
  await expect(row(page, 'helpers.ts')).toHaveCount(0);
  const trashed = await app.evaluate(() => (globalThis as { trashed?: string[] }).trashed);
  expect(trashed).toEqual([path.join(dir, 'src', 'helpers.ts')]);
});

test('restores open files and layout after a restart, skipping deleted files', async ({
  atlas,
}) => {
  const dir = atlas.workspace('restore');
  initRepository(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const first = await atlas.launch();
  let page = first.page;
  await openEditor(page);
  await openFile(page, 'src', 'util.ts');
  await openFile(page, 'src', 'app.ts');
  await page.getByRole('button', { name: 'Show terminal' }).click();
  await expect(page.getByTestId('editor-terminal')).toBeVisible();
  // The layout is saved shortly after it changes.
  await page.waitForTimeout(1200);
  await first.app.close();
  rmSync(path.join(dir, 'src', 'util.ts'));

  page = (await atlas.launch()).page;
  await openEditor(page);
  await expect(page.getByTestId('editor-tab')).toHaveCount(1);
  await expect(page.getByTestId('editor-tab').first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('editor-tab').first()).toContainText('app.ts');
  await expect.poll(() => editorText(page)).toContain('export const answer = 41;');
  await expect(page.getByTestId('editor-terminal')).toBeVisible();
  await expect(row(page, 'app.ts')).toBeVisible();
});

test('terminal-only use never loads the editor (Scenario D)', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('shell-only'));
  const { page } = await atlas.launch();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
  await openProjectTerminal(page, 'shell-only');
  const pane = page.getByTestId('terminal-pane');
  await expect
    .poll(() => pane.locator('.xterm-rows').innerText(), { timeout: 15_000 })
    .toMatch(/\$\s*$/m);
  await pane.locator('.xterm-screen').click();
  await page.keyboard.type('echo editor-$((40+2))');
  await page.keyboard.press('Enter');
  await expect(pane.locator('.xterm-rows')).toContainText('editor-42');
  expect(
    await page.evaluate(() => ({
      monaco: (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment !== undefined,
      editors: document.querySelectorAll('.monaco-editor').length,
    })),
  ).toEqual({ monaco: false, editors: 0 });
});

test('the editor and its terminal panel coexist', async ({ atlas }) => {
  const dir = atlas.workspace('both');
  initRepository(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();
  const menuEnabled = () =>
    app.evaluate(({ Menu }) =>
      ['terminal.close', 'terminal.search', 'terminal.splitRight', 'terminal.new'].map(
        (id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.enabled,
      ),
    );
  expect(await menuEnabled()).toEqual([true, true, true, true]);
  await openEditor(page);
  // Cmd+W, Cmd+F and Cmd+D go to the editor while it is shown (PLAN-033 R1).
  await expect.poll(menuEnabled).toEqual([false, false, false, true]);
  await openFile(page, 'src', 'app.ts');
  await page.keyboard.press('Control+Backquote');
  const panel = page.getByTestId('editor-terminal');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Open a terminal' }).click();
  const pane = panel.getByTestId('terminal-pane');
  await expect
    .poll(() => pane.locator('.xterm-rows').innerText(), { timeout: 15_000 })
    .toMatch(/\$\s*$/m);
  await pane.locator('.xterm-screen').click();
  await page.keyboard.type("printf 'export const fromShell = 1;\\n' > src/app.ts");
  await page.keyboard.press('Enter');
  // A command in the terminal rewrites the open file: the unmodified tab follows.
  await expect.poll(() => editorText(page), { timeout: 10_000 }).toContain('fromShell');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Terminals' })
    .click();
  await expect.poll(menuEnabled).toEqual([true, true, true, true]);
});

test('the editor fits narrow and wide windows', async ({ atlas }) => {
  const dir = atlas.workspace('a-project-with-a-rather-long-directory-name-for-the-editor');
  initRepository(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { app, page } = await atlas.launch();
  await openEditor(page);
  await openFile(page, 'src', 'app.ts');
  for (const width of [380, 760, 1000, 1440]) {
    await app.evaluate(({ BrowserWindow }, w) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(w, 800);
    }, width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('code-editor')).toBeVisible();
  }
  // Narrow windows show the explorer over the editor.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(380, 800);
  });
  await expect(page.getByTestId('file-explorer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show explorer' }).click();
  await expect(page.getByTestId('file-explorer')).toBeVisible();
  await row(page, 'README.md').click();
  await expect(page.getByTestId('file-explorer')).toHaveCount(0);
  await expect(page.getByTestId('editor-tab').filter({ hasText: 'README.md' })).toBeVisible();
});

test('keeps unsaved changes visible when their project is removed', async ({ atlas }) => {
  const dir = atlas.workspace('removed');
  initRepository(dir, path.join(atlas.root, 'home'));
  atlas.cli('project', 'add', dir);
  const { page } = await atlas.launch();
  await openEditor(page);
  await openFile(page, 'src', 'app.ts');
  await typeAtEnd(page, '// keep me');
  await expect(page.getByTestId('editor-tab').first()).toHaveAttribute('data-dirty', 'true');

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Projects' })
    .click();
  await page.getByTestId('project-card').click();
  await page.getByTestId('project-details').getByRole('button', { name: 'Remove' }).click();
  await page
    .getByTestId('remove-dialog')
    .getByRole('button', { name: 'Remove from registry' })
    .click();
  await expect(page.getByTestId('project-card')).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Editor' })
    .click();
  await expect(page.getByTestId('editor-project-removed')).toBeVisible();
  await expect.poll(() => editorText(page)).toContain('// keep me');
});
