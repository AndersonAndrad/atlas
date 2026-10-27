import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppInfo } from '@atlas/contracts';
import { APP_DISPLAY_NAME, IPC_EVENT_CHANNELS, type AppCommand } from '@atlas/contracts/ipc';
import { FileLogger, resolveDataDir } from '@atlas/engine';
import { describeError } from '@atlas/shared';
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  session,
  shell,
  utilityProcess,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { EngineHostClient } from './engine-client';
import { registerIpcHandlers } from './ipc';
import { buildMenuTemplate, setTerminalShortcutsEnabled } from './menu';
import { quitWarning } from './quit-warning';
// Copied next to the bundle by electron-vite; the window and the Dock show it (PLAN-025).
import appIcon from '../../build/icon.png?asset';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = path.join(currentDir, '../renderer/index.html');
const engineHostEntry = path.join(currentDir, 'engine-host.js');

// Injected at build time by electron.vite.config.ts.
declare const __ATLAS_BUILD_ID__: string;

const dataDir = resolveDataDir({
  env: process.env,
  platform: process.platform,
  homeDir: os.homedir(),
});
// Keep Chromium profile data inside the ATLAS data directory. This must happen
// before the single-instance lock, which is scoped to the userData directory.
app.setPath('userData', path.join(dataDir, 'electron'));
// Menus (About, Hide, Quit) use this name, also when running from source as "Electron".
app.setName(APP_DISPLAY_NAME);

const logger = new FileLogger({
  filePath: path.join(dataDir, 'logs', 'atlas.log'),
  component: 'desktop',
});

let engine: EngineHostClient | undefined;
let mainWindow: BrowserWindow | undefined;
/** Incremented on every renderer navigation; see `subscriberId`. */
let rendererGeneration = 0;
/** Editor tabs with unsaved changes in the current renderer (SDD-011 FR-1105). */
let unsavedEditorFiles = 0;
/**
 * Id of the main window's webContents, captured at creation: once the window
 * closes, its webContents is destroyed and can no longer be read.
 */
let rendererContentsId = 0;
/** Set once the user confirmed quitting and the Engine stopped. */
let readyToQuit = false;
let quitInProgress = false;

function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (devServerUrl && !app.isPackaged) {
      return parsed.origin === new URL(devServerUrl).origin;
    }
    return parsed.protocol === 'file:' && fileURLToPath(parsed) === rendererFile;
  } catch {
    return false;
  }
}

function subscriberId(): string {
  return `desktop-${rendererContentsId}-${rendererGeneration}`;
}

function detachCurrentRenderer(): void {
  const previous = subscriberId();
  void engine?.call('terminals.detachSubscriber', previous).catch(() => undefined);
  void engine
    ?.call('files.watch', previous, { projectId: null, directories: [] })
    .catch(() => undefined);
  void engine?.call('docker.detach', previous).catch(() => undefined);
  void engine?.call('http.detach', previous).catch(() => undefined);
  void engine?.call('debug.detach', previous).catch(() => undefined);
}

/** A new renderer starts without editor state: no unsaved buffers, terminal shortcuts on. */
function resetEditorState(): void {
  unsavedEditorFiles = 0;
  const menu = Menu.getApplicationMenu();
  if (menu !== null) setTerminalShortcutsEnabled(menu, true);
}

function sendToRenderer(channel: string, payload?: unknown): void {
  const contents = mainWindow?.webContents;
  if (contents && !contents.isDestroyed()) contents.send(channel, payload);
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: `${APP_DISPLAY_NAME} — Autonomous Task Leadership & Agent System`,
    // Linux and Windows show it in the taskbar; macOS uses the app bundle icon.
    icon: appIcon,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(currentDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  rendererContentsId = window.webContents.id;
  window.once('ready-to-show', () => window.show());

  // The renderer may never open new windows or navigate away from the app.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  // A reload replaces the renderer: its terminal views are gone, the PTYs are not.
  window.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    detachCurrentRenderer();
    rendererGeneration += 1;
    resetEditorState();
  });
  window.webContents.on('render-process-gone', () => {
    detachCurrentRenderer();
    rendererGeneration += 1;
    resetEditorState();
  });

  // On Windows and Linux closing the window quits ATLAS, which needs confirmation.
  window.on('close', (event) => {
    if (process.platform !== 'darwin' && !readyToQuit) {
      event.preventDefault();
      app.quit();
      return;
    }
    // On macOS the window closes without quitting, which discards the editor's buffers.
    if (!readyToQuit && unsavedEditorFiles > 0) {
      event.preventDefault();
      void confirmDiscardUnsaved(window).then((discard) => {
        if (!discard) return;
        unsavedEditorFiles = 0;
        window.close();
      });
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      detachCurrentRenderer();
      mainWindow = undefined;
    }
  });

  if (devServerUrl && !app.isPackaged) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(rendererFile);
  }
  return window;
}

function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return (
    mainWindow !== undefined &&
    event.sender === mainWindow.webContents &&
    event.senderFrame !== null &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    isAppUrl(event.senderFrame.url)
  );
}

