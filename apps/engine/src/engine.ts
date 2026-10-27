import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  CreateProjectInputSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
  parseInput,
  type AiSession,
  type AttachTerminalInput,
  type BackgroundWork,
  type ContextTarget,
  type GitCommitContext,
  type GitOperation,
  type StartAiSessionInput,
  type StartedAiSession,
  type GitRepositoryEntry,
  type GitStatus,
  type LlmWrapperStatus,
  type Project,
  type ProjectConfigView,
  type TerminalGitContext,
  type ProjectGitIdentity,
  type TerminalActivitySummary,
  type TerminalLlmUsage,
  type TerminalPreferences,
  type TerminalProjectContext,
  type TerminalSession,
  type RunQuickCommandInput,
  type UpdateProjectAiConfig,
  isFinalTerminalStatus,
} from '@atlas/contracts';
import {
  SqliteProjectRepository,
  SqliteContextRepository,
  SqliteGitOperationLogRepository,
  SqliteSessionRepository,
  SqliteSettingsRepository,
  SqliteSkillRepository,
  SqliteUsageRepository,
  SqlitePreflightRepository,
  SqliteNotificationRepository,
  SqliteNoteRepository,
  SqliteHttpWorkbenchRepository,
  SqliteExtensionRepository,
  SqliteJobRepository,
  SqliteProjectGitRepository,
  SqliteTerminalActivityRepository,
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
  TerminalActivityService,
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
import { ProjectConfigStore, type WRAPPED_CLIS } from './project-config.js';
import {
  GitInspectionService,
  GitOperationCoordinator,
  GitOperationLog,
  GitPreferencesStore,
  GitWorkspaceService,
  GitIdentityService,
  ProjectGitMonitor,
  ProjectGitSettingsStore,
  RepositoryEvidence,
  recordingExecutor,
  redactCredentials,
  type CommitChecks,
  type GitExecutor,
  type GitRunner,
  type PreCommitStepRunner,
} from '@atlas/git';
import { NodeSkillFileSystem, SkillsHub } from '@atlas/skills';
import { UsageService } from '@atlas/usage';
import { LogBuffer, PreflightService } from '@atlas/preflight';
import {
  NotificationService,
  backgroundJobNotification,
  gitOperationNotification,
  preflightRunNotification,
} from '@atlas/notifications';
import { NotesService } from '@atlas/notes';
import { JobService } from '@atlas/jobs';
import { DockerService } from '@atlas/docker';
import { DockerCliRunner } from './adapters/docker-cli.js';
import { HttpWorkbenchService } from '@atlas/api-workbench';
import { ExtensionsService, TESTED_EXTENSIONS } from '@atlas/extensions';
import { DebugSessionManager } from '@atlas/debugger';
import {
  NodeDebugFileSystem,
  ProcessTreeAdapterLauncher,
} from './adapters/debug-adapter-process.js';
import { FileExtensionPackages } from './adapters/extension-packages.js';
import { OPEN_VSX_URL, OpenVsxRegistry } from './adapters/open-vsx-registry.js';
import { MemoryCookieJars } from './adapters/http-cookies.js';
import { FileHttpResponses } from './adapters/http-response-files.js';
import { NodeHttpTransport } from './adapters/http-transport.js';
import { CommandJobExecutor } from './jobs/command-executor.js';
import { PreflightJobExecutor } from './jobs/preflight-executor.js';
import { EditorSettings, FileWatchHub, ProjectFiles } from '@atlas/editor';
import { createGitExecutor, createGitRunner } from './git/git-runner.js';
import { captureLoginShellEnvironment } from './adapters/login-shell-environment.js';
import { LlmSessionTracker } from './llm-session-tracker.js';
import { ClaudeAuthStatusReader, CodexAppServerReader } from './adapters/usage-cli.js';
import { ClaudeStatusInbox } from './usage-inbox.js';
import { ShellPreflightExecutor } from './adapters/preflight-executor.js';
import { GitSourceStateReader } from './adapters/preflight-source.js';
import { FilePreflightLogStore, NodeWorkspaceFileAccess } from './adapters/preflight-storage.js';
import { ActDockerTools } from './adapters/preflight-tools.js';
import { QuickCommandStore } from './quick-commands.js';
import { RepositoryWatcher } from './git/repository-watcher.js';
import { GIT_SHUTDOWN_TIMEOUT_MS } from './shutdown-timing.js';
import { GitJobExecutor } from './jobs/git-executor.js';

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
  /** Persistent log of Git operations and their commands (PLAN-016). */
  readonly gitOperationLog: GitOperationLog;
  /** Skills Hub (SDD-006 Milestone B). */
  readonly skills: SkillsHub;
  /** Account profiles, provider limits and daily usage (SDD-008 Milestone B). */
  readonly usage: UsageService;
  /** Local validation of projects and folders (SDD-007 Milestone A). */
  readonly preflight: PreflightService;
  /** Notification center (SDD-009 Milestone A). */
  readonly notifications: NotificationService;
  /** Project Hub notes (SDD-010 Milestone A). */
  readonly notes: NotesService;
  /** Background jobs (SDD-012 Milestone A); they run only in the Engine host. */
  readonly jobs: JobService;
  /** Docker through the Docker CLI (SDD-013 Milestone A); optional, never required. */
  readonly docker: DockerService;
  /** HTTP requests, collections and history (SDD-014 Milestone A); desktop only. */
  readonly http: HttpWorkbenchService;
  /** Extensions Hub and declarative contributions (SDD-015 Milestone A); desktop only. */
  readonly extensions: ExtensionsService;
  /** Debug Adapter Protocol sessions (SDD-016 Task 01); desktop only, no adapters yet. */
  readonly debug: DebugSessionManager;
  /** Opens an ATLAS terminal with a shell in a running container (FR-1308). */
  openContainerTerminal(input: unknown): Promise<TerminalSession>;
  /** Files of registered projects for the code editor (SDD-011 Milestone A). */
  readonly files: ProjectFiles;
  readonly editorSettings: EditorSettings;
  /** Work that stops when the Engine stops; the desktop asks before quitting. */
  backgroundWork(): BackgroundWork;
  /** Automatic recording of LLM sessions in ATLAS terminals (PLAN-021). */
  readonly llmSessions: LlmSessionTracker;
  /** The user's quick commands and each project's choice of them (PLAN-023). */
  readonly quickCommands: QuickCommandStore;
  /** Opens a terminal in the project and types the quick command there (PLAN-023). */
  runQuickCommand(input: RunQuickCommandInput): Promise<TerminalSession>;
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
  /** Per-project AI configuration files in the ATLAS data directory (PLAN-014). */
  readonly projectConfig: ProjectConfigStore;
  /** A project's configuration file (created with defaults) and its LLM wrapper status. */
  projectConfigView(projectId: string): Promise<ProjectConfigView>;
  /** Updates a project's AI options and writes or removes its context file. */
  setProjectConfig(projectId: string, changes: UpdateProjectAiConfig): Promise<ProjectConfigView>;
  /**
   * Regenerates the context file of the projects a context change affects (all projects
   * keeping context for global changes). Failures are logged, never thrown.
   */
  contextChanged(target: ResolvedTarget | null): Promise<void>;
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
  /** Registers a project; Git monitoring follows the new-project default (SDD-024). */
  createProject(input: CreateProjectInput): Promise<Project>;
  /** Updates a project; a new folder drops its stored Git snapshot. */
  updateProject(id: string, input: UpdateProjectInput): Promise<Project>;
  /** Per-project Git monitoring and stored snapshots (SDD-024). */
  readonly projectGitMonitor: ProjectGitMonitor;
  /** Global Git author identity (SDD-024 Task 03). */
  readonly gitIdentity: GitIdentityService;
  /** The identity Git uses in a project's repository, its overrides and shell variables. */
  projectGitIdentity(projectId: string): Promise<ProjectGitIdentity>;
  /** Sets or removes the project repository's own `user.name` / `user.email`. */
  setProjectGitIdentity(projectId: string, input: unknown): Promise<ProjectGitIdentity>;
  /** Git state following a terminal's current working directory. */
  terminalGit(terminalId: string): Promise<TerminalGitContext>;
  /** The LLM open in the terminal and its session window (PLAN-031); null when none. */
  terminalLlmUsage(terminalId: string): Promise<TerminalLlmUsage | null>;
  /** Tracked activity of every terminal that has some (SDD-023 Task A02). */
  terminalActivities(): Promise<TerminalActivitySummary[]>;
  /** Explicit "Mark as reviewed": acknowledges the terminal's finished results. */
  markTerminalReviewed(terminalId: string): Promise<TerminalActivitySummary>;
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

/** Size of a project's context file for LLMs, in estimated tokens. */
const CONTEXT_FILE_BUDGET_TOKENS = 12_000;
/** How long a wrapper check (an interactive shell start) is reused. */
const WRAPPER_CHECK_TTL_MS = 60_000;
/** Usage collection checks which profiles are due this often (PLAN-027). */
const USAGE_SCHEDULE_MS = 60_000;

/** Version of the @atlas/engine package when running from its build output. */
function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/** The Open VSX name of this machine's platform, e.g. `darwin-arm64` (FR-1503). */
export function openVsxPlatform(platform: string, arch: string): string {
  const system = platform === 'win32' || platform === 'darwin' ? platform : 'linux';
  const cpu = arch === 'arm' ? 'armhf' : arch;
  return `${system}-${cpu}`;
}

/**
 * Open VSX, or the registry named by ATLAS_EXTENSIONS_REGISTRY_URL (used by the tests). An
 * invalid value falls back to Open VSX.
 */
function extensionRegistry(
  override: string | undefined,
  engineVersion: string,
  logger: Logger,
): OpenVsxRegistry {
  const userAgent = `ATLAS/${engineVersion}`;
  if (override) {
    try {
      const registry = new OpenVsxRegistry(override, userAgent);
      logger.warn('Extensions use the registry from ATLAS_EXTENSIONS_REGISTRY_URL');
      return registry;
    } catch {
      logger.warn('Ignoring an invalid ATLAS_EXTENSIONS_REGISTRY_URL');
    }
  }
  return new OpenVsxRegistry(OPEN_VSX_URL, userAgent);
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
  const projectConfig = new ProjectConfigStore({
    dataDir,
    platform,
    now: () => clock.now(),
    logger,
  });
  // Set below, once the context service exists; terminals start after initialization.
  let refreshProjectFiles: (projectId: string) => Promise<void> = async () => undefined;
  /** Tells clients and project monitoring that a repository may have changed (SDD-024). */
  let repositoryChanged: (repositoryRoot: string) => void = () => undefined;
  const terminalEnvironment =
    terminalOptions === undefined
      ? undefined
      : new ShellEnvironment({
          env,
          platform,
          appVersion: terminalOptions.appVersion ?? engineVersion,
          terminalVariables: (terminal, base) => {
            // Creates the project's config file (and context file) for LLMs started here.
            if (terminal.projectId !== null) void refreshProjectFiles(terminal.projectId);
            return projectConfig.terminalVariables(terminal, base);
          },
        });
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
          environment: terminalEnvironment!,
          cwdResolver: terminalOptions.cwdResolver ?? new OsProcessCwdResolver(platform),
          groupExists: (groupId) => terminalGroups!.exists(groupId),
          // A command may have changed files: drop cached Git state for that directory
          // and tell clients, which re-request it only for terminals they display.
          onCommandSettled: (session) => {
            void git.inspect(session.currentCwd, { fresh: true }).then((status) => {
              if (status.state === 'repository') {
                git.invalidate(status.snapshot.repositoryRoot);
                repositoryChanged(status.snapshot.repositoryRoot);
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
          onChange: (repositoryRoot, cause) => {
            // The periodic fallback only refreshes clients: monitored projects have their
            // own adaptive schedule.
            if (cause === 'watch') repositoryChanged(repositoryRoot);
            else terminals.publish({ type: 'git', repositoryRoot });
          },
        })
      : undefined;

  /**
   * Inspects a directory and, unless `watch` is false, starts watching its repository for
   * clients. Projects with Git monitoring off are not watched (SDD-024 FR-004).
   */
  const inspectAndWatch = async (directory: string, watch = true): Promise<GitStatus> => {
    const status = await git.inspect(directory);
    if (watch && status.state === 'repository') {
      void watcher?.watch(status.snapshot.repositoryRoot);
    }
    return status;
  };

  // Per-project Git monitoring with persisted snapshots (SDD-024 Task 01).
  const projectGitMonitor = new ProjectGitMonitor({
    store: new SqliteProjectGitRepository(db),
    inspect: (directory, fresh) => git.inspect(directory, { fresh }),
    pendingCommits: (root, branch, headOid, page) =>
      git.pendingCommits(root, branch, headOid, page),
    projectDirectory: async (projectId) => {
      if ((await projects.findById(projectId)) === null) return { status: 'removed' };
      const { project, availability } = await projects.getDetails(projectId);
      return availability.status === 'available'
        ? { status: 'available', directory: project.workspacePath }
        : { status: 'unavailable' };
    },
    ...(watcher !== undefined
      ? {
          watch: (root: string) => void watcher.watch(root),
          unwatch: (root: string) => watcher.unwatch(root),
        }
      : {}),
    onChange: (state) => terminals?.publish({ type: 'project-git', state }),
    now: () => clock.now(),
    logger,
  });
  repositoryChanged = (repositoryRoot) => {
    terminals?.publish({ type: 'git', repositoryRoot });
    projectGitMonitor.repositoryChanged(repositoryRoot);
  };

  const gitOperationLog = new GitOperationLog({
    store: new SqliteGitOperationLogRepository(db),
    settings,
    now: () => clock.now(),
    logger,
  });
  const notifications = new NotificationService({
    repository: new SqliteNotificationRepository(db),
    clock,
    generateId: randomUUID,
    logger,
    onChange: (created) => terminals?.publish({ type: 'notifications', created }),
  });
  /** Project of a known repository, from the last discovery (no Git command runs). */
  const repositorySource = async (repositoryRoot: string) => {
    const projectId = knownRepositories.get(repositoryRoot)?.projectIds[0] ?? null;
    const project = projectId === null ? null : await projects.findById(projectId);
    return {
      projectId: project?.id ?? null,
      sourceName: project?.name ?? path.basename(repositoryRoot),
    };
  };
  /** Finished operations already reported, so a repeated change never notifies twice. */
  const notifiedOperations = new Set<string>();
  const notifyGitOperation = async (operation: GitOperation) => {
    if (notifiedOperations.has(operation.id)) return;
    notifiedOperations.add(operation.id);
    if (notifiedOperations.size > 500) {
      notifiedOperations.delete(notifiedOperations.values().next().value!);
    }
    const input = gitOperationNotification(
      operation,
      await repositorySource(operation.repositoryRoot),
    );
    if (input !== null) await notifications.publish(input);
  };
  const gitOperations = new GitOperationCoordinator({
    generateId: randomUUID,
    now: () => clock.now(),
    logger,
    journal: gitOperationLog,
    onChange: (operation) => {
      terminals?.publish({ type: 'git-operation', operation });
      // Only clients that own processes report background work; the CLI's are its own.
      if (ownsExecution && operation.finishedAt !== null) {
        void notifyGitOperation(operation).catch((error: unknown) =>
          logger.warn('Git notification failed', { error: describeError(error) }),
        );
      }
    },
  });
  const userShell = env.SHELL ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  // Commits start from what a new terminal starts from (`terminalEnvironment` above) and
  // read the rest from the user's shell (PLAN-018).
  // Steps are user-configured commands; only the Engine host (which owns processes) runs them.
  const preCommitRunner =
    options.preCommitRunner ??
    (terminalEnvironment === undefined
      ? undefined
      : new ShellPreCommitRunner({
          platform,
          shell: userShell,
          env: terminalEnvironment.shellEnvironment(),
        }));
  /** Every commit and push reads the environment a new terminal would have now. */
  const commitEnvironment =
    terminalEnvironment === undefined
      ? undefined
      : async (repositoryRoot: string) => {
          const base = terminalEnvironment.shellEnvironment();
          try {
            const fresh = await captureLoginShellEnvironment({
              shell: userShell,
              platform,
              env: base,
              cwd: repositoryRoot,
            });
            return { env: fresh, warning: null };
          } catch (error) {
            logger.warn('Shell environment unavailable for a commit; using ATLAS defaults', {
              error: describeError(error),
            });
            return {
              env: base,
              warning: "your shell's environment could not be read; ATLAS's was used",
            };
          }
        };
  const gitExecutor = options.gitExecutor ?? createGitExecutor({ env });
  const gitWorkspace = new GitWorkspaceService({
    // Commands run inside an operation are recorded in the operation log.
    exec: recordingExecutor(gitExecutor, gitOperations, gitOperationLog, () => clock.now()),
    ...(preCommitRunner ? { stepRunner: preCommitRunner } : {}),
    ...(commitEnvironment ? { commitEnvironment } : {}),
    coordinator: gitOperations,
    now: () => clock.now(),
    logger,
    // Stage, commit and push refresh project monitoring at once (SDD-024 Task 02).
    onRepositoryChanged: (repositoryRoot) => {
      git.invalidate(repositoryRoot);
      repositoryChanged(repositoryRoot);
    },
  });
  const gitPreferences = new GitPreferencesStore(settings, logger);
  // Author identity in Git's configuration (SDD-024 Task 03).
  const gitIdentity = new GitIdentityService({
    exec: gitExecutor,
    homeDirectory,
    ...(commitEnvironment === undefined
      ? {}
      : {
          // The variables new terminals get: they decide the identity of commits made there.
          shellEnvironment: async (directory: string) => {
            const shell = await commitEnvironment(directory);
            return shell.warning === null ? shell.env : null;
          },
        }),
    onChanged: (repositoryRoot) => {
      if (repositoryRoot === null) {
        git.invalidate();
        return;
      }
      git.invalidate(repositoryRoot);
      repositoryChanged(repositoryRoot);
    },
  });
  /** The repository of a project, resolved by the Engine (never a client path). */
  const projectRepositoryRoot = async (projectId: string): Promise<string> => {
    const { project, availability } = await projects.getDetails(projectId);
    if (availability.status !== 'available') throw new AtlasError('GIT_REPOSITORY_UNAVAILABLE');
    const status = await git.inspect(project.workspacePath, { fresh: true });
    if (status.state !== 'repository') throw new AtlasError('GIT_REPOSITORY_UNAVAILABLE');
    return status.snapshot.repositoryRoot;
  };
  const skills = new SkillsHub({
    repository: new SqliteSkillRepository(db),
    fs: new NodeSkillFileSystem(env),
    storageRoot: path.join(dataDir, 'skills'),
    suggestions: { home: homeDirectory, claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? null },
    settings,
    clock,
    generateId: randomUUID,
    logger,
  });
  const context = new SharedContextService({
    repository: new SqliteContextRepository(db),
    inspector: new RepositoryEvidence(options.gitExecutor ?? createGitExecutor({ env })),
    clock,
    generateId: randomUUID,
    redact: redactCredentials,
    settings,
    skills: async (request) =>
      (
        await skills.resolve({
          ...(request.projectId ? { projectId: request.projectId } : {}),
          role: request.role,
          provider: request.provider,
          sessionSkillIds: request.skillIds,
        })
      )
        .filter((skill) => skill.active)
        .map((skill) => ({
          skillId: skill.skillId,
          name: skill.name,
          description: skill.description,
          version: skill.version,
          skillFile: skill.skillFile,
          reason: skill.reason,
        })),
    logger,
  });
  /** Folder of a registered project, without checking it is reachable. */
  const projectWorkspace = async (projectId: string): Promise<string> => {
    const project = await projects.findById(projectId);
    if (project === null) {
      throw new AtlasError('PROJECT_NOT_FOUND', undefined, { details: { projectId } });
    }
    return project.workspacePath;
  };
  const notes = new NotesService({
    repository: new SqliteNoteRepository(db),
    clock,
    generateId: randomUUID,
    logger,
    onChange: (noteId) => terminals?.publish({ type: 'notes', noteId }),
    links: {
      projectWorkspace,
      sessionTitle: async (id) => {
        try {
          return (await sessions.get(id)).name;
        } catch (error) {
          if (error instanceof AtlasError && error.code === 'SESSION_NOT_FOUND') return null;
          throw error;
        }
      },
      branchNames: async (projectId) => {
        const status = await git.inspect(await projectWorkspace(projectId));
        if (status.state !== 'repository') return new Set();
        const branches = await gitWorkspace.branches(status.snapshot.repositoryRoot);
        return new Set(branches.local.map((branch) => branch.name));
      },
      // Symbolic links are resolved first, so a link cannot point outside the folder.
      resolveFile: async (projectId, relativePath) => {
        try {
          const root = await realpath(await projectWorkspace(projectId));
          const target = await realpath(path.join(root, ...relativePath.split('/')));
          return target === root || target.startsWith(root + path.sep) ? target : null;
        } catch (error) {
          if (error instanceof AtlasError) throw error;
          return null;
        }
      },
    },
  });
  const fileWatcher = new FileWatchHub({
    logger,
    onChange: (projectId, paths) => terminals?.publish({ type: 'files', projectId, paths }),
  });
  const files = new ProjectFiles({
    workspaces: { projectRoot: projectWorkspace },
    watcher: fileWatcher,
    logger,
    ignore: {
      // Names go through standard input (any character is safe); exit code 1: none ignored.
      ignored: async (directory, names) => {
        const result = await gitExecutor(['check-ignore', '-z', '--stdin'], {
          cwd: directory,
          timeoutMs: 10_000,
          input: `${names.join('\0')}\0`,
          okExitCodes: [0, 1, 128],
        });
        if (result.exitCode === 128) return null;
        return new Set(result.stdout.split('\0').filter((name) => name !== ''));
      },
      files: async (root) => {
        const result = await gitExecutor(
          ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
          { cwd: root, timeoutMs: 15_000, okExitCodes: [0, 128], maxOutputBytes: 8 * 1024 * 1024 },
        );
        if (result.exitCode === 128) return null;
        const paths = [...new Set(result.stdout.split('\0').filter((entry) => entry !== ''))];
        // A cut output ends with a partial path.
        if (result.truncated) paths.pop();
        return { paths, truncated: result.truncated };
      },
    },
    // Saving, creating and moving change the Git status the other views show (Scenario A).
    onChanged: (projectRoot) => {
      void git
        .inspect(projectRoot)
        .then((status) => {
          if (status.state !== 'repository') return;
          git.invalidate(status.snapshot.repositoryRoot);
          repositoryChanged(status.snapshot.repositoryRoot);
        })
        .catch((error: unknown) =>
          logger.debug('Git refresh after a file change failed', { error: describeError(error) }),
        );
    },
  });
  const editorSettings = new EditorSettings(settings, logger);
  // Provider CLIs are found on the Engine's PATH, then on the user's login shell PATH
  // (a desktop app started from the Dock or a launcher has a minimal PATH).
  let loginShellPath: Promise<string> | null = null;
  const cliSearchPath = async () => {
    loginShellPath ??= captureLoginShellEnvironment({
      shell: userShell,
      platform,
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      cwd: homeDirectory,
    })
      .then((fresh) => fresh.PATH ?? '')
      .catch(() => {
        // Read again next time: start-up files can be slow once (PLAN-018 R2).
        loginShellPath = null;
        return '';
      });
    return [env.PATH ?? '', await loginShellPath].filter(Boolean).join(path.delimiter);
  };
  const usageCli = {
    env,
    home: homeDirectory,
    searchPath: cliSearchPath,
    excludeDirectory: projectConfig.binDir,
  };
  const usage = new UsageService({
    repository: new SqliteUsageRepository(db),
    settings,
    codex: new CodexAppServerReader(usageCli),
    claudeAuth: new ClaudeAuthStatusReader(usageCli),
    home: homeDirectory,
    env,
    listHomeDirectories: async () => {
      try {
        return (await readdir(homeDirectory, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    isDirectory: async (directory) =>
      (await stat(directory).catch(() => null))?.isDirectory() ?? false,
    clock,
    generateId: randomUUID,
    logger,
    // Only the Engine host writes the file the wrappers read.
    onProfilesChanged: (profiles) => {
      if (!ownsExecution) return;
      void projectConfig
        .writeStatusLineOff(UsageService.statusLineDisabled(profiles))
        .catch((error: unknown) =>
          logger.warn('Status line settings could not be written', { error: describeError(error) }),
        );
    },
  });
  const usageInbox = new ClaudeStatusInbox({
    directory: path.join(projectConfig.usageDir, 'claude'),
    usage,
    now: () => clock.now(),
    logger,
    onChange: () => terminals?.publish({ type: 'llm-usage' }),
  });
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  const collectUsage = () =>
    void usage
      .refreshDue()
      .catch((error: unknown) =>
        logger.warn('Usage collection failed', { error: describeError(error) }),
      );
  const preflightSearch = {
    platform,
    searchPath: cliSearchPath,
    excludeDirectory: projectConfig.binDir,
  };
  // Checks and command jobs are processes: only the Engine host, which owns processes,
  // runs them.
  const processRunner =
    ownsExecution && terminalEnvironment !== undefined
      ? new ShellPreflightExecutor({
          ...preflightSearch,
          shell: userShell,
          env: terminalEnvironment.shellEnvironment(),
          dataDir,
        })
      : undefined;
  const preflight = new PreflightService({
    repository: new SqlitePreflightRepository(db),
    files: new NodeWorkspaceFileAccess(),
    ...(processRunner === undefined ? {} : { executor: processRunner }),
    tools: new ActDockerTools({ ...preflightSearch, env, home: homeDirectory }),
    source: new GitSourceStateReader(env),
    logs: new FilePreflightLogStore(path.join(dataDir, 'preflight', 'logs')),
    projects: {
      find: async (projectId) => {
        try {
          return (await projects.getDetails(projectId)).project;
        } catch (error) {
          if (error instanceof AtlasError && error.code === 'PROJECT_NOT_FOUND') return null;
          throw error;
        }
      },
    },
    redact: redactCredentials,
    clock,
    generateId: randomUUID,
    logger,
    onRunFinished: (run, workspace) => {
      const input = preflightRunNotification(run, {
        projectId: run.projectId,
        sourceName: workspace.name,
      });
      if (input !== null) void notifications.publish(input);
      // A queued job may have waited for this workspace.
      jobs.resourceReleased();
    },
  });
  // Push, pull and fetch confirmed in their dialogs run as jobs (SDD-025 Task 01).
  const gitJobs = new GitJobExecutor({
    git: gitWorkspace,
    resolveRepository: (root) => requireGitRepository(root),
    projectOf: async (root) => (await repositoryProjects(root))[0] ?? null,
    cancelOperation: (operationId) => void gitOperations.cancel(operationId),
    operationDetails: (operationId) => gitOperationLog.details(operationId),
    shutdownGraceMs: GIT_SHUTDOWN_TIMEOUT_MS,
  });
  const jobs = new JobService({
    repository: new SqliteJobRepository(db),
    ...(processRunner === undefined
      ? { executors: [gitJobs] }
      : {
          executors: [
            gitJobs,
            new CommandJobExecutor({
              runner: processRunner,
              projects: {
                find: async (projectId) => {
                  try {
                    const details = await projects.getDetails(projectId);
                    return {
                      ...details.project,
                      available: details.availability.status === 'available',
                    };
                  } catch (error) {
                    if (error instanceof AtlasError && error.code === 'PROJECT_NOT_FOUND') {
                      return null;
                    }
                    throw error;
                  }
                },
              },
              logs: new FilePreflightLogStore(path.join(dataDir, 'jobs', 'logs')),
              redact: redactCredentials,
              logger,
            }),
            new PreflightJobExecutor(preflight),
          ],
        }),
    settings,
    clock,
    generateId: randomUUID,
    logger,
  });
  jobs.subscribe((job) => terminals?.publish({ type: 'jobs', job }));
  jobs.onFinished((job) => {
    void (async () => {
      const project = job.projectId === null ? null : await projects.findById(job.projectId);
      const input = backgroundJobNotification(job, {
        projectId: project?.id ?? null,
        sourceName: project?.name ?? 'ATLAS',
      });
      if (input !== null) await notifications.publish(input);
    })().catch((error: unknown) =>
      logger.warn('Background job notification failed', { error: describeError(error) }),
    );
  });
  const docker = new DockerService({
    runner: new DockerCliRunner({ searchPath: cliSearchPath, env, platform }),
    settings,
    createLogLines: () => new LogBuffer(redactCredentials),
    redact: redactCredentials,
    homeDirectory,
    clock,
    generateId: randomUUID,
    logger,
    onChange: (context, containerId) =>
      terminals?.publish({ type: 'docker', context, containerId }),
  });
  const http = new HttpWorkbenchService({
    repository: new SqliteHttpWorkbenchRepository(db),
    transport: new NodeHttpTransport(),
    cookies: new MemoryCookieJars(),
    responses: new FileHttpResponses(path.join(dataDir, 'http', 'responses')),
    projectExists: async (projectId) => (await projects.findById(projectId)) !== null,
    userAgent: `ATLAS/${engineVersion}`,
    clock,
    generateId: randomUUID,
    logger,
  });
  const extensions = new ExtensionsService({
    repository: new SqliteExtensionRepository(db),
    registry: extensionRegistry(env.ATLAS_EXTENSIONS_REGISTRY_URL, engineVersion, logger),
    packages: new FileExtensionPackages(path.join(dataDir, 'extensions')),
    projectExists: async (projectId) => (await projects.findById(projectId)) !== null,
    platform: openVsxPlatform(platform, process.arch),
    tested: TESTED_EXTENSIONS,
    clock,
    logger,
  });
  const debug = new DebugSessionManager({
    launcher: new ProcessTreeAdapterLauncher(env, platform),
    fileSystem: new NodeDebugFileSystem(),
    projectPath: async (projectId) => (await projects.findById(projectId))?.workspacePath ?? null,
    clock,
    generateId: randomUUID,
    logger,
  });
  debug.onEvent((ownerId, event) => terminals?.publish({ type: 'debug', ownerId, event }));
  const projectGitSettings = new ProjectGitSettingsStore(settings, logger);
  const quickCommands = new QuickCommandStore({ store: settings, generateId: randomUUID, logger });

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
    const [projectList, gitStates] = await Promise.all([
      projects.listDetails(),
      projectGitMonitor.states(),
    ]);
    const monitored = new Set(
      gitStates.filter((state) => state.monitoringEnabled).map((state) => state.projectId),
    );
    await Promise.all([
      ...projectList
        .filter((details) => details.availability.status === 'available')
        .map(async (details) =>
          add(
            await inspectAndWatch(details.project.workspacePath, monitored.has(details.project.id)),
            { projectId: details.project.id },
          ),
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

  // Project files for LLMs (PLAN-014) ------------------------------------------------

  /** Writes the project's config file and keeps its context file in line with keepContext. */
  const writeProjectFiles = async (projectId: string): Promise<void> => {
    const project = await projects.findById(projectId);
    if (project === null) return;
    const config = await projectConfig.ensure(project);
    if (!config.keepContext) {
      if (config.context.updatedAt !== null) await projectConfig.writeContext(project, null);
      return;
    }
    const target = await resolveContextTarget({ projectId });
    const bundle = await context.bundle(target, {
      provider: 'generic',
      budgetTokens: CONTEXT_FILE_BUDGET_TOKENS,
    });
    await projectConfig.writeContext(
      project,
      `<!-- Generated by ATLAS from the shared context of ${project.name}. Changes here are overwritten. -->\n\n${bundle.markdown}\n`,
    );
  };

  // One refresh per project at a time; changes during a refresh trigger one more.
  const projectRefreshes = new Map<string, { running: Promise<void>; again: boolean }>();
  refreshProjectFiles = (projectId) => {
    const current = projectRefreshes.get(projectId);
    if (current !== undefined) {
      current.again = true;
      return current.running;
    }
    const state = { running: Promise.resolve(), again: true };
    state.running = (async () => {
      while (state.again) {
        state.again = false;
        try {
          await writeProjectFiles(projectId);
        } catch (error) {
          logger.warn('Failed to update project context files', {
            projectId,
            error: describeError(error),
          });
        }
      }
      projectRefreshes.delete(projectId);
    })();
    projectRefreshes.set(projectId, state);
    return state.running;
  };

  const contextChanged = async (target: ResolvedTarget | null): Promise<void> => {
    if (target !== null) {
      if (target.owner.projectId !== null) await refreshProjectFiles(target.owner.projectId);
      return;
    }
    // Global context appears in every project's file.
    const all = await projects.listDetails();
    const keeping = await Promise.all(
      all.map(async ({ project }) =>
        (await projectConfig.read(project.id))?.keepContext ? project : null,
      ),
    );
    await Promise.all(
      keeping
        .filter((project) => project !== null)
        .map((project) => refreshProjectFiles(project.id)),
    );
  };

  // LLM sessions in ATLAS terminals are recorded automatically (PLAN-021).
  // Tab status from explicit lifecycle events (SDD-023 Task A02).
  const terminalActivity = new TerminalActivityService({
    store: new SqliteTerminalActivityRepository(db),
    now: () => clock.now(),
    onChange: (summary) => terminals?.publish({ type: 'terminal-activity', summary }),
    logger,
  });
  const llmSessions = new LlmSessionTracker({
    eventsDir: projectConfig.eventsDir,
    projectDir: (projectId) => projectConfig.paths(projectId).dir,
    keepsContext: async (projectId) => (await projectConfig.read(projectId))?.keepContext === true,
    resolveProject: (projectId) => resolveContextTarget({ projectId }),
    context,
    changed: (target) => contextChanged(target),
    onEvent: async (event) => {
      // Wrappers started outside ATLAS terminals have no tab to show it on.
      if (event.terminalId === '' || terminals === undefined) return;
      const contextSessionId =
        (await context.sessionForTerminal(event.terminalId).catch(() => null))?.id ?? null;
      const lifecycle = {
        terminalId: event.terminalId,
        provider: event.provider,
        run: event.run,
        contextSessionId,
      };
      if (event.event === 'start') await terminalActivity.aiStarted(lifecycle);
      else await terminalActivity.aiEnded({ ...lifecycle, exitCode: event.exitCode });
    },
    logger,
  });
  /**
   * Terminals do not survive a restart: sessions they hosted can no longer report their
   * end, so they are closed with what Git shows changed.
   */
  const closeOrphanedLlmSessions = async () => {
    const running = new Set(
      (terminals?.list() ?? [])
        .filter((terminal) => !isFinalTerminalStatus(terminal.status))
        .map((terminal) => terminal.id),
    );
    for (const { project } of await projects.listDetails()) {
      try {
        const target = await resolveContextTarget({ projectId: project.id });
        for (const session of await context.listSessions(target)) {
          if (session.status !== 'active' || session.terminalId === null) continue;
          if (running.has(session.terminalId)) continue;
          await context.endSession(
            target,
            session.id,
            { summary: '', completed: [], pending: [], decisions: [], nextActions: [] },
            'atlas',
            { automatic: true },
          );
          await contextChanged(target);
        }
      } catch (error) {
        logger.warn('Orphaned AI sessions could not be closed', {
          projectId: project.id,
          error: describeError(error),
        });
      }
    }
  };

  const wrapperChecks = new Map<
    string,
    { at: number; wrappers: Record<(typeof WRAPPED_CLIS)[number], LlmWrapperStatus> }
  >();
  /** Where `claude` and `codex` resolve in the project's ATLAS terminals (cached briefly). */
  const wrapperStatus = async (project: Project, directory: string) => {
    const cached = wrapperChecks.get(project.id);
    if (cached !== undefined && Date.now() - cached.at < WRAPPER_CHECK_TTL_MS) {
      return cached.wrappers;
    }
    if (terminalEnvironment === undefined) return { claude: 'unknown', codex: 'unknown' } as const;
    const base = terminalEnvironment.shellEnvironment();
    const wrappers = await projectConfig.checkWrappers(
      env.SHELL ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'),
      {
        ...base,
        ...projectConfig.terminalVariables({ projectId: project.id, cwd: directory }, base),
      },
      directory,
    );
    wrapperChecks.set(project.id, { at: Date.now(), wrappers });
    return wrappers;
  };

  const projectConfigView = async (projectId: string): Promise<ProjectConfigView> => {
    const { project, availability } = await projects.getDetails(projectId);
    await refreshProjectFiles(project.id);
    const config = await projectConfig.ensure(project);
    return {
      config,
      configPath: projectConfig.paths(project.id).config,
      wrappers: await wrapperStatus(
        project,
        availability.status === 'available' ? project.workspacePath : homeDirectory,
      ),
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
    projectGitMonitor.close();
    watcher?.close();
    fileWatcher.close();
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
    gitOperationLog,
    skills,
    usage,
    preflight,
    notifications,
    notes,
    jobs,
    docker,
    http,
    extensions,
    debug,
    openContainerTerminal: async (input) => {
      const service = requireTerminals();
      const prepared = await docker.terminalCommand(input);
      const terminal = await service.create({ title: prepared.title.slice(0, 60) });
      // Typed like a quick command: the user's shell runs `docker exec` once it started.
      service.write(terminal.id, `${prepared.command}\r`);
      return terminal;
    },
    files,
    editorSettings,
    backgroundWork: () => ({
      gitOperations: gitOperations
        .list()
        .filter((operation) => operation.status === 'queued' || operation.status === 'running')
        .length,
      preflightRuns: preflight.activeRunCount(),
      // A running Preflight job is already counted as a Preflight run.
      backgroundJobs: jobs
        .unfinished()
        .filter((job) => !(job.type === 'PREFLIGHT' && job.status === 'RUNNING')).length,
    }),
    llmSessions,
    quickCommands,
    gitPreferences,
    projectGitMonitor,
    gitIdentity,
    projectGitIdentity: async (projectId) =>
      gitIdentity.project(projectId, await projectRepositoryRoot(projectId)),
    setProjectGitIdentity: async (projectId, input) =>
      gitIdentity.setProject(projectId, await projectRepositoryRoot(projectId), input),
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
    projectConfig,
    projectConfigView,
    setProjectConfig: async (projectId, changes) => {
      const { project } = await projects.getDetails(projectId);
      await projectConfig.update(project, changes);
      return projectConfigView(project.id);
    },
    contextChanged,
    startAiSession: async (input) => {
      const service = requireTerminals();
      const target = await resolveContextTarget(input.target);
      let prompt: string | null = null;
      if (input.handoffId !== undefined) {
        prompt = continuationPrompt(
          handoffMarkdown(await context.getHandoff(target, input.handoffId), target.label),
        );
      } else if (input.includeContext) {
        // The same selection the Start dialog previewed: objective, role and exclusions.
        const bundle = await context.bundle(target, {
          taskId: input.taskId,
          provider: input.provider,
          budgetTokens: input.budgetTokens,
          objective: input.objective,
          agentRole: input.agentRole,
          executionProfile: input.executionProfile,
          files: input.files,
          keywords: input.keywords,
          excludeIds: input.excludeIds,
          detail: input.detail,
          skillIds: input.skillIds,
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
      // Skills chosen for this session are kept as session assignments (auditable).
      const sessionSkills = input.includeContext && !input.handoffId ? (input.skillIds ?? []) : [];
      for (const skillId of sessionSkills) {
        await skills.assign({ skillId, scope: 'session', target: session.id, effect: 'enable' });
      }
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
    runQuickCommand: async (input) => {
      await projects.getDetails(input.projectId);
      const command = await quickCommands.forProject(input.projectId, input.commandId);
      const service = requireTerminals();
      const terminal = await service.create({
        projectId: input.projectId,
        title: command.name,
        ...(input.groupId ? { groupId: input.groupId } : {}),
      });
      // Typed as if the user typed it: the shell runs it once it has started.
      service.write(terminal.id, `${command.command}\r`);
      return terminal;
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
      if (ownsExecution) {
        await sessions.reconcile('engine-restart');
        await gitOperationLog.start();
        try {
          await preflight.recover();
        } catch (error) {
          logger.warn('Interrupted Preflight runs could not be closed', {
            error: describeError(error),
          });
        }
        try {
          await http.initialize();
        } catch (error) {
          logger.warn('Old HTTP response files could not be removed', {
            error: describeError(error),
          });
        }
        try {
          await extensions.initialize();
        } catch (error) {
          logger.warn('Leftover extension files could not be removed', {
            error: describeError(error),
          });
        }
        try {
          await jobs.recover();
        } catch (error) {
          logger.warn('Interrupted background jobs could not be closed', {
            error: describeError(error),
          });
        }
        try {
          await projectConfig.installWrappers();
        } catch (error) {
          logger.warn('Failed to install the LLM wrappers', { error: describeError(error) });
        }
        // Tab status: activities still running when ATLAS quit become INTERRUPTED.
        await terminalActivity
          .load()
          .catch((error: unknown) =>
            logger.warn('Terminal activity could not be loaded', { error: describeError(error) }),
          );
        // Recording LLM sessions is a convenience: it never keeps the Engine from starting.
        try {
          await closeOrphanedLlmSessions().catch((error: unknown) =>
            logger.warn('Orphaned AI sessions could not be closed', {
              error: describeError(error),
            }),
          );
          await llmSessions.start();
        } catch (error) {
          logger.warn('Automatic LLM session recording is unavailable', {
            error: describeError(error),
          });
        }
        terminals?.onEvent((event) => {
          if (event.type === 'session' && isFinalTerminalStatus(event.session.status)) {
            llmSessions.terminalClosed(event.session.id);
            void terminalActivity.terminalEnded(event.session.id);
          }
          if (event.type === 'removed') terminalActivity.terminalRemoved(event.sessionId);
        });
        // Usage is informative: failures are logged and never stop the Engine.
        try {
          await projectConfig.writeStatusLineOff(
            UsageService.statusLineDisabled(await usage.syncProfiles()),
          );
        } catch (error) {
          logger.warn('Status line settings could not be written', {
            error: describeError(error),
          });
        }
        try {
          await usageInbox.start();
        } catch (error) {
          logger.warn('Claude Code usage collection is unavailable', {
            error: describeError(error),
          });
        }
        collectUsage();
        usageTimer = setInterval(collectUsage, USAGE_SCHEDULE_MS);
        usageTimer.unref?.();
      }
      // Automatic Git status collection runs only where repositories are watched (the
      // desktop Engine host); a failure leaves stored snapshots and manual refresh usable.
      if (ownsExecution && watcher !== undefined) {
        try {
          await projectGitMonitor.start();
        } catch (error) {
          logger.warn('Project Git monitoring is unavailable', { error: describeError(error) });
        }
      }
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
      projectGitMonitor.projectRemoved(project.id);
      await projectGitSettings.remove(project.id);
      await quickCommands.removeProject(project.id);
      await skills.projectRemoved(project.id);
      await preflight.projectRemoved(project.id);
      // A refresh that started before the removal finishes first, then the files go.
      await projectRefreshes.get(project.id)?.running;
      await projectConfig.remove(project.id);
      await terminals?.detachProject(project.id);
    },
    // An explicit read: it also updates the stored snapshot, and only monitored projects
    // are watched afterwards.
    projectGit: async (projectId) =>
      (await projectGitMonitor.refresh(projectId, { fresh: false })).status,
    createProject: async (input) => {
      const project = await projects.create(input);
      await projectGitMonitor.projectAdded(
        project.id,
        (await gitPreferences.get()).monitorNewProjects,
      );
      return project;
    },
    updateProject: async (id, input) => {
      const before = await projects.findById(id);
      const project = await projects.update(id, input);
      if (before !== null && before.workspacePath !== project.workspacePath) {
        await projectGitMonitor.projectMoved(project.id);
      }
      return project;
    },
    terminalGit: async (terminalId) => {
      const session = requireTerminals().getById(terminalId);
      return {
        directory: session.currentCwd,
        cwdSource: session.cwdSource,
        git: await inspectAndWatch(session.currentCwd),
      };
    },
    terminalActivities: async () => {
      await terminalActivity.load();
      return terminalActivity.summaries();
    },
    markTerminalReviewed: async (terminalId) => {
      requireTerminals().getById(terminalId);
      return terminalActivity.markReviewed(terminalId);
    },
    terminalLlmUsage: async (terminalId) => {
      requireTerminals().getById(terminalId);
      const run = usageInbox.openRun(terminalId);
      return run === null ? null : usage.claudeSessionUsage(run.configDirectory);
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
      await projectGitMonitor.projectAdded(
        project.id,
        (await gitPreferences.get()).monitorNewProjects,
      );
      const updated = await service.associate(terminalId, project.id);
      return { project, session: updated };
    },
    updateTerminalPreferences: (input) =>
      terminalSettings.updatePreferences(input, (directory) =>
        projects.resolveAvailableDirectory(directory),
      ),
    shutdown: async () => {
      // Git operations share one bounded wait, also when a GIT job waited for its push.
      const gitDeadline = Date.now() + GIT_SHUTDOWN_TIMEOUT_MS;
      if (ownsExecution) {
        if (usageTimer !== undefined) clearInterval(usageTimer);
        await usageInbox.close();
        await llmSessions.close();
        // Queued jobs never start; running ones stop and are reported as interrupted.
        await jobs.close();
        // Docker log and event streams stop; containers keep running.
        docker.close();
        // Running HTTP requests are cancelled; kept response bodies are removed.
        await http.close();
        // Debug adapters and their process trees stop; nothing is left running.
        await debug.close();
        // Running checks are cancelled and their process trees stopped.
        await preflight.close();
      }
      // New Git operations are refused (a push that would follow a finishing commit
      // settles as cancelled), queued ones and running pre-commit steps are cancelled;
      // commits and pushes that cannot be interrupted get a bounded time to finish.
      gitOperations.close();
      if (!(await gitOperations.idle(Math.max(0, gitDeadline - Date.now())))) {
        logger.warn('Git operations were still running at shutdown');
      }
      try {
        await terminals?.shutdown();
      } catch (error) {
        logger.error('Failed to stop terminals', { error: describeError(error) });
      }
      await Promise.all([...projectRefreshes.values()].map((refresh) => refresh.running));
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
