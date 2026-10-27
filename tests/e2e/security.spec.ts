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
      fileKeys: Object.keys((w.atlas as { files: object }).files).sort(),
      quickCommandKeys: Object.keys((w.atlas as { quickCommands: object }).quickCommands).sort(),
      preflightKeys: Object.keys((w.atlas as { preflight: object }).preflight).sort(),
      appKeys: Object.keys((w.atlas as { app: object }).app).sort(),
      notificationKeys: Object.keys((w.atlas as { notifications: object }).notifications).sort(),
      noteKeys: Object.keys((w.atlas as { notes: object }).notes).sort(),
      jobKeys: Object.keys((w.atlas as { jobs: object }).jobs).sort(),
      dockerKeys: Object.keys((w.atlas as { docker: object }).docker).sort(),
      httpKeys: Object.keys((w.atlas as { http: object }).http).sort(),
      extensionKeys: Object.keys((w.atlas as { extensions: object }).extensions).sort(),
      projectFileKeys: Object.keys((w.atlas as { projectFiles: object }).projectFiles).sort(),
      editorKeys: Object.keys((w.atlas as { editor: object }).editor).sort(),
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
      'docker',
      'editor',
      'extensions',
      'files',
      'git',
      'groups',
      'http',
      'jobs',
      'notes',
      'notifications',
      'preflight',
      'projectFiles',
      'projects',
      'quickCommands',
      'sessions',
      'skills',
      'terminals',
      'usage',
    ],
    // Preflight names workspaces and runs by id; a folder outside projects must come from
    // the picker, and a run starts only with the digests the user authorized.
    preflightKeys: [
      'addFolder',
      'cancel',
      'discover',
      'environment',
      'openProject',
      'output',
      'plan',
      'removeWorkspace',
      'report',
      'run',
      'runs',
      'saveConfig',
      'start',
      'workspace',
      'workspaces',
    ],
    // Files are written only where the user chose in the native save dialog.
    appKeys: [
      'copyText',
      'info',
      'onCommand',
      'onEngineRestarted',
      'readText',
      'saveText',
      'setTerminalShortcuts',
      'setUnsavedFiles',
    ],
    // Notifications are read, marked read or deleted by id; nothing else crosses the bridge.
    notificationKeys: ['clear', 'list', 'markAllRead', 'markRead', 'remove'],
    // Docker operations are typed and name their context; no socket, API or command text.
    dockerKeys: [
      'container',
      'containers',
      'contexts',
      'create',
      'lifecycle',
      'logsClose',
      'logsOpen',
      'logsRead',
      'openTerminal',
      'remove',
      'rename',
      'selectContext',
      'stats',
      'status',
      'watch',
    ],
    // HTTP runs in the Engine; files to upload and download destinations come only from
    // native dialogs, never as paths from the window.
    httpKeys: [
      'cancel',
      'chooseFile',
      'clearCookies',
      'clearHistory',
      'collections',
      'cookies',
      'createCollection',
      'createFolder',
      'deleteCollection',
      'deleteFolder',
      'deleteRequest',
      'deleteSnapshot',
      'duplicateCollection',
      'duplicateRequest',
      'history',
      'move',
      'readBody',
      'recentUrls',
      'release',
      'renameFolder',
      'request',
      'saveRequest',
      'saveResponse',
      'saveSnapshot',
      'send',
      'snapshot',
      'snapshots',
      'updateCollection',
    ],
    // Extensions are named by id; package files never cross the bridge as paths, and only
    // https homepage links can be opened. No extension code runs (SDD-015 Milestone A).
    extensionKeys: [
      'checkUpdates',
      'clearDiagnostics',
      'contributions',
      'details',
      'diagnostics',
      'grammar',
      'icon',
      'iconTheme',
      'install',
      'languageConfiguration',
      'list',
      'openLink',
      'reportProblem',
      'search',
      'setEnabled',
      'snippets',
      'theme',
      'uninstall',
    ],
    // Background jobs run only in registered projects (or Preflight workspaces) the Engine
    // resolves; commands that look destructive need an explicit confirmation.
    jobKeys: [
      'cancel',
      'create',
      'get',
      'getSettings',
      'list',
      'output',
      'retry',
      'setSettings',
      'summary',
    ],
    // Notes never carry a filesystem path: files are revealed from a link the Engine resolves
    // inside the project, and only web or e-mail links open outside the app.
    noteKeys: [
      'checkLinks',
      'create',
      'get',
      'list',
      'openExternal',
      'remove',
      'revealFile',
      'update',
    ],
    // Project files are named by project and relative path; the Engine resolves them inside
    // the project folder. The Trash and the file manager get paths from the Engine only.
    projectFileKeys: [
      'create',
      'find',
      'list',
      'move',
      'read',
      'reveal',
      'trash',
      'versions',
      'watch',
      'write',
    ],
    // Preferences and layouts hold file references only, never contents.
    editorKeys: [
      'getLastProject',
      'getLayout',
      'getPreferences',
      'setLastProject',
      'setLayout',
      'setPreferences',
    ],
    // AI CLIs are only started or tracked; no command text crosses the bridge.
    aiKeys: ['attach', 'start'],
    // Only the path of a file the user dropped; no filesystem access.
    fileKeys: ['pathFor'],
    // Quick commands run by id: what runs is the stored command the user saw in the menu.
    quickCommandKeys: [
      'create',
      'list',
      'move',
      'projectActions',
      'projectSettings',
      'remove',
      'run',
      'setProjectSettings',
      'update',
    ],
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
      'llmUsage',
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
  // Scripts stay 'self'; WebAssembly may be compiled for extension grammars (ADR-067), which
  // does not allow eval() of JavaScript. Inline styles are needed by xterm.js and Radix.
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
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
