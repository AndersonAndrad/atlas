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
