import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  FileLogger,
  createEngine,
  resolveDataDir,
  type Engine,
  type EngineOptions,
} from '@atlas/engine';
import { AtlasError, describeError, toSerializedError, type Logger } from '@atlas/shared';
import { Command, CommanderError } from 'commander';
import { formatProjectDetails, formatProjectList } from './format.js';

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
  const print = (json: boolean, value: unknown, text: string) =>
    io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : text);

  const program = new Command('atlas')
    .description('ATLAS command line interface')
    .version('0.1.0')
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
      await projects.remove(existing.project.id);
      io.stdout(`Removed "${existing.project.name}" from the registry. No files were deleted.\n`);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    return handleError(error, io, engine, engineOptions);
  } finally {
    engine?.close();
  }
}

class CliUsageError extends Error {}

function fallbackLogger(options: EngineOptions): Logger {
  const dataDir =
    options.dataDir ??
    resolveDataDir({
      env: options.env ?? process.env,
      platform: options.platform ?? process.platform,
      homeDir: os.homedir(),
    });
  return new FileLogger({ filePath: path.join(dataDir, 'logs', 'atlas.log'), component: 'cli' });
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
