import { expect, test } from './fixtures';

test('renderer has no Node.js access and only the scoped bridge', async ({ atlas }) => {
  const { app, page } = await atlas.launch();

  const exposure = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      require: typeof w.require,
      process: typeof w.process,
      module: typeof w.module,
      buffer: typeof w.Buffer,
      atlasKeys: Object.keys(w.atlas as object).sort(),
      projectKeys: Object.keys((w.atlas as { projects: object }).projects).sort(),
    };
  });
  expect(exposure).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    buffer: 'undefined',
    atlasKeys: ['dialog', 'projects'],
    projectKeys: ['create', 'get', 'getSelected', 'list', 'remove', 'select', 'update'],
  });

  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    const p = (
      wc as unknown as { getLastWebPreferences(): Record<string, unknown> }
    ).getLastWebPreferences();
    return {
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      sandbox: p.sandbox,
    };
  });
  expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true });

  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
});

test('renderer cannot register arbitrary paths without the picker', async ({ atlas }) => {
  const dir = atlas.workspace('forbidden');
  const { page } = await atlas.launch();
  const result = await page.evaluate(
    (workspacePath) =>
      (
        window as unknown as { atlas: { projects: { create(i: unknown): Promise<unknown> } } }
      ).atlas.projects.create({
        name: 'x',
        workspacePath,
      }),
    dir,
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'PROJECT_PATH_INVALID' } });
});
