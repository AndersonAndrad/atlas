import {
  TerminalPreferencesSchema,
  TerminalWorkspaceKeySchema,
  TerminalWorkspaceLayoutSchema,
  UpdateTerminalPreferencesSchema,
  parseInput,
  type TerminalPreferences,
  type TerminalWorkspaceLayout,
} from '@atlas/contracts';
import { noopLogger, type Logger } from '@atlas/shared';
import type { KeyValueStore } from './ports.js';

export const TERMINAL_PREFERENCES_SETTING = 'terminal.preferences';
const LAYOUT_SETTING_PREFIX = 'terminal.layout.';

/** Terminal preferences and per-project workspace layouts. */
export class TerminalSettings {
  constructor(
    private readonly store: KeyValueStore,
    private readonly logger: Logger = noopLogger,
  ) {}

  async getPreferences(): Promise<TerminalPreferences> {
    const raw = await this.store.get(TERMINAL_PREFERENCES_SETTING);
    if (raw === null) return TerminalPreferencesSchema.parse({});
    const parsed = TerminalPreferencesSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      this.logger.warn('Stored terminal preferences are invalid; using defaults');
      return TerminalPreferencesSchema.parse({});
    }
    return parsed.data;
  }

  /**
   * `resolveDirectory` validates a new default working directory and returns its
   * realpath (the caller provides it so this class stays filesystem-free).
   */
  async updatePreferences(
    input: unknown,
    resolveDirectory?: (path: string) => Promise<string>,
  ): Promise<TerminalPreferences> {
    const changes = parseInput(UpdateTerminalPreferencesSchema, input);
    if (changes.defaultWorkingDirectory != null && resolveDirectory !== undefined) {
      changes.defaultWorkingDirectory = await resolveDirectory(changes.defaultWorkingDirectory);
    }
    const current = await this.getPreferences();
    const next = TerminalPreferencesSchema.parse({ ...current, ...stripUndefined(changes) });
    await this.store.set(TERMINAL_PREFERENCES_SETTING, JSON.stringify(next));
    return next;
  }

  /** Layout of a workspace: a terminal group id or `ungrouped`. */
  async getLayout(workspace: string): Promise<TerminalWorkspaceLayout | null> {
    const id = parseInput(TerminalWorkspaceKeySchema, workspace);
    const raw = await this.store.get(LAYOUT_SETTING_PREFIX + id);
    if (raw === null) return null;
    const parsed = TerminalWorkspaceLayoutSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      this.logger.warn('Stored terminal layout is invalid; discarding it', { workspace: id });
      return null;
    }
    return parsed.data;
  }

  async setLayout(workspace: string, layout: unknown): Promise<void> {
    const id = parseInput(TerminalWorkspaceKeySchema, workspace);
    const parsed = parseInput(TerminalWorkspaceLayoutSchema, layout);
    await this.store.set(LAYOUT_SETTING_PREFIX + id, JSON.stringify(parsed));
  }

  async deleteLayout(workspace: string): Promise<void> {
    await this.store.delete(
      LAYOUT_SETTING_PREFIX + parseInput(TerminalWorkspaceKeySchema, workspace),
    );
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
