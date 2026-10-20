import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  SqliteProjectRepository,
  SqliteSettingsRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import { ProjectService, toPathPlatform, type Clock, type PathInspector } from '@atlas/projects';
import type { Logger } from '@atlas/shared';
import { FileLogger } from './adapters/file-logger.js';
import { NodePathInspector } from './adapters/node-path-inspector.js';
import { DATABASE_FILE_NAME, resolveDataDir } from './data-dir.js';

export interface EngineOptions {
  /** Overrides data directory resolution. */
  dataDir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Identifies the client in logs, e.g. "desktop" or "cli". */
  component?: string;
  logger?: Logger;
  clock?: Clock;
  inspector?: PathInspector;
}

export interface Engine {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly logger: Logger;
  readonly projects: ProjectService;
  schemaVersion(): number;
  close(): void;
}

/**
 * Composition root of the headless Engine. Every client (desktop, CLI, tests)
 * builds the same services through this function.
 */
export function createEngine(options: EngineOptions = {}): Engine {
  const platform = options.platform ?? process.platform;
  const pathPlatform = toPathPlatform(platform);
  const dataDir =
    options.dataDir ??
    resolveDataDir({ env: options.env ?? process.env, platform, homeDir: os.homedir() });
  const databasePath = path.join(dataDir, DATABASE_FILE_NAME);
  const logger =
    options.logger ??
    new FileLogger({
      filePath: path.join(dataDir, 'logs', 'atlas.log'),
      component: options.component ?? 'engine',
    });
  const clock = options.clock ?? { now: () => new Date() };

  const db: Database = openDatabase({ filePath: databasePath, logger });
  const projects = new ProjectService({
    projects: new SqliteProjectRepository(db),
    settings: new SqliteSettingsRepository(db),
    inspector:
      options.inspector ??
      new NodePathInspector({ platform: pathPlatform, now: () => clock.now(), logger }),
    clock,
    generateId: randomUUID,
    platform: pathPlatform,
    logger,
  });

  let closed = false;
  return {
    dataDir,
    databasePath,
    logger,
    projects,
    schemaVersion: () => getSchemaVersion(db),
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
