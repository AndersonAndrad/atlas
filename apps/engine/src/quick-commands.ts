import {
  QUICK_COMMANDS_MAX_COUNT,
  QuickCommandAssignmentSchema,
  QuickCommandInputSchema,
  parseInput,
  quickCommandAvailableIn,
  type ProjectAction,
  type QuickCommand,
  type QuickCommandMove,
} from '@atlas/contracts';
import { AtlasError, noopLogger, type Logger } from '@atlas/shared';

/** What a command stores (see SqliteQuickCommandRepository). */
interface StoredQuickCommand {
  id: string;
  name: string;
  command: string;
  scope: QuickCommand['scope'];
  projectIds: string[];
}

/** Persistence of quick commands; implemented by SqliteQuickCommandRepository. */
export interface QuickCommandRepository {
  list(): Promise<QuickCommand[]>;
  count(): Promise<number>;
  insert(command: StoredQuickCommand, now: string): Promise<void>;
  update(command: StoredQuickCommand, now: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  swap(first: string, second: string): Promise<void>;
  setAssignment(
    commandId: string,
    projectId: string,
    assigned: boolean,
    now: string,
  ): Promise<void>;
}

export interface QuickCommandStoreOptions {
  repository: QuickCommandRepository;
  /** The ids among `ids` that are not registered projects. */
  unknownProjects: (ids: string[]) => Promise<string[]>;
  clock: { now(): Date };
  generateId: () => string;
  logger?: Logger;
}

const notFound = () => new AtlasError('QUICK_COMMAND_NOT_FOUND', 'Quick command not found.');

const notOffered = () =>
  new AtlasError('VALIDATION_FAILED', 'This quick command is not offered here.', {
    issues: [{ field: 'commandId', message: 'This quick command is not offered here.' }],
  });

/**
 * The user's quick commands (PLAN-023, SDD-025 Task 03): an ordered list, each available in
 * every project (no project selected) or only in the projects selected for it, by id.
 * Writes are serialized; projects are checked against the registry, never trusted.
 */
export class QuickCommandStore {
  private readonly logger: Logger;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: QuickCommandStoreOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  /** Every command in the user's order. */
  list(): Promise<QuickCommand[]> {
    return this.options.repository.list();
  }

  create(input: unknown): Promise<QuickCommand> {
    const value = parseInput(QuickCommandInputSchema, input);
    return this.serialized(async () => {
      if ((await this.options.repository.count()) >= QUICK_COMMANDS_MAX_COUNT) {
        throw new AtlasError(
          'VALIDATION_FAILED',
          `At most ${QUICK_COMMANDS_MAX_COUNT} quick commands can be kept.`,
          { issues: [{ field: 'name', message: 'Remove a quick command first.' }] },
        );
      }
      const stored = await this.toStored(this.options.generateId(), value);
      await this.options.repository.insert(stored, this.now());
      this.logger.info('Quick command created', { commandId: stored.id, scope: stored.scope });
      return this.require(stored.id);
    });
  }

  update(id: string, input: unknown): Promise<QuickCommand> {
    const value = parseInput(QuickCommandInputSchema, input);
    return this.serialized(async () => {
      const stored = await this.toStored(id, value);
      if (!(await this.options.repository.update(stored, this.now()))) throw notFound();
      return this.require(id);
    });
  }

  remove(id: string): Promise<null> {
    return this.serialized(async () => {
      if (!(await this.options.repository.remove(id))) throw notFound();
      return null;
    });
  }

  /** Moves a command one place; the first and last stay where they are. */
  move(id: string, direction: QuickCommandMove): Promise<QuickCommand[]> {
    return this.serialized(async () => {
      const commands = await this.list();
      const index = commands.findIndex((command) => command.id === id);
      if (index === -1) throw notFound();
      const target = commands[direction === 'up' ? index - 1 : index + 1];
      if (target === undefined) return commands;
      await this.options.repository.swap(id, target.id);
      return this.list();
    });
  }

  /**
   * Adds this project to a command limited to projects, or removes it (project details).
   * A command of every project is edited in Quick commands instead; removing a command's
   * last project leaves it available nowhere, never everywhere.
   */
  setAssignment(input: unknown): Promise<QuickCommand> {
    const value = parseInput(QuickCommandAssignmentSchema, input);
    return this.serialized(async () => {
      const command = await this.require(value.commandId);
      if (command.scope === 'ALL') {
        throw new AtlasError(
          'VALIDATION_FAILED',
          'This quick command is available in every project. Edit it in Quick commands.',
          { issues: [{ field: 'commandId', message: 'Available in every project.' }] },
        );
      }
      if (value.assigned) await this.assertProjects([value.projectId]);
      await this.options.repository.setAssignment(
        value.commandId,
        value.projectId,
        value.assigned,
        this.now(),
      );
      return this.require(value.commandId);
    });
  }

  /**
   * The project's actions: open a terminal, then, in the user's order, each command
   * available in the project.
   */
  async projectActions(projectId: string): Promise<ProjectAction[]> {
    const commands = await this.list();
    return [
      { kind: 'open-terminal' },
      ...commands
        .filter((command) => quickCommandAvailableIn(command, projectId))
        .map((command) => ({
          kind: 'run-command' as const,
          commandId: command.id,
          name: command.name,
          command: command.command,
        })),
    ];
  }

  /**
   * A command that may run with this project (null: without a project, only commands of
   * every project); refused when unknown or not offered there.
   */
  async forProject(projectId: string | null, commandId: string): Promise<QuickCommand> {
    const command = (await this.list()).find((item) => item.id === commandId);
    if (command === undefined || !quickCommandAvailableIn(command, projectId)) {
      throw notOffered();
    }
    return command;
  }

  private async toStored(
    id: string,
    value: { name: string; command: string; projectIds: string[] },
  ): Promise<StoredQuickCommand> {
    await this.assertProjects(value.projectIds);
    return {
      id,
      name: value.name,
      command: value.command,
      scope: value.projectIds.length === 0 ? 'ALL' : 'PROJECTS',
      projectIds: value.projectIds,
    };
  }

  private async assertProjects(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const unknown = await this.options.unknownProjects(ids);
    if (unknown.length > 0) {
      throw new AtlasError('VALIDATION_FAILED', 'A selected project is no longer registered.', {
        issues: [{ field: 'projectIds', message: 'A selected project is no longer registered.' }],
      });
    }
  }

  private async require(id: string): Promise<QuickCommand> {
    const command = (await this.list()).find((item) => item.id === id);
    if (command === undefined) throw notFound();
    return command;
  }

  private now(): string {
    return this.options.clock.now().toISOString();
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writing.then(task, task);
    this.writing = run.catch(() => undefined);
    return run;
  }
}
