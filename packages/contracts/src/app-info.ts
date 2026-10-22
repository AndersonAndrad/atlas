/**
 * Name of the application wherever it is presented: window, menus, Dock, About (PLAN-025).
 * Explanatory text keeps "ATLAS"; the CLI (`atlas`) and the data folder do not change.
 */
export const APP_DISPLAY_NAME = 'A.T.L.A.S';

/** Version and environment information shown in About, Settings and diagnostics. */
export interface AppInfo {
  appName: string;
  desktopVersion: string;
  engineVersion: string;
  channel: 'development' | 'production';
  /** Source revision the build was made from, when known. */
  buildId: string | null;
  platform: string;
  arch: string;
  osVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  dataDir: string;
  logFile: string;
  schemaVersion: number;
}
