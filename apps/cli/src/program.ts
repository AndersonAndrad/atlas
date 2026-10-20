import {
  EXECUTION_PROFILES,
  isFinalSessionStatus,
  isFinalTerminalStatus,
  type ContextEntry,
  type ContextOverview,
  type ContextTarget,
  type ContextTask,
  type EngineMethod,
  type EngineMethodParams,
  type AtlasSessionStatus,
  type EngineMethodResults,
  type SessionAction,
} from '@atlas/contracts';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  FileLogger,
  connectToEngine,
  createEngine,
  createEngineDispatcher,
  resolveDataDir,
  type Engine,
  type EngineOptions,
  type EngineSocketClient,
} from '@atlas/engine';
import { AtlasError, describeError, toSerializedError, type Logger } from '@atlas/shared';
import { Command, CommanderError } from 'commander';
import {
  formatGitStatus,
  formatProjectDetails,
  formatProjectList,
  formatSessionDetails,
  formatSessionList,
  formatSessionTasks,
  formatTerminalDetails,
  formatTerminalList,
  sessionStatusLabel,
} from './format.js';

export const CLI_VERSION = '0.4.0';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  isInteractive: boolean;
  confirm: (question: string) => Promise<boolean>;
}

export function defaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(`${question} [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Runs the CLI and returns the process exit code. */
export async function runCli(
  argv: string[],
  io: CliIo = defaultIo(),
  engineOptions: EngineOptions = {},
): Promise<number> {
  let engine: Engine | undefined;
  const getEngine = (): Engine => {
    engine ??= createEngine({ component: 'cli', ...engineOptions });
    return engine;
  };
  // Terminals live in the running Engine host; the CLI never spawns its own.
  let engineClient: EngineSocketClient | undefined;
  const getEngineClient = async (): Promise<EngineSocketClient> => {
    engineClient ??= await connectToEngine({ dataDir: cliDataDir(engineOptions) });
    return engineClient;
  };
  const print = (json: boolean, value: unknown, text: string) =>
    io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : text);

  const program = new Command('atlas')
    .description('ATLAS command line interface')
    .version(CLI_VERSION)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  const project = program.command('project').description('Manage registered projects');

  project
    .command('list')
    .description('List registered projects')
    .option('--json', 'output JSON')
    .action(async (options: { json?: boolean }) => {
      const items = await getEngine().projects.listDetails();
      print(Boolean(options.json), items, formatProjectList(items));
    });

  project
    .command('add')
    .description('Register a local directory as a project')
    .argument('<path>', 'project directory (relative paths resolve from the current directory)')
    .option('-n, --name <name>', 'project name (defaults to the directory name)')
    .option('-d, --description <text>', 'project description')
    .option('-t, --tag <tag>', 'tag (repeatable)', collect, [] as string[])
    .option('--json', 'output JSON')
    .action(
      async (
        inputPath: string,
        options: { name?: string; description?: string; tag: string[]; json?: boolean },
      ) => {
        const { projects } = getEngine();
        const absolutePath = path.resolve(io.cwd, inputPath);
        const inspection = await projects.inspectPath(absolutePath);
        const created = await projects.create({
          name: options.name ?? inspection.suggestedName ?? path.basename(absolutePath),
          workspacePath: absolutePath,
          ...(options.description !== undefined ? { description: options.description } : {}),
          tags: options.tag,
        });
        const details = await projects.getDetails(created.id);
        print(
          Boolean(options.json),
          details,
          `Registered project "${created.name}" (${created.id})\n`,
        );
      },
    );

  project
    .command('show')
    .description('Show project details')
    .argument('<id>', 'project id')
    .option('--json', 'output JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      const engine = getEngine();
      const details = await engine.projects.getDetails(id);
      const git = await engine.projectGit(details.project.id);
      print(
        Boolean(options.json),
        { ...details, gitStatus: git },
        formatProjectDetails(details) + formatGitStatus(git),
      );
    });

  project
    .command('remove')
    .description('Remove a project from the registry (files are never deleted)')
    .argument('<id>', 'project id')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async (id: string, options: { yes?: boolean }) => {
      const { projects } = getEngine();
      const existing = await projects.getDetails(id);
      if (!options.yes) {
        if (!io.isInteractive) {
          throw new CliUsageError('Confirmation required. Re-run with --yes to remove.');
        }
        const confirmed = await io.confirm(
          `Remove "${existing.project.name}" from the ATLAS registry? Files on disk are not deleted.`,
        );
        if (!confirmed) {
          io.stdout('Aborted.\n');
          return;
        }
      }
      await getEngine().removeProject(existing.project.id);
      await detachRunningTerminals(existing.project.id);
      io.stdout(`Removed "${existing.project.name}" from the registry. No files were deleted.\n`);
    });

  /**
   * Terminals of a removed project keep running as standalone terminals. Tells a
   * running Engine so its in-memory sessions drop the association too.
   */
  const detachRunningTerminals = async (projectId: string) => {
    let client: EngineSocketClient;
    try {
      client = await getEngineClient();
    } catch (error) {
      // No running Engine means no live terminals; stored ones were updated by the database.
      if (error instanceof AtlasError && error.code === 'ENGINE_UNAVAILABLE') return;
      throw error;
    }
    await client.call('terminals.detachProject', projectId);
  };

  const terminal = program
    .command('terminal')
    .description('Manage terminals of the running ATLAS Control Engine');

  terminal
    .command('list')
    .description('List terminal sessions')
    .option('-p, --project <id>', 'only terminals of this project')
    .option('--json', 'output JSON')
    .action(async (options: { project?: string; json?: boolean }) => {
      const client = await getEngineClient();
      const sessions = await client.call(
        'terminals.list',
        options.project !== undefined ? { projectId: options.project } : {},
      );
      print(Boolean(options.json), sessions, formatTerminalList(sessions));
    });

  terminal
    .command('open')
    .description(
      'Open a terminal (shown in ATLAS Control): in a registered project, in a directory, ' +
        'or in the default working directory',
    )
    .option('-p, --project <id>', 'project id (starts in the project directory)')
    .option('-C, --cwd <path>', 'directory for a standalone terminal')
    .option('-s, --shell <id>', 'shell id (defaults to the configured default shell)')
    .option('--title <title>', 'custom name')
    .option('--json', 'output JSON')
    .action(
      async (options: {
        project?: string;
        cwd?: string;
        shell?: string;
        title?: string;
        json?: boolean;
      }) => {
        if (options.project !== undefined && options.cwd !== undefined) {
          throw new CliUsageError('Use either --project or --cwd, not both.');
        }
        const client = await getEngineClient();
        const session = await client.call('terminals.create', {
          ...(options.project !== undefined ? { projectId: options.project } : {}),
          ...(options.cwd !== undefined ? { cwd: path.resolve(io.cwd, options.cwd) } : {}),
          ...(options.shell !== undefined ? { shellId: options.shell } : {}),
          ...(options.title !== undefined ? { title: options.title } : {}),
        });
        if (session.status === 'FAILED') {
          throw new AtlasError('TERMINAL_START_FAILED', undefined, {
            details: { sessionId: session.id },
          });
        }
        print(
          Boolean(options.json),
          session,
          `Opened terminal "${session.title}" (${session.id}) in ${session.cwd}\n`,
        );
      },
    );

  terminal
    .command('rename')
    .description('Set a custom terminal name, or restore the automatic one with --auto')
    .argument('<id>', 'terminal id')
    .argument('[title]', 'new name')
    .option('--auto', 'restore the automatic name')
    .option('--json', 'output JSON')
    .action(
      async (
        id: string,
        title: string | undefined,
        options: { auto?: boolean; json?: boolean },
      ) => {
        if ((title === undefined) === !options.auto) {
          throw new CliUsageError('Provide a new name or --auto.');
        }
        const client = await getEngineClient();
        const session = await client.call('terminals.rename', id, options.auto ? null : title!);
        print(Boolean(options.json), session, `Terminal renamed to "${session.title}".\n`);
      },
    );

  terminal
    .command('show')
    .description('Show terminal details')
    .argument('<id>', 'terminal id')
    .option('--json', 'output JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      const session = await (await getEngineClient()).call('terminals.get', id);
      print(Boolean(options.json), session, formatTerminalDetails(session));
    });

  terminal
    .command('close')
    .description('Terminate a terminal process')
    .argument('<id>', 'terminal id')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option('--json', 'output JSON')
    .action(async (id: string, options: { yes?: boolean; json?: boolean }) => {
      const client = await getEngineClient();
      const session = await client.call('terminals.get', id);
      if (!options.yes && !isFinalTerminalStatus(session.status)) {
        if (!io.isInteractive) {
          throw new CliUsageError('Confirmation required. Re-run with --yes to close.');
        }
        const info = await client.call('terminals.closeInfo', id);
        const running = info.processName ? ` "${info.processName}" is still running.` : '';
        const confirmed = await io.confirm(`Terminate terminal "${session.title}"?${running}`);
        if (!confirmed) {
          io.stdout('Aborted.\n');
          return;
        }
      }
      const closed = await client.call('terminals.terminate', id);
      print(
        Boolean(options.json),
        closed,
        `Terminal "${closed.title}" is ${closed.status.toLowerCase()}.\n`,
      );
    });

  /**
   * Session commands go to the running Engine host (so ATLAS Control updates
   * live); without one they use the same Engine services on the database.
   */
  const sessionCall = async <M extends EngineMethod>(
    method: M,
    ...params: EngineMethodParams<M>
  ): Promise<EngineMethodResults[M]> => {
    let client: EngineSocketClient | undefined;
    try {
      client = await getEngineClient();
    } catch (error) {
      if (!(error instanceof AtlasError && error.code === 'ENGINE_UNAVAILABLE')) throw error;
    }
    if (client !== undefined) return client.call(method, ...params);
    const result = await createEngineDispatcher(getEngine()).call(method, params, 'cli');
    return result as EngineMethodResults[M];
  };

  const session = program
    .command('session')
    .description('Manage ATLAS Sessions (orchestration records; no AI execution yet)');

  session
    .command('create')
    .description('Create a draft session in a project, in a directory, or without a workspace')
    .requiredOption('-n, --name <name>', 'session name')
    .requiredOption('-o, --objective <text>', 'what the session should achieve')
    .option('-p, --project <id>', 'registered project to work in')
    .option('-C, --cwd <path>', 'standalone workspace directory')
    .option('--profile <profile>', `execution profile (${EXECUTION_PROFILES.join(', ')})`)
    .option('-c, --constraint <text>', 'initial constraint (repeatable)', collect, [] as string[])
    .option('--json', 'output JSON')
    .action(
      async (options: {
        name: string;
        objective: string;
        project?: string;
        cwd?: string;
        profile?: string;
        constraint: string[];
        json?: boolean;
      }) => {
        if (options.project !== undefined && options.cwd !== undefined) {
          throw new CliUsageError('Use either --project or --cwd, not both.');
        }
        const created = await sessionCall('sessions.create', {
          name: options.name,
          objective: options.objective,
          ...(options.project !== undefined ? { projectId: options.project } : {}),
          ...(options.cwd !== undefined
            ? { workspacePath: path.resolve(io.cwd, options.cwd) }
            : {}),
          ...(options.profile !== undefined
            ? { executionProfile: options.profile.toUpperCase() }
            : {}),
          constraints: options.constraint,
        });
        print(
          Boolean(options.json),
          created,
          `Created draft session "${created.name}" (${created.id})\n`,
        );
      },
    );

  session
    .command('list')
    .description('List sessions (archived ones only with --all)')
    .option('-p, --project <id>', 'only sessions of this project')
    .option('-a, --all', 'include archived sessions')
    .option('--json', 'output JSON')
    .action(async (options: { project?: string; all?: boolean; json?: boolean }) => {
      const items = await sessionCall('sessions.list', {
        ...(options.all ? { includeArchived: true } : {}),
        ...(options.project !== undefined ? { projectId: options.project } : {}),
      });
      print(Boolean(options.json), items, formatSessionList(items));
    });

  session
    .command('show')
    .description('Show session details and recent events')
    .argument('<id>', 'session id')
    .option('--json', 'output JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      const details = await sessionCall('sessions.get', id);
      const events = await sessionCall('sessions.events', details.session.id);
      print(Boolean(options.json), { ...details, events }, formatSessionDetails(details, events));
    });

  session
    .command('tasks')
    .description('List the tasks of a session and their dependencies')
    .argument('<id>', 'session id')
    .option('--json', 'output JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      const tasks = await sessionCall('sessions.tasks', id);
      print(Boolean(options.json), tasks, formatSessionTasks(tasks));
    });

  const lifecycle: [string, SessionAction, string][] = [
    ['ready', 'markReady', 'Mark a draft as ready (checks the workspace)'],
    ['start', 'start', 'Start a ready session (it waits for an executor until SDD-004)'],
    ['pause', 'pause', 'Pause a session'],
    ['resume', 'resume', 'Resume a paused or interrupted session'],
    ['archive', 'archive', 'Archive a completed, failed or cancelled session'],
  ];
  for (const [name, action, description] of lifecycle) {
    session
      .command(name)
      .description(description)
      .argument('<id>', 'session id')
      .option('--json', 'output JSON')
      .action(async (id: string, options: { json?: boolean }) => {
        const updated = await sessionCall('sessions.perform', id, action);
        print(Boolean(options.json), updated, sessionUpdated(updated.name, updated.status, action));
      });
  }

  session
    .command('cancel')
    .description('Cancel a session and its unfinished tasks')
    .argument('<id>', 'session id')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option('--json', 'output JSON')
    .action(async (id: string, options: { yes?: boolean; json?: boolean }) => {
      const details = await sessionCall('sessions.get', id);
      if (isFinalSessionStatus(details.session.status)) {
        throw new AtlasError('SESSION_TRANSITION_INVALID');
      }
      if (!options.yes) {
        if (!io.isInteractive) {
          throw new CliUsageError('Confirmation required. Re-run with --yes to cancel.');
        }
        const confirmed = await io.confirm(
          `Cancel session "${details.session.name}"? This cannot be undone.`,
        );
        if (!confirmed) {
          io.stdout('Aborted.\n');
          return;
        }
      }
      const cancelled = await sessionCall('sessions.perform', details.session.id, 'cancel');
      print(Boolean(options.json), cancelled, `Session "${cancelled.name}" is cancelled.\n`);
    });

  // Shared context (SDD-005): read, export and hand off; AI sessions open in ATLAS.
  const contextTarget = (options: { project?: string; cwd?: string }): ContextTarget => {
    if ((options.project === undefined) === (options.cwd === undefined)) {
      throw new CliUsageError('Use either --project <id> or --cwd <repository>.');
    }
    return options.project !== undefined
      ? { projectId: options.project }
      : { workspacePath: path.resolve(io.cwd, options.cwd!) };
  };
  const targetOptions = (command: Command) =>
    command
      .option('-p, --project <id>', 'registered project')
      .option('-C, --cwd <path>', 'Git repository opened in ATLAS (project or terminal)');

  const contextCommand = program
    .command('context')
    .description('Shared context: project memory, tasks, decisions and handoffs');

  targetOptions(
    contextCommand
      .command('show')
      .description('Show what ATLAS remembers about a project or repository')
      .option('-t, --task <id>', 'only this task')
      .option('-s, --search <text>', 'full-text search')
      .option('--json', 'output JSON'),
  ).action(
    async (options: {
      project?: string;
      cwd?: string;
      task?: string;
      search?: string;
      json?: boolean;
    }) => {
      const target = contextTarget(options);
      const [overview, entries, tasks] = await Promise.all([
        sessionCall('context.overview', target),
        sessionCall('context.list', {
          target,
          ...(options.task ? { taskId: options.task } : {}),
          ...(options.search ? { search: options.search } : {}),
        }),
        sessionCall('context.tasks', target),
      ]);
      print(
        Boolean(options.json),
        { overview, tasks, entries },
        formatContext(overview, tasks, entries),
      );
    },
  );

  targetOptions(
    contextCommand
      .command('bundle')
      .description('Print the context bundle an AI session would receive')
      .option('-t, --task <id>', 'task to focus on')
      .option('--provider <name>', 'claude, codex or generic', 'generic')
      .option('--budget <tokens>', 'token budget', '6000')
      .option('--json', 'output JSON'),
  ).action(
    async (options: {
      project?: string;
      cwd?: string;
      task?: string;
      provider: string;
      budget: string;
      json?: boolean;
    }) => {
      const bundle = await sessionCall('context.bundle', {
        target: contextTarget(options),
        ...(options.task ? { taskId: options.task } : {}),
        provider: options.provider as 'claude' | 'codex' | 'generic',
        budgetTokens: Number(options.budget),
      });
      print(Boolean(options.json), bundle, `${bundle.markdown}\n`);
    },
  );

  const handoffCommand = contextCommand
    .command('handoff')
    .description('Create and export handoffs');
  targetOptions(
    handoffCommand
      .command('create')
      .description('Create a handoff from stored context and Git evidence')
      .option('-t, --task <id>', 'task to hand off')
      .option('-o, --objective <text>', 'objective (defaults to the task objective)')
      .option('--to <provider>', 'claude or codex')
      .option('--done <text>', 'completed work (repeatable)', collect, [] as string[])
      .option('--pending <text>', 'pending work (repeatable)', collect, [] as string[])
      .option('--json', 'output JSON'),
  ).action(
    async (options: {
      project?: string;
      cwd?: string;
      task?: string;
      objective?: string;
      to?: string;
      done: string[];
      pending: string[];
      json?: boolean;
    }) => {
      const target = contextTarget(options);
      const draft = await sessionCall('context.prepareHandoff', target, {
        ...(options.task ? { taskId: options.task } : {}),
      });
      const objective = options.objective ?? draft.objective;
      if (objective.trim() === '') {
        throw new CliUsageError('Give an --objective or a --task that has one.');
      }
      const handoff = await sessionCall('context.createHandoff', {
        target,
        ...(options.task ? { taskId: options.task } : {}),
        targetProvider: (options.to ?? null) as 'claude' | 'codex' | null,
        objective,
        completedWork: [...draft.completedWork, ...options.done],
        pendingWork: [...draft.pendingWork, ...options.pending],
        blockers: draft.blockers,
        nextActions: draft.nextActions,
      });
      const { markdown } = await sessionCall('context.handoff', target, handoff.id);
      print(Boolean(options.json), handoff, `Created handoff ${handoff.id}\n\n${markdown}\n`);
    },
  );
  targetOptions(
    handoffCommand
      .command('show')
      .description('Print a handoff as markdown')
      .argument('<id>', 'handoff id')
      .option('--json', 'output JSON'),
  ).action(async (id: string, options: { project?: string; cwd?: string; json?: boolean }) => {
    const result = await sessionCall('context.handoff', contextTarget(options), id);
    print(Boolean(options.json), result.handoff, `${result.markdown}\n`);
  });

  const ai = program
    .command('ai')
    .description('Individual Claude Code or Codex sessions with shared context');
  targetOptions(
    ai
      .command('start')
      .description('Open Claude Code or Codex in a new ATLAS terminal (ATLAS must be running)')
      .requiredOption('--provider <name>', 'claude or codex')
      .option('-t, --task <id>', 'task to continue')
      .option('--handoff <id>', 'continue from this handoff')
      .option('--no-context', 'start without sending stored context')
      .option('--json', 'output JSON'),
  ).action(
    async (options: {
      provider: string;
      project?: string;
      cwd?: string;
      task?: string;
      handoff?: string;
      context: boolean;
      json?: boolean;
    }) => {
      if (options.provider !== 'claude' && options.provider !== 'codex') {
        throw new CliUsageError('--provider must be claude or codex.');
      }
      const client = await getEngineClient();
      const started = await client.call('ai.start', {
        provider: options.provider,
        target: contextTarget(options),
        ...(options.task ? { taskId: options.task } : {}),
        ...(options.handoff ? { handoffId: options.handoff } : {}),
        includeContext: options.context,
      });
      print(
        Boolean(options.json),
        started,
        `Started ${options.provider} in terminal ${started.terminalId}` +
          (started.prompt === null ? ' without context.\n' : ' with ATLAS context.\n'),
      );
    },
  );

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    return handleError(error, io, engine, engineOptions);
  } finally {
    engineClient?.close();
    engine?.close();
  }
}

class CliUsageError extends Error {}

function formatContext(
  overview: ContextOverview,
  tasks: ContextTask[],
  entries: ContextEntry[],
): string {
  const lines = [
    `${overview.entries} entries · ${overview.openTasks}/${overview.tasks} open tasks · ` +
      `${overview.decisions} active decisions · ${overview.handoffs} handoffs · ` +
      `${overview.sessions} AI sessions`,
  ];
  if (tasks.length > 0) {
    lines.push('', 'Tasks:');
    for (const task of tasks) lines.push(`  ${task.id}  [${task.status}] ${task.title}`);
  }
  if (entries.length > 0) {
    lines.push('', 'Entries:');
    for (const entry of entries) {
      lines.push(`  ${entry.id}  ${entry.category} (${entry.verification})  ${entry.title}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function sessionUpdated(name: string, status: AtlasSessionStatus, action: SessionAction): string {
  if (action === 'archive') return `Session "${name}" is archived.\n`;
  if (status === 'WAITING_EXECUTOR') {
    return `Session "${name}" is waiting for an executor. No execution adapter is installed yet.\n`;
  }
  return `Session "${name}" is ${sessionStatusLabel(status)}.\n`;
}

function cliDataDir(options: EngineOptions): string {
  return (
    options.dataDir ??
    resolveDataDir({
      env: options.env ?? process.env,
      platform: options.platform ?? process.platform,
      homeDir: os.homedir(),
    })
  );
}

function fallbackLogger(options: EngineOptions): Logger {
  return new FileLogger({
    filePath: path.join(cliDataDir(options), 'logs', 'atlas.log'),
    component: 'cli',
  });
}

function handleError(
  error: unknown,
  io: CliIo,
  engine: Engine | undefined,
  engineOptions: EngineOptions,
): number {
  if (error instanceof CommanderError) {
    // Help and version displays are reported as "errors" by exitOverride.
    return error.exitCode === 0 ? 0 : 2;
  }
  if (error instanceof CliUsageError) {
    io.stderr(`Error: ${error.message}\n`);
    return 2;
  }
  const serialized = toSerializedError(error);
  io.stderr(`Error: ${serialized.message}\n`);
  for (const issue of serialized.issues) {
    io.stderr(`  - ${issue.field}: ${issue.message}\n`);
  }
  if (
    !(error instanceof AtlasError) ||
    serialized.code === 'INTERNAL_ERROR' ||
    serialized.code === 'PROJECT_PERSISTENCE_ERROR'
  ) {
    // The Engine logger is unavailable when the Engine itself failed to start.
    const logger = engine?.logger ?? fallbackLogger(engineOptions);
    logger.error('CLI command failed', { error: describeError(error) });
  }
  return 1;
}