async function bootstrap(): Promise<void> {
  logger.info('Desktop application starting', { version: app.getVersion() });

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );

  engine = new EngineHostClient({
    fork: () =>
      utilityProcess.fork(engineHostEntry, [], {
        serviceName: 'ATLAS Engine',
        stdio: 'ignore',
        env: process.env,
      }),
    dataDir,
    appVersion: app.getVersion(),
    logger,
    onEvent: (message) => {
      // Output goes only to the view that attached it; lifecycle events to the window.
      if (message.event.type === 'session-changed') {
        sendToRenderer(IPC_EVENT_CHANNELS.sessionChanged, message.event);
        return;
      }
      if (message.subscriberId === undefined) {
        sendToRenderer(IPC_EVENT_CHANNELS.terminalEvent, { event: message.event });
        return;
      }
      const prefix = `${subscriberId()}:`;
      if (!message.subscriberId.startsWith(prefix)) return;
      sendToRenderer(IPC_EVENT_CHANNELS.terminalEvent, {
        event: message.event,
        viewId: message.subscriberId.slice(prefix.length),
      });
    },
    onRestarted: () => sendToRenderer(IPC_EVENT_CHANNELS.engineRestarted),
    onGaveUp: () => {
      logger.error('Engine host keeps failing; giving up');
      dialog.showErrorBox(
        'ATLAS Engine stopped',
        `The ATLAS Engine stopped repeatedly. Restart ${APP_DISPLAY_NAME} to continue.`,
      );
    },
  });
  await engine.start();

  registerIpcHandlers({
    ipcMain,
    engine,
    logger,
    isTrustedSender,
    showOpenDialog: (options) =>
      mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options),
    subscriberId,
    appInfo,
    writeClipboard: async (text, target) => {
      // The selection clipboard only exists on Linux; elsewhere there is nothing to write.
      const board = target === 'selection' ? clipboard.selection : clipboard;
      await board?.writeText(text);
    },
    readClipboard: async (target) => {
      const board = target === 'selection' ? clipboard.selection : clipboard;
      return board === undefined ? '' : board.readText();
    },
    saveTextFile: async (suggestedName, text) => {
      const options = { defaultPath: path.join(app.getPath('documents'), suggestedName) };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || result.filePath === undefined) return false;
      await writeFile(result.filePath, text, 'utf8');
      return true;
    },
    chooseSavePath: async (suggestedName) => {
      const options = { defaultPath: path.join(app.getPath('downloads'), suggestedName) };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      return result.canceled || result.filePath === undefined ? null : result.filePath;
    },
    revealPath: (absolutePath) => shell.showItemInFolder(absolutePath),
    openExternal: (url) => shell.openExternal(url),
    trashPath: (absolutePath) => shell.trashItem(absolutePath),
    setUnsavedFiles: (count) => {
      unsavedEditorFiles = count;
    },
    setTerminalShortcuts: (enabled) => {
      const menu = Menu.getApplicationMenu();
      if (menu !== null) setTerminalShortcutsEnabled(menu, enabled);
    },
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        platform: process.platform,
        appName: APP_DISPLAY_NAME,
        isDevelopment: !app.isPackaged,
        sendCommand: (command: AppCommand) =>
          sendToRenderer(IPC_EVENT_CHANNELS.appCommand, command),
      }),
    ),
  );

  mainWindow = createMainWindow();
}

/** Version and environment details for About, Settings and diagnostics. */
async function appInfo(): Promise<AppInfo> {
  const status = await engine!.call('engine.status');
  return {
    appName: APP_DISPLAY_NAME,
    desktopVersion: app.getVersion(),
    engineVersion: status.engineVersion,
    channel: app.isPackaged ? 'production' : 'development',
    buildId: __ATLAS_BUILD_ID__ === '' ? null : __ATLAS_BUILD_ID__,
    platform: process.platform,
    arch: process.arch,
    osVersion: os.release(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    dataDir: status.dataDir,
    logFile: status.logFile,
    schemaVersion: status.schemaVersion,
  };
}

/** Asks before quitting when terminals are running. Resolves to true to quit. */
async function confirmQuit(): Promise<boolean> {
  if (engine === undefined) return true;
  // An Engine that does not answer has nothing to confirm; quitting must stay possible.
  const [info, work] = await Promise.all([
    engine.call('terminals.closeAllInfo').catch(() => ({ runningSessions: 0, busySessions: 0 })),
    engine
      .call('engine.backgroundWork')
      .catch(() => ({ gitOperations: 0, preflightRuns: 0, backgroundJobs: 0 })),
  ]);
  const warning = quitWarning(info.runningSessions, work, APP_DISPLAY_NAME, unsavedEditorFiles);
  if (warning === null) return true;
  const options = {
    type: 'warning' as const,
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    ...warning,
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

async function confirmDiscardUnsaved(window: BrowserWindow): Promise<boolean> {
  const files = unsavedEditorFiles === 1 ? '1 file has' : `${unsavedEditorFiles} files have`;
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Discard changes', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `${files} unsaved changes.`,
    detail: 'Closing the window discards the changes not saved in the editor.',
  });
  return response === 0;
}

/**
 * Quitting terminates every terminal process, Git operation and Preflight run (they do
 * not outlive the Engine).
 * After confirmation the Engine stops gracefully before the app exits.
 */
async function quitGracefully(): Promise<void> {
  if (quitInProgress) return;
  quitInProgress = true;
  try {
    if (!(await confirmQuit())) return;
    await engine
      ?.stop()
      .catch((error: unknown) =>
        logger.error('Failed to stop the Engine cleanly', { error: describeError(error) }),
      );
    readyToQuit = true;
    app.quit();
  } finally {
    quitInProgress = false;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (engine) {
      mainWindow = createMainWindow();
    }
  });

  app
    .whenReady()
    .then(async () => {
      // A packaged app shows its bundle icon; from source the Dock would show Electron's.
      if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(appIcon);
      await bootstrap();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
      });
    })
    .catch((error: unknown) => {
      logger.error('Failed to start ATLAS', { error: describeError(error) });
      dialog.showErrorBox(
        `${APP_DISPLAY_NAME} could not start`,
        'The application data could not be loaded.',
      );
      readyToQuit = true;
      app.exit(1);
    });

  app.on('window-all-closed', () => {
    // On macOS terminals keep running with the window closed; reopening reattaches.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (readyToQuit) return;
    event.preventDefault();
    void quitGracefully();
  });
}
