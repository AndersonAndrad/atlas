import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  SqliteProjectRepository,
  SqliteSettingsRepository,
  SqliteTerminalSessionRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import { ProjectService, toPathPlatform, type Clock, type PathInspector } from '@atlas/projects';
import { describeError, type Logger } from '@atlas/shared';
import {
  TerminalService,
  TerminalSettings,
  type PtySpawner,
  type ScreenMirrorFactory,
  type ShellProvider,
  type TerminalTiming,
} from '@atlas/terminal';
import { FileLogger } from './adapters/file-logger.js';
import { HeadlessScreenMirrorFactory } from './adapters/headless-screen-mirror.js';
import { NodePathInspector } from './adapters/node-path-inspector.js';
import { NodePtySpawner } from './adapters/node-pty-spawner.js';
import { ShellEnvironment } from './adapters/shell-environment.js';
import { CUSTOM_SHELLS_FILE_NAME, SystemShellProvider } from './adapters/system-shell-provider.js';
import { DATABASE_FILE_NAME, resolveDataDir } from './data-dir.js';

export interface TerminalRuntimeOptions {
  /** Version reported to shells through TERM_PROGRAM_VERSION. */
  appVersion?: string;
  spawner?: PtySpawner;
  mirrors?: ScreenMirrorFactory;
  shells?: ShellProvider;
  timing?: Partial<TerminalTiming>;
}

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
  /**
   * Enables the terminal runtime. Only the Engine host process that owns
   * terminal processes enables it; short-lived clients such as the CLI do not.
   */
  terminals?: TerminalRuntimeOptions;
}

export interface Engine {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly logger: Logger;
  readonly projects: ProjectService;
  readonly terminalSettings: TerminalSettings;
  /** Present only when the Engine was created with `terminals`. */
  readonly terminals: TerminalService | undefined;
  schemaVersion(): number;
  /** Prepares asynchronous services. Must complete before terminals are used. */
  initialize(): Promise<void>;
  /** Removes a project from the registry together with its terminals and layout. */
  removeProject(id: string): Promise<void>;
  /** Terminates terminal processes, then closes the database. */
  shutdown(): Promise<void>;
  /** Closes the database immediately. Prefer `shutdown` when terminals may run. */
  close(): void;
}

/**
 * Composition root of the headless Engine. Every client (desktop, CLI, tests)
 * builds the same services through this function.
 */
export function createEngine(options: EngineOptions = {}): Engine {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathPlatform = toPathPlatform(platform);
  const dataDir = options.dataDir ?? resolveDataDir({ env, platform, homeDir: os.homedir() });
  const databasePath = path.join(dataDir, DATABASE_FILE_NAME);
  const logger =
    options.logger ??
    new FileLogger({
      filePath: path.join(dataDir, 'logs', 'atlas.log'),
      component: options.component ?? 'engine',
    });
  const clock = options.clock ?? { now: () => new Date() };

  const db: Database = openDatabase({ filePath: databasePath, logger });
  const settings = new SqliteSettingsRepository(db);
  const projects = new ProjectService({
    projects: new SqliteProjectRepository(db),
    settings,
    inspector:
      options.inspector ??
      new NodePathInspector({ platform: pathPlatform, now: () => clock.now(), logger }),
    clock,
    generateId: randomUUID,
    platform: pathPlatform,
    logger,
  });
  const terminalSettings = new TerminalSettings(settings, logger);

  const terminalOptions = options.terminals;
  const terminals =
    terminalOptions === undefined
      ? undefined
      : new TerminalService({
          sessions: new SqliteTerminalSessionRepository(db),
          spawner: terminalOptions.spawner ?? new NodePtySpawner(),
          mirrors: terminalOptions.mirrors ?? new HeadlessScreenMirrorFactory(),
          shells:
            terminalOptions.shells ??
            new SystemShellProvider({
              platform,
              env,
              customShellsFile: path.join(dataDir, CUSTOM_SHELLS_FILE_NAME),
              logger,
            }),
          workspaces: {
            resolveWorkingDirectory: (projectId) => projects.resolveAvailableWorkspace(projectId),
          },
          settings: terminalSettings,
          environment: new ShellEnvironment({
            env,
            platform,
            appVersion: terminalOptions.appVersion ?? '0.0.0',
          }),
          clock,
          generateId: randomUUID,
          logger,
          ...(terminalOptions.timing ? { timing: terminalOptions.timing } : {}),
        });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };

  return {
    dataDir,
    databasePath,
    logger,
    projects,
    terminalSettings,
    terminals,
    schemaVersion: () => getSchemaVersion(db),
    initialize: async () => {
      await terminals?.initialize();
    },
    removeProject: async (id) => {
      const project = await projects.getDetails(id);
      await terminals?.removeProjectSessions(project.project.id);
      await projects.remove(project.project.id);
      await terminalSettings.deleteLayout(project.project.id).catch((error: unknown) =>
        logger.warn('Failed to delete terminal layout of removed project', {
          projectId: project.project.id,
          error: describeError(error),
        }),
      );
    },
    shutdown: async () => {
      try {
        await terminals?.shutdown();
      } finally {
        close();
      }
    },
    close,
  };
}
