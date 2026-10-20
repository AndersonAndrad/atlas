import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  CreateProjectInputSchema,
  parseInput,
  type AiSession,
  type AttachTerminalInput,
  type ContextTarget,
  type GitCommitContext,
  type StartAiSessionInput,
  type StartedAiSession,
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
  SqliteContextRepository,
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
import {
  SharedContextService,
  continuationPrompt,
  handoffMarkdown,
  type ResolvedTarget,
} from '@atlas/context';
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
import { ShellPreCommitRunner } from './adapters/shell-pre-commit-runner.js';
import { CUSTOM_SHELLS_FILE_NAME, SystemShellProvider } from './adapters/system-shell-provider.js';
import { DATABASE_FILE_NAME, resolveDataDir } from './data-dir.js';
import {
  GitInspectionService,
  GitOperationCoordinator,
  GitPreferencesStore,
  GitWorkspaceService,
  ProjectGitSettingsStore,
  RepositoryEvidence,
  redactCredentials,
  type CommitChecks,
  type GitExecutor,
  type GitRunner,
  type PreCommitStepRunner,
} from '@atlas/git';
import { createGitExecutor, createGitRunner } from './git/git-runner.js';
import { RepositoryWatcher } from './git/repository-watcher.js';
import { GIT_SHUTDOWN_TIMEOUT_MS } from './shutdown-timing.js';

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
  /** Runs project pre-commit steps; defaults to the user's shell in the Engine host. */
  preCommitRunner?: PreCommitStepRunner;
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
  /** Provider-independent shared context (SDD-005 Milestone A). */
  readonly context: SharedContextService;
  /**
   * Authorizes a context target: an existing project, or a repository root the Engine
   * resolved from a project or terminal. Null (global context) stays null.
   */
  resolveContextTarget(target: ContextTarget): Promise<ResolvedTarget>;
  /** Starts Claude Code or Codex in a new terminal, optionally with a context prompt. */
  startAiSession(input: StartAiSessionInput): Promise<StartedAiSession>;
  /** Tracks an existing terminal as an AI session (best effort, no conversation access). */
  attachTerminalSession(input: AttachTerminalInput): Promise<AiSession>;
  /** Per-project Conventional Commits enforcement and pre-commit steps. */
  readonly projectGitSettings: ProjectGitSettingsStore;
  /** Registered projects of an authorized repository with their commit settings. */
  gitCommitContext(repositoryRoot: string): Promise<GitCommitContext>;
  /**
   * Checks a commit from ATLAS must pass, read from stored settings: the project's when
   * the repository has one (or `projectId` among several), defaults otherwise.
   */
  gitCommitChecks(repositoryRoot: string, projectId?: string): Promise<CommitChecks>;
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
  /**
   * Cancels Git operations that are safe to stop and waits briefly for the rest,
   * terminates terminal processes, then closes the database.
   */
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
  // Steps are user-configured commands; only the Engine host (which owns processes) runs them.
  const preCommitRunner =
    options.preCommitRunner ??
    (terminalOptions === undefined
      ? undefined
      : new ShellPreCommitRunner({
          platform,
          shell: env.SHELL ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'),
          env: new ShellEnvironment({
            env,
            platform,
            appVersion: terminalOptions.appVersion ?? engineVersion,
          }).shellEnvironment(),
        }));
  const gitWorkspace = new GitWorkspaceService({
    exec: options.gitExecutor ?? createGitExecutor({ env }),
    ...(preCommitRunner ? { stepRunner: preCommitRunner } : {}),
    coordinator: gitOperations,
    now: () => clock.now(),
    logger,
    onRepositoryChanged: (repositoryRoot) => {
      git.invalidate(repositoryRoot);
      terminals?.publish({ type: 'git', repositoryRoot });
    },
  });
  const gitPreferences = new GitPreferencesStore(settings, logger);
  const context = new SharedContextService({
    repository: new SqliteContextRepository(db),
    inspector: new RepositoryEvidence(options.gitExecutor ?? createGitExecutor({ env })),
    clock,
    generateId: randomUUID,
    redact: redactCredentials,
    logger,
  });
  const projectGitSettings = new ProjectGitSettingsStore(settings, logger);

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

  /** Projects whose directory still resolves to the (authorized) repository. */
  const repositoryProjects = async (repositoryRoot: string) => {
    const found = [];
    // Discovery may predate a newly registered project in an already known root.
    for (const { project, availability } of await projects.listDetails()) {
      if (availability.status !== 'available') continue;
      const status = await git.inspect(project.workspacePath);
      if (status.state === 'repository' && status.snapshot.repositoryRoot === repositoryRoot) {
        found.push(project);
      }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  };

  const requireGitRepository = async (repositoryRoot: string): Promise<string> => {
    // Re-checking the sources of a known root is cheap (cached inspection) and
    // reflects removed projects and closed terminals immediately.
    const known = knownRepositories.get(repositoryRoot);
    if (known !== undefined && (await stillResolves(known))) return repositoryRoot;
    await discoverRepositories();
    if (!knownRepositories.has(repositoryRoot)) {
      throw new AtlasError('GIT_REPOSITORY_UNAVAILABLE');
    }
    return repositoryRoot;
  };

  const resolveContextTarget = async (target: ContextTarget): Promise<ResolvedTarget> => {
    if ('projectId' in target) {
      const { project } = await projects.getDetails(target.projectId);
      return {
        owner: { projectId: project.id, workspacePath: null },
        directory: project.workspacePath,
        label: project.name,
      };
    }
    const root = await requireGitRepository(target.workspacePath);
    return {
      owner: { projectId: null, workspacePath: root },
      directory: root,
      label: path.basename(root),
    };
  };

  /** Single-quoted for POSIX shells; the prompt file path is the only shell text. */
  const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const promptCommand = (provider: string, file: string | null, shellName: string) => {
    if (file === null) return provider;
    if (/pwsh|powershell/i.test(shellName)) {
      return `${provider} (Get-Content -Raw -LiteralPath '${file.replace(/'/g, "''")}')`;
    }
    return `${provider} "$(cat ${shellQuote(file)})"`;
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
    projectGitSettings,
    gitRepositories: discoverRepositories,
    gitCommitContext: async (repositoryRoot) => ({
      projects: await Promise.all(
        (await repositoryProjects(repositoryRoot)).map(async (project) => {
          const { settings, invalid } = await projectGitSettings.read(project.id);
          return {
            id: project.id,
            name: project.name,
            workspacePath: project.workspacePath,
            settings,
            ...(invalid ? { settingsInvalid: true } : {}),
          };
        }),
      ),
    }),
    gitCommitChecks: async (repositoryRoot, projectId) => {
      const candidates = await repositoryProjects(repositoryRoot);
      const project =
        projectId === undefined
          ? candidates.length === 1
            ? candidates[0]
            : undefined
          : candidates.find((candidate) => candidate.id === projectId);
      if (projectId !== undefined && project === undefined) {
        throw new AtlasError('VALIDATION_FAILED', 'Project is not part of this repository.', {
          issues: [{ field: 'projectId', message: 'Choose a project of this repository.' }],
        });
      }
      if (project === undefined && candidates.length > 1) {
        throw new AtlasError('VALIDATION_FAILED', 'Several projects share this repository.', {
          issues: [{ field: 'projectId', message: 'Choose which project’s commit checks apply.' }],
        });
      }
      if (project === undefined) {
        return { enforceConventionalCommits: true, steps: [], cwd: repositoryRoot };
      }
      const stored = await projectGitSettings.forCommit(project.id);
      return {
        enforceConventionalCommits: stored.enforceConventionalCommits,
        steps: stored.preCommitSteps,
        cwd: project.workspacePath,
      };
    },
    requireGitRepository,
    context,
    resolveContextTarget,
    startAiSession: async (input) => {
      const service = requireTerminals();
      const target = await resolveContextTarget(input.target);
      let prompt: string | null = null;
      if (input.handoffId !== undefined) {
        prompt = continuationPrompt(
          handoffMarkdown(await context.getHandoff(target, input.handoffId), target.label),
        );
      } else if (input.includeContext) {
        const bundle = await context.bundle(target, {
          ...(input.taskId ? { taskId: input.taskId } : {}),
          provider: input.provider,
          budgetTokens: input.budgetTokens ?? 6000,
        });
        prompt = continuationPrompt(bundle.markdown);
      }
      const terminal = await service.create({
        ...(target.owner.projectId !== null
          ? { projectId: target.owner.projectId }
          : { cwd: target.directory }),
        title: input.provider === 'claude' ? 'Claude Code' : 'Codex',
      });
      const session = await context.startSession(target, {
        provider: input.provider,
        captureMode: 'managed',
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.handoffId ? { handoffId: input.handoffId } : {}),
        terminalId: terminal.id,
      });
      let file: string | null = null;
      if (prompt !== null) {
        // The prompt goes through a private file: its content never becomes shell text.
        const directory = path.join(dataDir, 'context', 'prompts');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        file = path.join(directory, `${session.id}.md`);
        await writeFile(file, prompt, { mode: 0o600 });
        await chmod(file, 0o600);
      }
      service.write(terminal.id, `${promptCommand(input.provider, file, terminal.shell.name)}\r`);
      return { session, terminalId: terminal.id, prompt };
    },
    attachTerminalSession: async (input) => {
      const terminal = requireTerminals().getById(input.terminalId);
      const status = await git.inspect(terminal.currentCwd);
      const target =
        terminal.projectId !== null
          ? await resolveContextTarget({ projectId: terminal.projectId })
          : status.state === 'repository'
            ? await resolveContextTarget({ workspacePath: status.snapshot.repositoryRoot })
            : null;
      if (target === null) {
        throw new AtlasError('VALIDATION_FAILED', 'Terminal is not in a project or repository.', {
          issues: [
            {
              field: 'terminalId',
              message: 'Open this terminal in a project or Git repository to track it.',
            },
          ],
        });
      }
      return context.startSession(target, {
        provider: 'external',
        captureMode: 'attached',
        ...(input.taskId ? { taskId: input.taskId } : {}),
        terminalId: terminal.id,
      });
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
      // Shared context stays available through the project's repository.
      const status = await git.inspect(project.workspacePath);
      await context.reassignProject(
        project.id,
        status.state === 'repository' ? status.snapshot.repositoryRoot : project.workspacePath,
      );
      await projects.remove(project.id);
      await projectGitSettings.remove(project.id);
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
      // New Git operations are refused (a push that would follow a finishing commit
      // settles as cancelled), queued ones and running pre-commit steps are cancelled;
      // commits and pushes that cannot be interrupted get a bounded time to finish.
      gitOperations.close();
      if (!(await gitOperations.idle(GIT_SHUTDOWN_TIMEOUT_MS))) {
        logger.warn('Git operations were still running at shutdown');
      }
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
