import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { isFinalTerminalStatus } from '@atlas/contracts';
import {
  FileLogger,
  connectToEngine,
  createEngine,
  resolveDataDir,
  type Engine,
  type EngineOptions,
  type EngineSocketClient,
} from '@atlas/engine';
import { AtlasError, describeError, toSerializedError, type Logger } from '@atlas/shared';
import { Command, CommanderError } from 'commander';
import {
  formatProjectDetails,
  formatProjectList,
  formatTerminalDetails,
  formatTerminalList,
} from './format.js';

export const CLI_VERSION = '0.2.0';

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
      const details = await getEngine().projects.getDetails(id);
      print(Boolean(options.json), details, formatProjectDetails(details));
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
      await assertNoActiveTerminals(existing.project.id);
      await getEngine().removeProject(existing.project.id);
      io.stdout(`Removed "${existing.project.name}" from the registry. No files were deleted.\n`);
    });

  /** Refuses to remove a project whose terminals are running in ATLAS Control. */
  const assertNoActiveTerminals = async (projectId: string) => {
    let client: EngineSocketClient;
    try {
      client = await getEngineClient();
    } catch (error) {
      // No running Engine means no live terminals can exist.
      if (error instanceof AtlasError && error.code === 'ENGINE_UNAVAILABLE') return;
      throw error;
    }
    const sessions = await client.call('terminals.list', { projectId });
    if (sessions.some((session) => !isFinalTerminalStatus(session.status))) {
      throw new AtlasError('PROJECT_HAS_ACTIVE_TERMINALS', undefined, {
        details: { projectId },
      });
    }
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
    .description('Open a terminal in a registered project (shown in ATLAS Control)')
    .requiredOption('-p, --project <id>', 'project id')
    .option('-s, --shell <id>', 'shell id (defaults to the configured default shell)')
    .option('--title <title>', 'tab title')
    .option('--json', 'output JSON')
    .action(
      async (options: { project: string; shell?: string; title?: string; json?: boolean }) => {
        const client = await getEngineClient();
        const session = await client.call('terminals.create', {
          projectId: options.project,
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
          `Opened terminal "${session.title}" (${session.id})\n`,
        );
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
