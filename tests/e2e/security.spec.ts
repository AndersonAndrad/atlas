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
      sessionKeys: Object.keys((w.atlas as { sessions: object }).sessions).sort(),
      aiKeys: Object.keys((w.atlas as { ai: object }).ai).sort(),
    };
  });
  expect(exposure).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    buffer: 'undefined',
    atlasKeys: [
      'ai',
      'app',
      'context',
      'dialog',
      'git',
      'groups',
      'projects',
      'sessions',
      'terminals',
    ],
    // AI CLIs are only started or tracked; no command text crosses the bridge.
    aiKeys: ['attach', 'start'],
    // Lifecycle changes go through named actions; there is no way to set a status.
    sessionKeys: [
      'addTask',
      'cancelTask',
      'create',
      'events',
      'get',
      'getSettings',
      'list',
      'onChanged',
      'perform',
      'removeTask',
      'setSettings',
      'update',
      'updateTask',
    ],
    projectKeys: ['create', 'get', 'getSelected', 'list', 'remove', 'select', 'update'],
    // No shell path or arbitrary-command parameters are exposed; directories must
    // come from the native picker.
    terminalKeys: [
      'acknowledge',
      'associate',
      'attach',
      'clear',
      'closeInfo',
      'create',
      'detach',
      'dismiss',
      'getLayout',
      'getPreferences',
      'git',
      'list',
      'move',
      'onEvent',
      'projectContext',
      'registerProject',
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

test('renderer cannot bind sessions to directories or statuses it was not given', async ({
  atlas,
}) => {
  const dir = atlas.workspace('forbidden-session');
  const { page } = await atlas.launch();
  const results = await page.evaluate(async (workspacePath) => {
    const sessions = (
      window as unknown as {
        atlas: {
          sessions: {
            create(i: unknown): Promise<{ ok: boolean; data?: { id: string } }>;
            perform(id: string, action: string): Promise<unknown>;
          };
        };
      }
    ).atlas.sessions;
    const folder = await sessions.create({ name: 'x', objective: 'y', workspacePath });
    const status = await sessions.create({ name: 'x', objective: 'y', status: 'COMPLETED' });
    const created = await sessions.create({ name: 'x', objective: 'y' });
    const complete = await sessions.perform(created.data!.id, 'complete');
    return { folder, status, complete };
  }, dir);
  expect(results.folder).toMatchObject({ ok: false, error: { code: 'PROJECT_PATH_INVALID' } });
  expect(results.status).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  expect(results.complete).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
});

test('renderer cannot open terminals in directories it was not given', async ({ atlas }) => {
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
      error: expect.objectContaining({ code: 'PROJECT_PATH_INVALID' }),
    }),
  ]);
});
