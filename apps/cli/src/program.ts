import {
  EXECUTION_PROFILES,
  isFinalSessionStatus,
  isFinalTerminalStatus,
  type ContextBundle,
  type ContextBundleRequest,
  type ContextEntry,
  type ContextHealthReport,
  type ContextOverview,
  type ContextTarget,
  type ContextTask,
  type EngineMethod,
  type GitCommandRecord,
  type GitOperationLogEntry,
  type GitCommitFiles,
  type GitReflogEntry,
  type AgentRole,
  type ResolvedSkill,
  type Skill,
  type SkillImportPreview,
  type SkillSyncPlan,
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
  createGitRunner,
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
    .description('Manage terminals of the running A.T.L.A.S Engine');

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
      'Open a terminal (shown in A.T.L.A.S): in a registered project, in a directory, ' +
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
   * Session commands go to the running Engine host (so A.T.L.A.S updates
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

  // Skills Hub (SDD-006 Milestone B). Paths given here are the user's explicit choice.
  const skillsCommand = program
    .command('skills')
    .description('Skills Hub: register, enable, assign and synchronize reusable skills');
  skillsCommand
    .command('list')
    .description('List registered skills')
    .option('--json', 'output JSON')
    .action(async (options: { json?: boolean }) => {
      const skills = await sessionCall('skills.list');
      print(Boolean(options.json), skills, formatSkills(skills));
    });
  skillsCommand
    .command('show')
    .description('Show a skill with its checks, rules and versions')
    .argument('<id>', 'skill id')
    .option('--json', 'output JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      const details = await sessionCall('skills.details', id);
      print(
        Boolean(options.json),
        details,
        formatSkillDetails(details.skill, details.versions.length),
      );
    });
  const sourcesCommand = skillsCommand
    .command('sources')
    .description('Folders ATLAS may scan for skills')
    .option('--json', 'output JSON')
    .action(async (options: { json?: boolean }) => {
      const sources = await sessionCall('skills.sources');
      print(
        Boolean(options.json),
        sources,
        sources.length === 0
          ? 'No skill sources. Add one with `atlas skills sources add <path>`.\n'
          : `${sources.map((source) => `${source.id}  ${source.enabled ? 'on ' : 'off'}  ${source.kind.padEnd(6)} ${source.path}`).join('\n')}\n`,
      );
    });
  sourcesCommand
    .command('add')
    .description('Authorize a folder for skill discovery')
    .argument('<path>', 'folder')
    .option('--kind <kind>', 'claude, codex or path', 'path')
    .action(async (folder: string, options: { kind: string }) => {
      const source = await sessionCall(
        'skills.addSource',
        { path: path.resolve(io.cwd, folder), kind: options.kind as 'claude' | 'codex' | 'path' },
        true,
      );
      io.stdout(`Added ${source.path}\n`);
    });
  skillsCommand
    .command('discover')
    .description('List skills found in the enabled sources')
    .option('--json', 'output JSON')
    .action(async (options: { json?: boolean }) => {
      const found = await sessionCall('skills.discover');
      print(
        Boolean(options.json),
        found,
        found.length === 0
          ? 'No skills found.\n'
          : `${found.map((skill) => `${skill.status.padEnd(16)} ${skill.name}  ${skill.path}`).join('\n')}\n`,
      );
    });
  skillsCommand
    .command('import')
    .description('Review a skill folder (or a folder of skills) and copy it into ATLAS')
    .argument('<path>', 'skill folder (contains SKILL.md) or a folder of skill folders')
    .option('-y, --yes', 'import after showing the review, without asking')
    .option('--enable', 'enable the imported skills for every project')
    .option('--json', 'output JSON')
    .action(
      async (folder: string, options: { yes?: boolean; enable?: boolean; json?: boolean }) => {
        const absolute = path.resolve(io.cwd, folder);
        const preview = await sessionCall('skills.inspect', { path: absolute }, true);
        if (preview.validation.issues.some((issue) => issue.code === 'missing-skill-file')) {
          const collection = await sessionCall(
            'skills.inspectCollection',
            { path: absolute },
            true,
          );
          if (collection.skills.length > 0) {
            const ready = collection.skills.filter(
              (skill) => skill.validation.valid && !skill.sameContent,
            );
            if (!options.json) {
              io.stdout(
                `${collection.skills
                  .map(
                    (skill) =>
                      `${!skill.validation.valid ? 'invalid ' : skill.sameContent ? 'imported' : 'new     '}  ${skill.name} (${skill.version})` +
                      (skill.validation.scripts.length
                        ? `  scripts: ${skill.validation.scripts.join(', ')}`
                        : ''),
                  )
                  .join('\n')}\n`,
              );
            }
            if (ready.length === 0) {
              print(Boolean(options.json), collection, 'Nothing to import.\n');
              return;
            }
            if (!options.yes) {
              if (!io.isInteractive) {
                throw new CliUsageError('Confirmation required. Re-run with --yes to import.');
              }
              if (!(await io.confirm(`Import ${ready.length} skill(s)?`))) {
                io.stdout('Aborted.\n');
                return;
              }
            }
            const result = await sessionCall(
              'skills.importCollection',
              {
                path: collection.path,
                confirm: true,
                enable: Boolean(options.enable),
                items: ready.map((skill) => ({ path: skill.path, contentHash: skill.contentHash })),
              },
              true,
            );
            print(
              Boolean(options.json),
              result,
              `Imported ${result.imported.length} skill(s)${options.enable ? ' and enabled them' : ''}; ${result.failed.length} failed.\n` +
                result.failed.map((item) => `  ${item.name}: ${item.message}\n`).join(''),
            );
            return;
          }
        }
        if (!options.json) io.stdout(formatSkillPreview(preview));
        if (!preview.validation.valid) {
          throw new CliUsageError('The skill cannot be imported; see the errors above.');
        }
        if (preview.sameContent) {
          print(Boolean(options.json), preview, 'Already imported; nothing to do.\n');
          return;
        }
        if (!options.yes) {
          if (!io.isInteractive) {
            throw new CliUsageError('Confirmation required. Re-run with --yes to import.');
          }
          if (!(await io.confirm('Import this skill?'))) {
            io.stdout('Aborted.\n');
            return;
          }
        }
        const skill = await sessionCall(
          'skills.import',
          { path: absolute, confirm: true, contentHash: preview.contentHash },
          true,
        );
        print(
          Boolean(options.json),
          skill,
          `Imported ${skill.name} (${skill.version}) as ${skill.id}; it is disabled until you enable it.\n`,
        );
      },
    );
  for (const [name, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    skillsCommand
      .command(name)
      .description(`${enabled ? 'Enable' : 'Disable'} a skill for every project`)
      .argument('<id>', 'skill id')
      .action(async (id: string) => {
        const skill = await sessionCall('skills.setEnabled', id, enabled);
        io.stdout(`${skill.name} is ${enabled ? 'enabled' : 'disabled'} globally.\n`);
      });
  }
  skillsCommand
    .command('assign')
    .description('Enable (or with --disable, restrict) a skill for a project, provider or role')
    .argument('<id>', 'skill id')
    .requiredOption('--scope <scope>', 'project, provider or role')
    .requiredOption('--target <target>', 'project id, claude|codex, or role')
    .option('--disable', 'disable instead of enable')
    .action(async (id: string, options: { scope: string; target: string; disable?: boolean }) => {
      await sessionCall('skills.assign', {
        skillId: id,
        scope: options.scope as 'project' | 'provider' | 'role',
        target: options.target,
        effect: options.disable ? 'disable' : 'enable',
      });
      io.stdout('Rule saved.\n');
    });
  skillsCommand
    .command('unassign')
    .description('Remove a project, provider or role rule')
    .argument('<id>', 'skill id')
    .requiredOption('--scope <scope>', 'project, provider or role')
    .requiredOption('--target <target>', 'project id, claude|codex, or role')
    .action(async (id: string, options: { scope: string; target: string }) => {
      await sessionCall('skills.unassign', {
        skillId: id,
        scope: options.scope as 'project' | 'provider' | 'role',
        target: options.target,
      });
      io.stdout('Rule removed.\n');
    });
  skillsCommand
    .command('remove')
    .description('Remove a skill from ATLAS (its source folder is not touched)')
    .argument('<id>', 'skill id')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async (id: string, options: { yes?: boolean }) => {
      if (!options.yes) {
        if (!io.isInteractive) throw new CliUsageError('Confirmation required. Re-run with --yes.');
        if (!(await io.confirm('Remove this skill from ATLAS?'))) return;
      }
      await sessionCall('skills.remove', id);
      io.stdout('Removed from ATLAS.\n');
    });
  skillsCommand
    .command('resolve')
    .description('Show which skills are active for a project, provider and role, and why')
    .option('-p, --project <id>', 'project')
    .option('--provider <name>', 'claude, codex or generic')
    .option('--role <role>', 'generic, architect, developer, qa, security or reviewer')
    .option('--json', 'output JSON')
    .action(
      async (options: { project?: string; provider?: string; role?: string; json?: boolean }) => {
        const resolved = await sessionCall('skills.resolve', {
          ...(options.project ? { projectId: options.project } : {}),
          ...(options.provider
            ? { provider: options.provider as 'claude' | 'codex' | 'generic' }
            : {}),
          ...(options.role ? { role: options.role as AgentRole } : {}),
        });
        print(Boolean(options.json), resolved, formatResolved(resolved));
      },
    );
  skillsCommand
    .command('templates')
    .description('List the built-in skill templates')
    .action(async () => {
      const templates = await sessionCall('skills.templates');
      io.stdout(
        `${templates.map((item) => `${item.id.padEnd(22)} ${item.version}  ${item.description}`).join('\n')}\n`,
      );
    });
  const syncCommand = skillsCommand
    .command('sync')
    .description('Synchronize globally enabled skills to a provider folder');
  for (const [name, describe] of [
    ['preview', 'Show what synchronizing would change'],
    ['apply', 'Write the changes (folders not created by ATLAS are never changed)'],
  ] as const) {
    syncCommand
      .command(name)
      .description(describe)
      .requiredOption('--provider <name>', 'claude or codex')
      .option('--json', 'output JSON')
      .action(async (options: { provider: string; json?: boolean }) => {
        const provider = options.provider as 'claude' | 'codex';
        if (name === 'preview') {
          const plan = await sessionCall('skills.syncPreview', provider);
          print(Boolean(options.json), plan, formatSyncPlan(plan));
        } else {
          const result = await sessionCall('skills.syncApply', provider);
          print(
            Boolean(options.json),
            result,
            `Applied ${result.applied.length} change(s), skipped ${result.skipped.length}. Batch ${result.batchId}.\n`,
          );
        }
      });
  }
  syncCommand
    .command('history')
    .description('List synchronizations')
    .action(async () => {
      const batches = await sessionCall('skills.syncHistory');
      io.stdout(
        batches.length === 0
          ? 'No synchronizations.\n'
          : `${batches.map((batch) => `${batch.batchId}  ${batch.provider.padEnd(6)} ${batch.appliedAt}  ${batch.changes} change(s)${batch.rolledBackAt ? '  rolled back' : ''}`).join('\n')}\n`,
      );
    });
  syncCommand
    .command('rollback')
    .description('Undo the latest synchronization of a provider')
    .argument('<batch>', 'batch id from `atlas skills sync history`')
    .action(async (batchId: string) => {
      const result = await sessionCall('skills.syncRollback', batchId);
      io.stdout(`Restored ${result.restored.length}; left alone ${result.skipped.length}.\n`);
    });

  // Git history (PLAN-016): operations ATLAS ran and the repository reflog.
  const repositoryRoot = async (directory: string) => {
    try {
      const root = await createGitRunner({ env: process.env })(['rev-parse', '--show-toplevel'], {
        cwd: path.resolve(io.cwd, directory),
        timeoutMs: 10_000,
      });
      return root.trim();
    } catch {
      throw new CliUsageError(`${directory} is not inside a Git repository.`);
    }
  };
  const gitCommand = program
    .command('git')
    .description('Git history: operations run by ATLAS and the repository reflog');
  gitCommand
    .command('log-operations')
    .description('List logged Git operations, newest first')
    .option('-r, --repo <path>', 'only this repository (any folder inside it)')
    .option('--kind <kind>', 'operation kind, e.g. commit, push, pull')
    .option('--status <status>', 'queued, running, succeeded, failed or cancelled')
    .option('--before <time>', 'only operations started before this ISO time')
    .option('-n, --limit <count>', 'maximum operations (1-500)', '50')
    .option('--json', 'output JSON')
    .action(
      async (options: {
        repo?: string;
        kind?: string;
        status?: string;
        before?: string;
        limit: string;
        json?: boolean;
      }) => {
        if (!/^\d+$/.test(options.limit)) throw new CliUsageError('--limit must be a number.');
        const page = await sessionCall('git.operationLog', {
          ...(options.repo ? { repositoryRoot: await repositoryRoot(options.repo) } : {}),
          ...(options.kind ? { kind: options.kind as GitOperationLogEntry['kind'] } : {}),
          ...(options.status ? { status: options.status as GitOperationLogEntry['status'] } : {}),
          ...(options.before ? { before: options.before } : {}),
          limit: Number(options.limit),
        });
        print(Boolean(options.json), page, formatOperationLog(page.operations, page.nextBefore));
      },
    );
  gitCommand
    .command('log-operation')
    .description('Show a logged Git operation with every command it ran')
    .argument('<id>', 'operation id')
    .option('--json', 'output JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      const details = await sessionCall('git.operationDetails', id);
      print(
        Boolean(options.json),
        details,
        formatOperationDetails(details.operation, details.commands),
      );
    });
  gitCommand
    .command('reflog')
    .description('Show HEAD changes by any tool, marking those made through ATLAS')
    .option('-r, --repo <path>', 'repository (any folder inside it)', '.')
    .option('-n, --limit <count>', 'maximum entries (1-500)', '50')
    .option(
      '-s, --search <text>',
      'only entries whose message or commit subject contains the text, or whose hash starts with it',
    )
    .option('--json', 'output JSON')
    .action(async (options: { repo: string; limit: string; search?: string; json?: boolean }) => {
      if (!/^\d+$/.test(options.limit)) throw new CliUsageError('--limit must be a number.');
      const entries = await sessionCall('git.reflog', {
        repositoryRoot: await repositoryRoot(options.repo),
        limit: Number(options.limit),
        ...(options.search !== undefined ? { query: options.search } : {}),
      });
      print(Boolean(options.json), entries, formatReflog(entries, options.search));
    });
  gitCommand
    .command('show-files')
    .description('List the files a commit changed, compared with its first parent')
    .argument('<hash>', 'full commit hash')
    .option('-r, --repo <path>', 'repository (any folder inside it)', '.')
    .option('--json', 'output JSON')
    .action(async (hash: string, options: { repo: string; json?: boolean }) => {
      const details = await sessionCall('git.commitFiles', {
        repositoryRoot: await repositoryRoot(options.repo),
        hash: hash.toLowerCase(),
      });
      if (details === null) throw new CliUsageError(`Commit ${hash} does not exist.`);
      print(Boolean(options.json), details, formatCommitFiles(details));
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

  // Selection options shared by `bundle` and `retrieve` (SDD-006); the Engine validates them.
  interface RetrievalOptions {
    project?: string;
    cwd?: string;
    task?: string;
    provider: string;
    budget?: string;
    objective?: string;
    role?: string;
    profile?: string;
    file: string[];
    keyword: string[];
    exclude: string[];
    detail?: string;
    json?: boolean;
  }
  const retrievalOptions = (command: Command) =>
    targetOptions(
      command
        .option('-t, --task <id>', 'task to focus on')
        .option('--provider <name>', 'claude, codex or generic', 'generic')
        .option('--budget <tokens>', 'estimated token budget (default: configured budgets)')
        .option('-o, --objective <text>', 'objective to rank the context for')
        .option('--role <role>', 'generic, architect, developer, qa, security or reviewer')
        .option('--profile <profile>', `execution profile: ${EXECUTION_PROFILES.join(', ')}`)
        .option('-f, --file <path>', 'repository file the work is about (repeatable)', collect, [])
        .option('-k, --keyword <word>', 'technical keyword (repeatable)', collect, [])
        .option('--exclude <id>', 'leave out an optional record (repeatable)', collect, [])
        .option('--detail <level>', 'essential or full')
        .option('--json', 'output JSON'),
    );
  const bundleRequest = (options: RetrievalOptions): ContextBundleRequest => {
    if (options.budget !== undefined && !/^\d+$/.test(options.budget)) {
      throw new CliUsageError('--budget must be a number of tokens.');
    }
    return {
      target: contextTarget(options),
      provider: options.provider as 'claude' | 'codex' | 'generic',
      ...(options.task ? { taskId: options.task } : {}),
      ...(options.budget ? { budgetTokens: Number(options.budget) } : {}),
      ...(options.objective ? { objective: options.objective } : {}),
      ...(options.role ? { agentRole: options.role as ContextBundle['role'] } : {}),
      ...(options.profile
        ? { executionProfile: options.profile as (typeof EXECUTION_PROFILES)[number] }
        : {}),
      ...(options.file.length ? { files: options.file } : {}),
      ...(options.keyword.length ? { keywords: options.keyword } : {}),
      ...(options.exclude.length ? { excludeIds: options.exclude } : {}),
      ...(options.detail ? { detail: options.detail as 'essential' | 'full' } : {}),
    };
  };

  retrievalOptions(
    contextCommand
      .command('bundle')
      .description('Print the context bundle an AI session would receive'),
  ).action(async (options: RetrievalOptions) => {
    const bundle = await sessionCall('context.bundle', bundleRequest(options));
    print(Boolean(options.json), bundle, `${bundle.markdown}\n`);
  });

  retrievalOptions(
    contextCommand
      .command('retrieve')
      .description('List the stored records ranked for an objective, with their scores'),
  ).action(async (options: RetrievalOptions) => {
    const bundle = await sessionCall('context.bundle', bundleRequest(options));
    print(Boolean(options.json), bundle, formatRetrieval(bundle));
  });

  targetOptions(
    contextCommand
      .command('health')
      .description('Report stale, conflicting, duplicate and unsourced context')
      .option('--json', 'output JSON'),
  ).action(async (options: { project?: string; cwd?: string; json?: boolean }) => {
    const report = await sessionCall('context.health', contextTarget(options));
    print(Boolean(options.json), report, formatHealth(report));
  });

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

function formatSkills(skills: Skill[]): string {
  if (skills.length === 0) return 'No skills registered.\n';
  return `${skills
    .map(
      (skill) =>
        `${skill.id}  ${skill.enabled ? 'on ' : 'off'}  ${skill.name} (${skill.version})` +
        `  ${skill.validation.compatibility.map((item) => `${item.provider}:${item.status}`).join(' ')}` +
        (skill.validation.valid ? '' : '  INVALID'),
    )
    .join('\n')}\n`;
}

function formatSkillDetails(skill: Skill, versions: number): string {
  const lines = [
    `${skill.name} (${skill.version}) — ${skill.enabled ? 'enabled globally' : 'not enabled globally'}`,
    skill.description,
    `Source: ${skill.source.kind}${skill.source.path ? ` ${skill.source.path}` : ''}; ${versions} version(s)`,
    `Stored at: ${skill.storagePath}`,
    ...skill.validation.compatibility.map(
      (item) =>
        `${item.provider}: ${item.status}${item.unsupportedFeatures.length ? ` (ignored: ${item.unsupportedFeatures.join(', ')})` : ''}`,
    ),
    ...skill.validation.issues.map((issue) => `${issue.level}: ${issue.message}`),
    ...skill.assignments.map((item) => `rule: ${item.effect} for ${item.scope} ${item.target}`),
  ];
  return `${lines.filter((line) => line !== '').join('\n')}\n`;
}

function formatSkillPreview(preview: SkillImportPreview): string {
  const { validation } = preview;
  const lines = [
    `${preview.name} (${preview.version}) — ${preview.files.length} file(s), ${preview.totalSize} bytes`,
    preview.description,
    ...validation.compatibility.map((item) => `${item.provider}: ${item.status}`),
    ...validation.issues.map((issue) => `${issue.level}: ${issue.message}`),
    ...(validation.scripts.length
      ? ['Executable files (never run by ATLAS):', ...validation.scripts.map((file) => `  ${file}`)]
      : []),
    ...(validation.permissions.length
      ? ['Requested permissions:', ...validation.permissions.map((item) => `  ${item}`)]
      : []),
    ...validation.dependencies.map(
      (item) => `dependency ${item.kind} ${item.name}: ${item.status}`,
    ),
  ];
  return `${lines.filter((line) => line !== '').join('\n')}\n`;
}

function formatResolved(resolved: ResolvedSkill[]): string {
  if (resolved.length === 0) return 'No skills registered.\n';
  return `${resolved
    .map(
      (skill) =>
        `${skill.active ? 'active  ' : 'inactive'}  ${skill.name.padEnd(24)} ${skill.layer.padEnd(8)} ${skill.reason}`,
    )
    .join('\n')}\n`;
}

function formatSyncPlan(plan: SkillSyncPlan): string {
  const lines = [`${plan.provider} → ${plan.targetPath}`];
  if (plan.items.length === 0) lines.push('Nothing to synchronize.');
  for (const item of plan.items)
    lines.push(`  ${item.action.padEnd(9)} ${item.dirName}  ${item.reason}`);
  return `${lines.join('\n')}\n`;
}

function formatOperationLog(operations: GitOperationLogEntry[], nextBefore: string | null): string {
  if (operations.length === 0) return 'No logged Git operations.\n';
  const lines = operations.map(
    (operation) =>
      `${operation.startedAt}  ${operation.id}  ${operation.kind.padEnd(13)} ` +
      `${operation.status.padEnd(9)} ${operation.commandCount} cmd  ${operation.repositoryRoot}` +
      (operation.error ? `\n    ${operation.error.message}` : ''),
  );
  if (nextBefore) lines.push('', `Older operations: --before ${nextBefore}`);
  return `${lines.join('\n')}\n`;
}

function formatOperationDetails(
  operation: GitOperationLogEntry,
  commands: GitCommandRecord[],
): string {
  const lines = [
    `${operation.kind} — ${operation.status} — ${operation.repositoryRoot}`,
    `Started ${operation.startedAt}; finished ${operation.finishedAt ?? '—'}`,
    ...(operation.summary ? [operation.summary] : []),
    ...(operation.error ? [`Error (${operation.error.code}): ${operation.error.message}`] : []),
  ];
  for (const step of operation.steps ?? []) {
    lines.push(`Step ${step.name}: ${step.status} (${step.command})`);
  }
  for (const command of commands) {
    lines.push(
      '',
      `#${command.sequence} git ${command.args.join(' ')}`,
      `   ${command.outcome}, exit ${command.exitCode ?? '—'}, ${command.durationMs} ms` +
        (command.truncated ? ', output truncated' : ''),
    );
    if (command.stdout)
      lines.push('   stdout:', ...command.stdout.split('\n').map((l) => `     ${l}`));
    if (command.stderr)
      lines.push('   stderr:', ...command.stderr.split('\n').map((l) => `     ${l}`));
  }
  if (commands.length === 0) lines.push('', 'No Git commands were recorded for this operation.');
  return `${lines.join('\n')}\n`;
}

function formatReflog(entries: GitReflogEntry[], search?: string): string {
  if (entries.length === 0) {
    return search ? `No reflog entries match "${search}".\n` : 'The reflog is empty.\n';
  }
  return `${entries
    .map(
      (entry) =>
        `HEAD@{${entry.index}}  ${entry.hash.slice(0, 12)}  ${entry.date ?? '—'}  ` +
        `${entry.atlasOperationId ? 'ATLAS  ' : 'outside'}  ${entry.action}: ${entry.message}`,
    )
    .join('\n')}\n`;
}

const CHANGE_LETTERS: Record<GitCommitFiles['files'][number]['change'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  'type-changed': 'T',
  untracked: '?',
  conflicted: 'U',
};

function formatCommitFiles(details: GitCommitFiles): string {
  const lines = [
    `${details.hash.slice(0, 12)}  ${details.subject}`,
    `${details.author} · ${details.date ?? '—'}`,
    ...(details.parentCount > 1 ? ['Merge commit: compared with its first parent.'] : []),
    '',
    ...details.files.map((file) => {
      const counts = file.added === null ? 'binary' : `+${file.added} -${file.removed ?? 0}`;
      const name = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
      return `${CHANGE_LETTERS[file.change]}  ${counts.padEnd(12)}  ${name}`;
    }),
  ];
  if (details.files.length === 0) lines.push('No file changes.');
  if (details.truncated) lines.push(`Only the first ${details.files.length} files are listed.`);
  return `${lines.join('\n')}\n`;
}

function formatRetrieval(bundle: ContextBundle): string {
  const lines = [
    `Objective: ${bundle.objective ?? '(none)'} · role: ${bundle.role}`,
    `~${bundle.estimatedTokens} of ${bundle.budgetTokens} estimated tokens (${bundle.budgetSource} budget; ` +
      `${bundle.tokenEstimateMethod})`,
  ];
  let section = '';
  for (const reference of bundle.included) {
    if (reference.section !== section) {
      section = reference.section;
      lines.push('', `${section}:`);
    }
    lines.push(
      `  ${String(reference.score).padStart(4)}  ${reference.id}  [${reference.verification}${reference.required ? ', required' : ''}${reference.stale ? ', STALE' : ''}] ${reference.title}`,
    );
  }
  if (bundle.excluded.length > 0) {
    lines.push('', 'Left out:');
    for (const { reference, reason } of bundle.excluded) {
      lines.push(`  ${reason.padEnd(12)}  ${reference.id}  ${reference.title}`);
    }
  }
  if (bundle.warnings.length > 0) {
    lines.push('', 'Warnings:', ...bundle.warnings.map((warning) => `  ${warning.message}`));
  }
  return `${lines.join('\n')}\n`;
}

function formatHealth(report: ContextHealthReport): string {
  const { totals } = report;
  const lines = [
    `${totals.activeEntries} active entries (${totals.requiredEntries} required, ` +
      `${totals.obsoleteEntries} obsolete) · ${totals.activeDecisions} active decisions ` +
      `(${totals.supersededDecisions} superseded) · ${totals.openTasks}/${totals.tasks} open tasks`,
    `Relevant context: ~${report.estimatedRelevantTokens} estimated tokens (${report.tokenEstimateMethod})`,
    `Last reconciliation: ${report.lastReconciliation?.at ?? 'never'}`,
  ];
  const group = (title: string, items: string[]) => {
    lines.push('', `${title}: ${items.length}`, ...items.map((item) => `  - ${item}`));
  };
  group(
    'Stale',
    report.stale.map((item) => item.reason),
  );
  group(
    'Conflicts',
    report.conflicts.map((item) => item.reason),
  );
  group(
    'Duplicates',
    report.duplicates.map((item) => `${item.keptId} (+${item.duplicateIds.length})`),
  );
  group(
    'Pending of closed tasks',
    report.pendingOfClosedTasks.map((item) => item.title),
  );
  group(
    'Without a source',
    report.missingSources.map((item) => item.title),
  );
  if (report.checksTruncated) lines.push('', 'Note: not every reference was checked against Git.');
  lines.push('', 'These are heuristic signals, not a quality score.');
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
