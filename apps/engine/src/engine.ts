import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  CreateProjectInputSchema,
  parseInput,
  type GitRepositoryEntry,
  type GitStatus,
  type Project,
  type TerminalGitContext,
  type TerminalPreferences,
  type TerminalProjectContext,
  type TerminalSession,
} from '@atlas/contracts';
import {
  SqliteProjectRepository,
  SqliteSessionRepository,
  SqliteSettingsRepository,
  SqliteTerminalGroupRepository,
  SqliteTerminalSessionRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import { ProjectService, toPathPlatform, type Clock, type PathInspector } from '@atlas/projects';
import {
  SessionService,
  SessionSettingsStore,
  type SessionChangeListener,
  type SessionWorkspaces,
} from '@atlas/sessions';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import {
  TerminalGroups,
  TerminalService,
  TerminalSettings,
  type ProcessCwdResolver,
  type PtySpawner,
  type ScreenMirrorFactory,
  type ShellProvider,
  type TerminalTiming,
} from '@atlas/terminal';
import { FileLogger } from './adapters/file-logger.js';
import { HeadlessScreenMirrorFactory } from './adapters/headless-screen-mirror.js';
import { NodePathInspector } from './adapters/node-path-inspector.js';
import { NodePtySpawner } from './adapters/node-pty-spawner.js';
import { OsProcessCwdResolver } from './adapters/process-cwd-resolver.js';
import { ShellEnvironment } from './adapters/shell-environment.js';
import { CUSTOM_SHELLS_FILE_NAME, SystemShellProvider } from './adapters/system-shell-provider.js';
import { DATABASE_FILE_NAME, resolveDataDir } from './data-dir.js';
import {
  GitInspectionService,
  GitOperationCoordinator,
  GitPreferencesStore,
  GitWorkspaceService,
  type GitExecutor,
  type GitRunner,
} from '@atlas/git';
import { createGitExecutor, createGitRunner } from './git/git-runner.js';
import { RepositoryWatcher } from './git/repository-watcher.js';

export interface TerminalRuntimeOptions {
  /** Version reported to shells through TERM_PROGRAM_VERSION. */
  appVersion?: string;
  spawner?: PtySpawner;
  mirrors?: ScreenMirrorFactory;
  shells?: ShellProvider;
  cwdResolver?: ProcessCwdResolver;
  timing?: Partial<TerminalTiming>;
  /** Watch inspected repositories for changes (Engine host only). */
  watchRepositories?: boolean;
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
  /** Runs git commands; defaults to the system `git` executable. */
  gitRunner?: GitRunner;
  /** Runs Git workflow commands (mutations included); defaults to the system `git`. */
  gitExecutor?: GitExecutor;
  /** Version of this Engine build; defaults to the @atlas/engine package version. */
  engineVersion?: string;
  /**
   * Enables the terminal runtime. Only the Engine host process that owns
   * terminal processes enables it; short-lived clients such as the CLI do not.
   */
  terminals?: TerminalRuntimeOptions;
}

export interface Engine {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly logFile: string;
  readonly engineVersion: string;
  readonly logger: Logger;
  readonly projects: ProjectService;
  readonly git: GitInspectionService;
  /** Git workflow (SDD-004): status details, diffs and mutations. */
  readonly gitWorkspace: GitWorkspaceService;
  readonly gitOperations: GitOperationCoordinator;
  readonly gitPreferences: GitPreferencesStore;
  /**
   * Repositories of registered projects and open terminals. Git workflow requests
   * may only target these roots.
   */
  gitRepositories(): Promise<GitRepositoryEntry[]>;
  /** Returns `repositoryRoot` when it is one of `gitRepositories()`, else throws. */
  requireGitRepository(repositoryRoot: string): Promise<string>;
  readonly terminalSettings: TerminalSettings;
  /** Present only when the Engine was created with `terminals`. */
  readonly terminals: TerminalService | undefined;
  /** Present only when the Engine was created with `terminals`. */
  readonly terminalGroups: TerminalGroups | undefined;
  readonly sessions: SessionService;
  readonly sessionSettings: SessionSettingsStore;
  /** Notified whenever a session, its tasks or its history changed in this process. */
  onSessionChanged(listener: SessionChangeListener): () => void;
  schemaVersion(): number;
  /**
   * Prepares asynchronous services. Must complete before terminals are used. The
   * Engine host (created with `terminals`) also reconciles sessions whose work was
   * in flight when a previous host stopped.
   */
  initialize(): Promise<void>;
  /**
   * Removes a project from the registry. Its terminals keep running and its
   * sessions keep their directory, both without the association; files are never
   * touched.
   */
  removeProject(id: string): Promise<void>;
  /** Git state of a registered project's directory. */
  projectGit(projectId: string): Promise<GitStatus>;
  /** Git state following a terminal's current working directory. */
  terminalGit(terminalId: string): Promise<TerminalGitContext>;
  /** Associated and matching registered projects of a terminal. */
  terminalProjectContext(terminalId: string): Promise<TerminalProjectContext>;
  /** Registers the terminal's current directory as a project and associates it. */
  registerProjectFromTerminal(
    terminalId: string,
    input: unknown,
  ): Promise<{ project: Project; session: TerminalSession }>;
  updateTerminalPreferences(input: unknown): Promise<TerminalPreferences>;
  /** Terminates terminal processes, then closes the database. */
  shutdown(): Promise<void>;
  /** Closes the database immediately. Prefer `shutdown` when terminals may run. */
  close(): void;
}

/** Version of the @atlas/engine package when running from its build output. */
function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
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
  const logFile = path.join(dataDir, 'logs', 'atlas.log');
  const engineVersion = options.engineVersion ?? packageVersion();
  const logger =
    options.logger ??
    new FileLogger({ filePath: logFile, component: options.component ?? 'engine' });
  const clock = options.clock ?? { now: () => new Date() };
  const homeDirectory = env.HOME ?? env.USERPROFILE ?? os.homedir();

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
  const git = new GitInspectionService({
    run: options.gitRunner ?? createGitRunner({ env }),
    now: () => clock.now(),
    logger,
  });

  const sessionWorkspaces: SessionWorkspaces = {
    findProject: async (projectId) => {
      const project = await projects.findById(projectId);
      return project === null
        ? null
        : { id: project.id, name: project.name, workspacePath: project.workspacePath };
    },
    resolveDirectory: (directory) => projects.resolveAvailableDirectory(directory),
    isAvailable: async (directory) =>
      (await projects.inspectPath(directory)).availability.status === 'available',
    assertUsable: async (directory) => {
      const resolved = await projects.resolveAvailableDirectory(directory);
      try {
        await access(resolved, constants.R_OK | constants.W_OK | constants.X_OK);
      } catch (error) {
        throw new AtlasError('PROJECT_PERMISSION_DENIED', undefined, {
          cause: error,
          details: { reason: 'workspace-not-writable' },
        });
      }
    },
  };
  const sessions = new SessionService({
    sessions: new SqliteSessionRepository(db),
    workspaces: sessionWorkspaces,
    clock,
    generateId: randomUUID,
    logger,
  });
  const sessionSettings = new SessionSettingsStore(settings, logger);
  // Only the Engine host owns execution state; short-lived clients never reconcile.
  const ownsExecution = options.terminals !== undefined;

  const terminalOptions = options.terminals;
  const groupRepository = new SqliteTerminalGroupRepository(db);
  let terminalGroups: TerminalGroups | undefined;
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
            resolveProjectDirectory: (projectId) => projects.resolveAvailableWorkspace(projectId),
            resolveDirectory: (directory) => projects.resolveAvailableDirectory(directory),
            assertProjectExists: async (projectId) => {
              await projects.getDetails(projectId);
            },
            homeDirectory: () => homeDirectory,
          },
          settings: terminalSettings,
          environment: new ShellEnvironment({
            env,
            platform,
            appVersion: terminalOptions.appVersion ?? engineVersion,
          }),
          cwdResolver: terminalOptions.cwdResolver ?? new OsProcessCwdResolver(platform),
          groupExists: (groupId) => terminalGroups!.exists(groupId),
          // A command may have changed files: drop cached Git state for that directory
          // and tell clients, which re-request it only for terminals they display.
          onCommandSettled: (session) => {
            void git.inspect(session.currentCwd, { fresh: true }).then((status) => {
              if (status.state === 'repository') {
                git.invalidate(status.snapshot.repositoryRoot);
                terminals?.publish({ type: 'git', repositoryRoot: status.snapshot.repositoryRoot });
              }
            });
          },
          clock,
          generateId: randomUUID,
          logger,
          ...(terminalOptions.timing ? { timing: terminalOptions.timing } : {}),
        });
  if (terminals !== undefined) {
    terminalGroups = new TerminalGroups({
      groups: groupRepository,
      terminals,
      settings: terminalSettings,
      clock,
      generateId: randomUUID,
      logger,
    });
  }
  const watcher =
    terminals !== undefined && terminalOptions?.watchRepositories
      ? new RepositoryWatcher({
          git,
          logger,
          onChange: (repositoryRoot) => terminals.publish({ type: 'git', repositoryRoot }),
        })
      : undefined;

  /** Inspects a directory and starts watching its repository for clients. */
  const inspectAndWatch = async (directory: string): Promise<GitStatus> => {
    const status = await git.inspect(directory);
    if (status.state === 'repository') void watcher?.watch(status.snapshot.repositoryRoot);
    return status;
  };

  const gitOperations = new GitOperationCoordinator({
    generateId: randomUUID,
    now: () => clock.now(),
    logger,
    onChange: (operation) => terminals?.publish({ type: 'git-operation', operation }),
  });
  const gitWorkspace = new GitWorkspaceService({
    exec: options.gitExecutor ?? createGitExecutor({ env }),
    coordinator: gitOperations,
    now: () => clock.now(),
    logger,
    onRepositoryChanged: (repositoryRoot) => {
      git.invalidate(repositoryRoot);
      terminals?.publish({ type: 'git', repositoryRoot });
    },
  });
  const gitPreferences = new GitPreferencesStore(settings, logger);

  // Roots resolved by the Engine itself; client-supplied paths are only accepted
  // when they match one of them.
  let knownRepositories = new Map<string, GitRepositoryEntry>();
  const discoverRepositories = async (): Promise<GitRepositoryEntry[]> => {
    const found = new Map<string, GitRepositoryEntry>();
    const add = (status: GitStatus, source: { projectId?: string; terminalId?: string }) => {
      if (status.state !== 'repository') return;
      const root = status.snapshot.repositoryRoot;
      const entry = found.get(root) ?? {
        repositoryRoot: root,
        name: path.basename(root),
        projectIds: [],
        terminalIds: [],
      };
      if (source.projectId !== undefined) entry.projectIds.push(source.projectId);
      if (source.terminalId !== undefined) entry.terminalIds.push(source.terminalId);
      found.set(root, entry);
    };
    const projectList = await projects.listDetails();
    await Promise.all([
      ...projectList
        .filter((details) => details.availability.status === 'available')
        .map(async (details) =>
          add(await inspectAndWatch(details.project.workspacePath), {
            projectId: details.project.id,
          }),
        ),
      ...(terminals?.list() ?? []).map(async (session) =>
        add(await inspectAndWatch(session.currentCwd), { terminalId: session.id }),
      ),
    ]);
    knownRepositories = found;
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  };

  /** Whether a known repository is still the repository of one of its sources. */
  const stillResolves = async (entry: GitRepositoryEntry): Promise<boolean> => {
    const resolvesTo = async (directory: string) => {
      const status = await git.inspect(directory);
      return (
        status.state === 'repository' && status.snapshot.repositoryRoot === entry.repositoryRoot
      );
    };
    for (const projectId of entry.projectIds) {
      const project = await projects.findById(projectId);
      if (project !== null && (await resolvesTo(project.workspacePath))) return true;
    }
    for (const terminalId of entry.terminalIds) {
      const session = terminals?.list().find((candidate) => candidate.id === terminalId);
      if (session !== undefined && (await resolvesTo(session.currentCwd))) return true;
    }
    return false;
  };

  const requireTerminals = (): TerminalService => {
    if (terminals === undefined) {
      throw new AtlasError('ENGINE_UNAVAILABLE', 'Terminal runtime is not enabled.');
    }
    return terminals;
  };

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    watcher?.close();
    db.close();
  };

  return {
    dataDir,
    databasePath,
    logFile,
    engineVersion,
    logger,
    projects,
    git,
    gitWorkspace,
    gitOperations,
    gitPreferences,
    gitRepositories: discoverRepositories,
    requireGitRepository: async (repositoryRoot) => {
      // Re-checking the sources of a known root is cheap (cached inspection) and
      // reflects removed projects and closed terminals immediately.
      const known = knownRepositories.get(repositoryRoot);
      if (known !== undefined && (await stillResolves(known))) return repositoryRoot;
      await discoverRepositories();
      if (!knownRepositories.has(repositoryRoot)) {
        throw new AtlasError('GIT_REPOSITORY_UNAVAILABLE');
      }
      return repositoryRoot;
    },
    terminalSettings,
    terminals,
    terminalGroups,
    sessions,
    sessionSettings,
    onSessionChanged: (listener) => sessions.onChange(listener),
    schemaVersion: () => getSchemaVersion(db),
    initialize: async () => {
      await terminals?.initialize();
      if (ownsExecution) await sessions.reconcile('engine-restart');
    },
    removeProject: async (id) => {
      const { project } = await projects.getDetails(id);
      // Sessions take over the directory before the association is cleared.
      await sessions.detachProject(project.id, project.workspacePath);
      await projects.remove(project.id);
      await terminals?.detachProject(project.id);
    },
    projectGit: async (projectId) => {
      const details = await projects.getDetails(projectId);
      if (details.availability.status !== 'available') {
        return {
          state: 'unavailable',
          reason: 'directory-unavailable',
          inspectedAt: clock.now().toISOString(),
        };
      }
      return inspectAndWatch(details.project.workspacePath);
    },
    terminalGit: async (terminalId) => {
      const session = requireTerminals().getById(terminalId);
      return {
        directory: session.currentCwd,
        cwdSource: session.cwdSource,
        git: await inspectAndWatch(session.currentCwd),
      };
    },
    terminalProjectContext: async (terminalId) => {
      const session = requireTerminals().getById(terminalId);
      const matched = await projects.findContaining(session.currentCwd);
      return {
        associatedProjectId: session.projectId,
        matchedProjectId: matched?.id ?? null,
        directory: session.currentCwd,
        cwdSource: session.cwdSource,
      };
    },
    registerProjectFromTerminal: async (terminalId, input) => {
      const service = requireTerminals();
      const session = service.getById(terminalId);
      // The directory comes from the Engine's own record of the terminal.
      const parsed = parseInput(CreateProjectInputSchema.omit({ workspacePath: true }), input);
      const project = await projects.create({ ...parsed, workspacePath: session.currentCwd });
      const updated = await service.associate(terminalId, project.id);
      return { project, session: updated };
    },
    updateTerminalPreferences: (input) =>
      terminalSettings.updatePreferences(input, (directory) =>
        projects.resolveAvailableDirectory(directory),
      ),
    shutdown: async () => {
      try {
        await terminals?.shutdown();
      } catch (error) {
        logger.error('Failed to stop terminals', { error: describeError(error) });
      }
      try {
        if (ownsExecution) await sessions.reconcile('engine-shutdown');
      } catch (error) {
        logger.error('Failed to reconcile sessions', { error: describeError(error) });
      } finally {
        close();
      }
    },
    close,
  };
}
