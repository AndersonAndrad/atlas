import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopDir = path.join(root, 'apps/desktop');
const cliEntry = path.join(root, 'apps/cli/dist/index.js');
const electronPath = createRequire(path.join(desktopDir, 'package.json'))(
  'electron',
) as unknown as string;

export interface AtlasHarness {
  /** Isolated temporary root; nothing outside it is touched. */
  root: string;
  /** First directory on the PATH of the app and its shells, for fake CLIs. */
  binDir: string;
  dataDir: string;
  /** Creates a workspace directory, optionally with a minimal Git repository. */
  workspace(name: string, options?: { git?: string }): string;
  /** Runs the real CLI against the same isolated data directory. */
  cli(...args: string[]): string;
  /** `env` adds variables to the app's environment, e.g. those `pnpm dev` sets. */
  launch(options?: {
    env?: Record<string, string>;
  }): Promise<{ app: ElectronApplication; page: Page }>;
  /** Makes the next native directory picker return `directory` (or cancel when undefined). */
  stubDirectoryPicker(app: ElectronApplication, directory: string | undefined): Promise<void>;
  /** Answers native message boxes (the quit confirmation) with the given button index. */
  stubMessageBox(app: ElectronApplication, response: number): Promise<void>;
  /** Triggers an application menu item, i.e. its keyboard shortcut. */
  menu(app: ElectronApplication, id: string): Promise<void>;
}

export const test = base.extend<{ atlas: AtlasHarness }>({
  // eslint-disable-next-line no-empty-pattern
  atlas: async ({}, use) => {
    const tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atlas-e2e-')));
    const dataDir = path.join(tempRoot, 'data');
    const apps: ElectronApplication[] = [];
    // Inherit the environment, but never a dev-server URL, and isolate all ATLAS data.
    // Shells run with an empty HOME and plain bash so no user dotfiles are loaded.
    const home = path.join(tempRoot, 'home');
    mkdirSync(home);
    const binDir = path.join(tempRoot, 'bin');
    mkdirSync(binDir);
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        ATLAS_DATA_DIR: dataDir,
        HOME: home,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        SHELL: '/bin/bash',
        BASH_SILENCE_DEPRECATION_WARNING: '1',
        ZDOTDIR: home,
      }).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== 'ELECTRON_RENDERER_URL',
      ),
    );

    const harness: AtlasHarness = {
      root: tempRoot,
      binDir,
      dataDir,
      workspace(name, options = {}) {
        const dir = path.join(tempRoot, 'workspaces', name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
        if (options.git) {
          mkdirSync(path.join(dir, '.git'));
          writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${options.git}\n`);
        }
        return dir;
      },
      cli: (...args) => execFileSync(process.execPath, [cliEntry, ...args], { env }).toString(),
      async launch(options = {}) {
        const app = await electron.launch({
          executablePath: electronPath,
          args: [desktopDir],
          env: { ...env, ...options.env },
        });
        apps.push(app);
        // Quitting with running terminals asks first; tests confirm unless they override it.
        await harness.stubMessageBox(app, 0);
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        return { app, page };
      },
      async stubDirectoryPicker(app, directory) {
        await app.evaluate(({ dialog }, selected) => {
          dialog.showOpenDialog = (async () =>
            selected === undefined
              ? { canceled: true, filePaths: [] }
              : { canceled: false, filePaths: [selected] }) as typeof dialog.showOpenDialog;
        }, directory);
      },
      async stubMessageBox(app, response) {
        await app.evaluate(({ dialog }, answer) => {
          dialog.showMessageBox = (async () => ({
            response: answer,
            checkboxChecked: false,
          })) as unknown as typeof dialog.showMessageBox;
        }, response);
      },
      async menu(app, id) {
        await app.evaluate(({ Menu }, itemId) => {
          const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
          if (!item) throw new Error(`Menu item ${itemId} not found`);
          item.click();
        }, id);
      },
    };

    await use(harness);

    for (const app of apps) await app.close().catch(() => undefined);
    rmSync(tempRoot, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';
