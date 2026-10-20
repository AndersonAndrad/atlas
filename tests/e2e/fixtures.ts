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
  dataDir: string;
  /** Creates a workspace directory, optionally with a minimal Git repository. */
  workspace(name: string, options?: { git?: string }): string;
  /** Runs the real CLI against the same isolated data directory. */
  cli(...args: string[]): string;
  launch(): Promise<{ app: ElectronApplication; page: Page }>;
  /** Makes the next native directory picker return `directory` (or cancel when undefined). */
  stubDirectoryPicker(app: ElectronApplication, directory: string | undefined): Promise<void>;
}

export const test = base.extend<{ atlas: AtlasHarness }>({
  // eslint-disable-next-line no-empty-pattern
  atlas: async ({}, use) => {
    const tempRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atlas-e2e-')));
    const dataDir = path.join(tempRoot, 'data');
    const apps: ElectronApplication[] = [];
    // Inherit the environment, but never a dev-server URL, and isolate all ATLAS data.
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ATLAS_DATA_DIR: dataDir }).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== 'ELECTRON_RENDERER_URL',
      ),
    );

    const harness: AtlasHarness = {
      root: tempRoot,
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
      async launch() {
        const app = await electron.launch({
          executablePath: electronPath,
          args: [desktopDir],
          env,
        });
        apps.push(app);
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
    };

    await use(harness);

    for (const app of apps) await app.close().catch(() => undefined);
    rmSync(tempRoot, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';
