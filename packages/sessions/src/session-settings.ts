import {
  SessionSettingsSchema,
  UpdateSessionSettingsSchema,
  parseInput,
  type SessionSettings,
} from '@atlas/contracts';
import { noopLogger, type Logger } from '@atlas/shared';
import type { KeyValueStore } from './ports.js';

export const SESSION_SETTINGS_KEY = 'sessions.settings';

/**
 * Execution profile limits and the concurrent session limit. They are planning
 * configuration: stored and validated now, applied once a scheduler exists.
 */
export class SessionSettingsStore {
  constructor(
    private readonly store: KeyValueStore,
    private readonly logger: Logger = noopLogger,
  ) {}

  async get(): Promise<SessionSettings> {
    const raw = await this.store.get(SESSION_SETTINGS_KEY);
    if (raw === null) return SessionSettingsSchema.parse({});
    const parsed = SessionSettingsSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      this.logger.warn('Stored session settings are invalid; using defaults');
      return SessionSettingsSchema.parse({});
    }
    return parsed.data;
  }

  async update(input: unknown): Promise<SessionSettings> {
    const changes = parseInput(UpdateSessionSettingsSchema, input);
    const current = await this.get();
    const next = SessionSettingsSchema.parse({
      maxConcurrentSessions: changes.maxConcurrentSessions ?? current.maxConcurrentSessions,
      profiles: changes.profiles ?? current.profiles,
    });
    await this.store.set(SESSION_SETTINGS_KEY, JSON.stringify(next));
    return next;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
