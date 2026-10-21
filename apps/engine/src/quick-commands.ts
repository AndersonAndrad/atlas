import {
  ProjectQuickCommandSettingsSchema,
  QUICK_COMMANDS_MAX_COUNT,
  QuickCommandInputSchema,
  QuickCommandSchema,
  type ProjectAction,
  type ProjectQuickCommandSettings,
  type QuickCommand,
  type QuickCommandInput,
  type QuickCommandMove,
} from '@atlas/contracts';
import { AtlasError, noopLogger, type Logger } from '@atlas/shared';

export const QUICK_COMMANDS_KEY = 'quickCommands.library';
const projectKey = (projectId: string) => `quickCommands.project.${projectId}`;

interface StoredLibrary {
  version: 1;
  commands: QuickCommand[];
}

/** The stored library, or null when it is not a valid version-1 library. */
function parseLibrary(value: unknown): QuickCommand[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { version, commands } = value as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(commands) || commands.length > QUICK_COMMANDS_MAX_COUNT) {
    return null;
  }
  const parsed = commands.map((command) => QuickCommandSchema.safeParse(command));
  return parsed.every((result) => result.success) ? parsed.map((result) => result.data!) : null;
}

export interface QuickCommandSettingsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface QuickCommandStoreOptions {
  store: QuickCommandSettingsStore;
  generateId: () => string;
  logger?: Logger;
}

const notFound = () => new AtlasError('QUICK_COMMAND_NOT_FOUND', 'Quick command not found.');

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The user's quick commands (PLAN-023), in the application settings: an ordered library
 * and, per project, the prioritized commands hidden there and the other commands enabled
 * there. Writes are serialized.
 */
export class QuickCommandStore {
  private readonly logger: Logger;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: QuickCommandStoreOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  /** The library in the user's order; empty when nothing (readable) is stored. */
  async list(): Promise<QuickCommand[]> {
    const raw = await this.options.store.get(QUICK_COMMANDS_KEY);
    if (raw === null) return [];
    const commands = parseLibrary(parseJson(raw));
    if (commands === null) {
      this.logger.warn('Stored quick commands are invalid; showing none');
      return [];
    }
    return commands;
  }

  create(input: QuickCommandInput): Promise<QuickCommand> {
    return this.change(async (commands) => {
      if (commands.length >= QUICK_COMMANDS_MAX_COUNT) {
        throw new AtlasError(
          'VALIDATION_FAILED',
          `At most ${QUICK_COMMANDS_MAX_COUNT} quick commands can be kept.`,
          { issues: [{ field: 'name', message: 'Remove a quick command first.' }] },
        );
      }
      const command = { id: this.options.generateId(), ...QuickCommandInputSchema.parse(input) };
      return { commands: [...commands, command], result: command };
    });
  }

  update(id: string, input: QuickCommandInput): Promise<QuickCommand> {
    return this.change(async (commands) => {
      const index = commands.findIndex((command) => command.id === id);
      if (index === -1) throw notFound();
      const command = { id, ...QuickCommandInputSchema.parse(input) };
      return { commands: commands.with(index, command), result: command };
    });
  }

  remove(id: string): Promise<null> {
    return this.change(async (commands) => {
      if (!commands.some((command) => command.id === id)) throw notFound();
      return { commands: commands.filter((command) => command.id !== id), result: null };
    });
  }

  /** Moves a command one place; the first and last stay where they are. */
  move(id: string, direction: QuickCommandMove): Promise<QuickCommand[]> {
    return this.change(async (commands) => {
      const index = commands.findIndex((command) => command.id === id);
      if (index === -1) throw notFound();
      const target = direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= commands.length) return { commands, result: commands };
      const next = [...commands];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return { commands: next, result: next };
    });
  }

  async projectSettings(projectId: string): Promise<ProjectQuickCommandSettings> {
    const raw = await this.options.store.get(projectKey(projectId));
    if (raw === null) return { hidden: [], enabled: [] };
    const stored = parseJson(raw);
    // Settings saved before `enabled` existed (PLAN-023 revision 1) enable nothing.
    const parsed = ProjectQuickCommandSettingsSchema.safeParse(
      stored !== null && typeof stored === 'object' && !Array.isArray(stored)
        ? { enabled: [], ...stored }
        : stored,
    );
    if (!parsed.success) {
      this.logger.warn('Stored project quick command settings are invalid; using the defaults');
      return { hidden: [], enabled: [] };
    }
    return parsed.data;
  }

  async setProjectSettings(
    projectId: string,
    settings: ProjectQuickCommandSettings,
  ): Promise<ProjectQuickCommandSettings> {
    const parsed = ProjectQuickCommandSettingsSchema.parse(settings);
    // Ids of removed commands are dropped, so they never accumulate up to the limit.
    const known = new Set((await this.list()).map((command) => command.id));
    const kept = (ids: string[]) => [...new Set(ids)].filter((id) => known.has(id));
    const value = { hidden: kept(parsed.hidden), enabled: kept(parsed.enabled) };
    await this.serialized(() =>
      this.options.store.set(projectKey(projectId), JSON.stringify(value)),
    );
    return value;
  }

  async removeProject(projectId: string): Promise<void> {
    await this.serialized(() => this.options.store.delete(projectKey(projectId)));
  }

  /**
   * The project's actions: open a terminal, then, in library order, each prioritized
   * command not hidden in the project and each other command enabled in it.
   */
  async projectActions(projectId: string): Promise<ProjectAction[]> {
    const [commands, settings] = await Promise.all([this.list(), this.projectSettings(projectId)]);
    const hidden = new Set(settings.hidden);
    const enabled = new Set(settings.enabled);
    return [
      { kind: 'open-terminal' },
      ...commands
        .filter((command) =>
          command.prioritized ? !hidden.has(command.id) : enabled.has(command.id),
        )
        .map((command) => ({
          kind: 'run-command' as const,
          commandId: command.id,
          name: command.name,
          command: command.command,
        })),
    ];
  }

  /** A command the project offers; refused when unknown or not offered there. */
  async forProject(projectId: string, commandId: string): Promise<QuickCommand> {
    const actions = await this.projectActions(projectId);
    const offered = actions.some(
      (action) => action.kind === 'run-command' && action.commandId === commandId,
    );
    const command = (await this.list()).find((item) => item.id === commandId);
    if (!offered || command === undefined) {
      throw new AtlasError(
        'VALIDATION_FAILED',
        'This quick command is not offered for the project.',
        {
          issues: [
            { field: 'commandId', message: 'This quick command is not offered for the project.' },
          ],
        },
      );
    }
    return command;
  }

  private change<T>(
    apply: (commands: QuickCommand[]) => Promise<{ commands: QuickCommand[]; result: T }>,
  ): Promise<T> {
    return this.serialized(async () => {
      const { commands, result } = await apply(await this.list());
      await this.options.store.set(
        QUICK_COMMANDS_KEY,
        JSON.stringify({ version: 1, commands } satisfies StoredLibrary),
      );
      return result;
    });
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writing.then(task, task);
    this.writing = run.catch(() => undefined);
    return run;
  }
}
