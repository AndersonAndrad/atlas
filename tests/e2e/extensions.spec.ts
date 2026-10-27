import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { fixtureManifest, startFakeRegistry, type FakeRegistry } from '../support/vsix';
import { expect, test, type AtlasHarness } from './fixtures';

// SDD-015 Milestone A with a local stand-in for Open VSX started by the test: nothing
// reaches the internet and no extension code runs.

let registry: FakeRegistry;

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>';

test.beforeAll(async () => {
  registry = await startFakeRegistry();
  registry.add({
    namespace: 'acme',
    name: 'night-theme',
    version: '1.0.0',
    displayName: 'Acme Night',
    description: 'A dark color theme',
    categories: ['Themes'],
    manifest: fixtureManifest('acme', 'night-theme', '1.0.0', {
      displayName: 'Acme Night',
      contributes: {
        themes: [
          { id: 'acme-night', label: 'Acme Night', uiTheme: 'vs-dark', path: './night.json' },
        ],
      },
    }),
    files: {
      'night.json': JSON.stringify({
        colors: { 'editor.background': '#102030' },
        tokenColors: [{ scope: 'comment', settings: { foreground: '#ff8800' } }],
      }),
    },
  });
  registry.add({
    namespace: 'acme',
    name: 'lang-acme',
    version: '0.3.0',
    displayName: 'Acme Language',
    description: 'Acme syntax highlighting and snippets',
    categories: ['Programming Languages'],
    manifest: fixtureManifest('acme', 'lang-acme', '0.3.0', {
      displayName: 'Acme Language',
      contributes: {
        languages: [{ id: 'acme', aliases: ['Acme'], extensions: ['.acme'] }],
        grammars: [{ language: 'acme', scopeName: 'source.acme', path: './acme.tmLanguage.json' }],
        snippets: [{ language: 'acme', path: './snippets.json' }],
      },
    }),
    files: {
      'acme.tmLanguage.json': JSON.stringify({
        scopeName: 'source.acme',
        patterns: [
          { match: '#.*$', name: 'comment.line.acme' },
          { match: '\\b(task|run)\\b', name: 'keyword.control.acme' },
        ],
      }),
      'snippets.json': JSON.stringify({
        Greeting: { prefix: 'greet', body: 'greet ${1:world}$0', description: 'Say hello' },
      }),
    },
  });
  registry.add({
    namespace: 'acme',
    name: 'icons',
    version: '2.0.0',
    displayName: 'Acme Icons',
    description: 'File icons',
    categories: ['Themes'],
    manifest: fixtureManifest('acme', 'icons', '2.0.0', {
      displayName: 'Acme Icons',
      contributes: {
        iconThemes: [{ id: 'acme-icons', label: 'Acme Icons', path: './icons.json' }],
      },
    }),
    files: {
      'icons.json': JSON.stringify({
        iconDefinitions: { file: { iconPath: './file.svg' } },
        file: 'file',
      }),
      'file.svg': SVG,
    },
  });
  registry.add({
    namespace: 'acme',
    name: 'runner',
    version: '1.0.0',
    displayName: 'Acme Runner',
    description: 'Runs tasks from a command',
    categories: ['Other'],
    manifest: fixtureManifest('acme', 'runner', '1.0.0', {
      displayName: 'Acme Runner',
      main: './extension.js',
      contributes: { commands: [{ command: 'acme.run', title: 'Run' }] },
    }),
    files: { 'extension.js': 'throw new Error("never runs")' },
  });
});

test.afterAll(async () => {
  await registry.close();
});

test.beforeEach(() => {
  registry.down = false;
});

const launch = (atlas: AtlasHarness) =>
  atlas.launch({ env: { ATLAS_EXTENSIONS_REGISTRY_URL: registry.url } });

const navigate = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true })
    .click();

async function openHub(page: Page) {
  await navigate(page, 'Extensions');
  await expect(page.getByTestId('extensions-view')).toBeVisible();
}

async function select(page: Page, query: string, title: string) {
  await page.getByLabel('Search extensions').fill(query);
  await page.getByTestId('extension-item').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('extension-title')).toHaveText(title);
}

async function install(page: Page, query: string, title: string) {
  await select(page, query, title);
  await page.getByTestId('extension-install').click();
  await expect(page.getByTestId('extension-uninstall')).toBeVisible();
}

function project(atlas: AtlasHarness, name: string, files: Record<string, string>) {
  const dir = atlas.workspace(name);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  atlas.cli('project', 'add', dir);
  return dir;
}

