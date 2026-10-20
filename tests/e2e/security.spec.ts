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
      terminalKeys: Object.keys((w.atlas as { terminals: object }).terminals).sort(),
    };
  });
  expect(exposure).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    buffer: 'undefined',
    atlasKeys: ['app', 'dialog', 'projects', 'terminals'],
    projectKeys: ['create', 'get', 'getSelected', 'list', 'remove', 'select', 'update'],
    // No shell, path or arbitrary-command parameters are exposed.
    terminalKeys: [
      'acknowledge',
      'attach',
      'clear',
      'closeInfo',
      'create',
      'detach',
      'dismiss',
      'getLayout',
      'getPreferences',
      'list',
      'onEvent',
      'rename',
      'resize',
      'restart',
      'setLayout',
      'setPreferences',
      'shells',
      'terminate',
      'write',
    ],
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
  expect(csp).toContain("script-src 'self';");
  // Inline styles are needed by xterm.js and Radix (ADR-011); scripts stay strict.
  expect(csp).not.toMatch(/script-src[^;]*unsafe/);
  expect(csp).toContain("connect-src 'none'");
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

test('renderer cannot open terminals outside registered projects', async ({ atlas }) => {
  const { page } = await atlas.launch();
  const results = await page.evaluate(async () => {
    const terminals = (
      window as unknown as { atlas: { terminals: { create(i: unknown): Promise<unknown> } } }
    ).atlas.terminals;
    return [
      await terminals.create({ projectId: '00000000-0000-4000-8000-000000000000' }),
      await terminals.create({ projectId: '00000000-0000-4000-8000-000000000000', cwd: '/' }),
      await terminals.create({ cwd: '/' }),
    ];
  });
  expect(results).toEqual([
    expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    }),
    expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    }),
    expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    }),
  ]);
});
