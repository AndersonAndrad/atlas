import {
  ProjectIdSchema,
  TerminalPreferencesSchema,
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

  async updatePreferences(input: unknown): Promise<TerminalPreferences> {
    const changes = parseInput(UpdateTerminalPreferencesSchema, input);
    const current = await this.getPreferences();
    const next = TerminalPreferencesSchema.parse({ ...current, ...stripUndefined(changes) });
    await this.store.set(TERMINAL_PREFERENCES_SETTING, JSON.stringify(next));
    return next;
  }

  async getLayout(projectId: string): Promise<TerminalWorkspaceLayout | null> {
    const id = parseInput(ProjectIdSchema, projectId);
    const raw = await this.store.get(LAYOUT_SETTING_PREFIX + id);
    if (raw === null) return null;
    const parsed = TerminalWorkspaceLayoutSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      this.logger.warn('Stored terminal layout is invalid; discarding it', { projectId: id });
      return null;
    }
    return parsed.data;
  }

  async setLayout(projectId: string, layout: unknown): Promise<void> {
    const id = parseInput(ProjectIdSchema, projectId);
    const parsed = parseInput(TerminalWorkspaceLayoutSchema, layout);
    await this.store.set(LAYOUT_SETTING_PREFIX + id, JSON.stringify(parsed));
  }

  async deleteLayout(projectId: string): Promise<void> {
    await this.store.delete(LAYOUT_SETTING_PREFIX + parseInput(ProjectIdSchema, projectId));
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
