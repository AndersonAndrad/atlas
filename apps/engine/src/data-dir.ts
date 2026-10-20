import path from 'node:path';

export const APP_DIRECTORY_NAME = 'ATLAS';
export const DATABASE_FILE_NAME = 'atlas.db';
export const DATA_DIR_ENV = 'ATLAS_DATA_DIR';

export interface DataDirOptions {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homeDir: string;
}

/**
 * Resolves the per-user application data directory shared by the desktop app,
 * Engine and CLI. `ATLAS_DATA_DIR` overrides it (used by tests and portable setups).
 */
export function resolveDataDir({ env, platform, homeDir }: DataDirOptions): string {
  const override = env[DATA_DIR_ENV]?.trim();
  if (override) {
    return path.resolve(override);
  }
  switch (platform) {
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support', APP_DIRECTORY_NAME);
    case 'win32': {
      const appData = env.APPDATA?.trim() || path.win32.join(homeDir, 'AppData', 'Roaming');
      return path.win32.join(appData, APP_DIRECTORY_NAME);
    }
    default: {
      const xdg = env.XDG_DATA_HOME?.trim();
      const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir, '.local', 'share');
      return path.join(base, 'atlas');
    }
  }
}
