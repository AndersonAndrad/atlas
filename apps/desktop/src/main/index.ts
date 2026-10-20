import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileLogger, createEngine, resolveDataDir, type Engine } from '@atlas/engine';
import { describeError } from '@atlas/shared';
import { BrowserWindow, app, dialog, ipcMain, session } from 'electron';
import { registerIpcHandlers } from './ipc.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = path.join(currentDir, '../renderer/index.html');

const dataDir = resolveDataDir({
  env: process.env,
  platform: process.platform,
  homeDir: os.homedir(),
});
// Keep Chromium profile data inside the ATLAS data directory. This must happen
// before the single-instance lock, which is scoped to the userData directory.
app.setPath('userData', path.join(dataDir, 'electron'));

let engine: Engine | undefined;
let mainWindow: BrowserWindow | undefined;

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

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: 'ATLAS',
    backgroundColor: '#0e1116',
    webPreferences: {
      preload: path.join(currentDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // The renderer may never open new windows or navigate away from the app.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  if (devServerUrl && !app.isPackaged) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(rendererFile);
  }
  return window;
}

function bootstrap(): void {
  engine = createEngine({ component: 'desktop', dataDir });
  engine.logger.info('Desktop application starting', { version: app.getVersion() });

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );

  registerIpcHandlers({
    ipcMain,
    engine,
    isTrustedSender: (event) =>
      mainWindow !== undefined &&
      event.sender === mainWindow.webContents &&
      event.senderFrame !== null &&
      event.senderFrame === mainWindow.webContents.mainFrame &&
      isAppUrl(event.senderFrame.url),
    showOpenDialog: (options) =>
      mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options),
  });

  mainWindow = createMainWindow();
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
    .then(() => {
      bootstrap();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
      });
    })
    .catch((error: unknown) => {
      // The Engine logger may not exist yet (e.g. the database failed to open).
      const logger =
        engine?.logger ??
        new FileLogger({ filePath: path.join(dataDir, 'logs', 'atlas.log'), component: 'desktop' });
      logger.error('Failed to start ATLAS', { error: describeError(error) });
      dialog.showErrorBox('ATLAS could not start', 'The application data could not be loaded.');
      app.exit(1);
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    engine?.close();
  });
}