async function openFile(page: Page, name: string) {
  await navigate(page, 'Editor');
  await expect(page.getByTestId('file-tree')).toBeVisible();
  await page.getByTestId('file-tree').getByRole('treeitem', { name, exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toBeVisible();
}

const editorBackground = (page: Page) =>
  page
    .locator('.monaco-editor .monaco-editor-background')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);

const tokenColor = (page: Page, text: string) =>
  page
    .locator('.monaco-editor .view-line span span', { hasText: text })
    .first()
    .evaluate((element) => getComputedStyle(element).color);

test('installs a theme, applies it to the editor and keeps it after a restart (Scenario A)', async ({
  atlas,
}) => {
  project(atlas, 'web', { 'notes.txt': 'hello\n' });
  const first = await launch(atlas);
  let page = first.page;
  await openHub(page);
  await select(page, 'night', 'Acme Night');
  const report = page.getByTestId('compatibility-report');
  await expect(report.getByTestId('compatibility-badge')).toHaveText('Untested');
  await expect(report.getByTestId('compat-working')).toContainText('Color theme: Acme Night');
  await page.getByTestId('extension-install').click();
  await expect(page.getByTestId('extension-active')).toContainText('Active');
  // Installing never switches the theme by itself.
  await page.getByRole('button', { name: 'Use', exact: true }).click();
  await expect(page.getByText('In use')).toBeVisible();

  await install(page, 'icons', 'Acme Icons');
  await page.getByRole('button', { name: 'Use', exact: true }).click();

  await openFile(page, 'notes.txt');
  await expect.poll(() => editorBackground(page)).toBe('rgb(16, 32, 48)');
  await expect(
    page.getByTestId('file-tree').locator('img[src^="data:image/svg+xml"]').first(),
  ).toBeVisible();

  await first.app.close();
  page = (await launch(atlas)).page;
  await openFile(page, 'notes.txt');
  await expect.poll(() => editorBackground(page)).toBe('rgb(16, 32, 48)');
  await openHub(page);
  await page.getByRole('tab', { name: /^Installed/ }).click();
  await expect(page.getByTestId('extension-item')).toHaveCount(2);
});

test('colors a language from its grammar and expands its snippets (Scenario B)', async ({
  atlas,
}) => {
  project(atlas, 'tasks', { 'build.acme': '# deploy everything\ntask build\n' });
  const { page } = await launch(atlas);
  await openHub(page);
  await install(page, 'acme', 'Acme Language');
  await expect(page.getByTestId('compat-working')).toContainText('Syntax highlighting: acme');

  await openFile(page, 'build.acme');
  // TextMate grammar in the editor: comments use the dark theme's comment color.
  await expect.poll(() => tokenColor(page, '# deploy everything')).toBe('rgb(106, 153, 85)');
  await expect.poll(() => tokenColor(page, 'task')).toBe('rgb(197, 134, 192)');

  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('gre');
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.monaco-editor .suggest-widget')).toContainText('greet');
  await page.keyboard.press('Enter');
  await page.keyboard.type('team');
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('greet team');
});

test('shows what an extension with code cannot do and does not install it (Scenario E)', async ({
  atlas,
}) => {
  const { page } = await launch(atlas);
  await openHub(page);
  await select(page, 'runner', 'Acme Runner');
  const report = page.getByTestId('compatibility-report');
  await expect(report.getByTestId('compatibility-badge')).toHaveText('Not supported');
  await expect(report.getByTestId('compat-unsupported')).toContainText('Extension code');
  await expect(report.getByTestId('compat-unsupported')).toContainText('Commands');
  await expect(report).toContainText('ATLAS does not run extension code yet');
  await expect(page.getByTestId('extension-install')).toBeDisabled();
});

test('enables per project and survives a registry outage (Scenario F)', async ({ atlas }) => {
  project(atlas, 'alpha', { 'a.acme': '# a\n' });
  project(atlas, 'beta', { 'b.acme': '# b\n' });
  const { page } = await launch(atlas);
  await openHub(page);
  await install(page, 'acme', 'Acme Language');

  const scope = page.getByLabel('Project', { exact: true });
  await scope.click();
  await page.getByRole('option', { name: 'beta' }).click();
  await page.getByLabel('In beta').click();
  await page.getByRole('option', { name: 'Disabled in this project' }).click();
  await expect(page.getByTestId('extension-active')).toHaveText('Not active in this project.');

  await scope.click();
  await page.getByRole('option', { name: 'alpha' }).click();
  await expect(page.getByTestId('extension-active')).toHaveText('Active in this project.');

  registry.down = true;
  await page.getByLabel('Search extensions').fill('something else');
  await expect(page.getByTestId('registry-unavailable')).toContainText('could not be reached');
  await page.getByRole('tab', { name: /^Installed/ }).click();
  await expect(
    page.getByTestId('extension-item').filter({ hasText: 'Acme Language' }),
  ).toBeVisible();
});
