import {
  DEFAULT_GIT_PREFERENCES,
  GitPreferencesSchema,
  UpdateGitPreferencesSchema,
  parseInput,
  type GitPreferences,
} from '@atlas/contracts';
import type { CommitMessageRules } from '@atlas/conventional-commits';
import { noopLogger, type Logger } from '@atlas/shared';

export const GIT_PREFERENCES_KEY = 'git.preferences';

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Git UI preferences and optional, stricter commit conventions. */
export class GitPreferencesStore {
  constructor(
    private readonly store: KeyValueStore,
    private readonly logger: Logger = noopLogger,
  ) {}

  async get(): Promise<GitPreferences> {
    const raw = await this.store.get(GIT_PREFERENCES_KEY);
    if (raw === null) return { ...DEFAULT_GIT_PREFERENCES };
    const parsed = GitPreferencesSchema.safeParse({ ...DEFAULT_GIT_PREFERENCES, ...safeJson(raw) });
    if (!parsed.success) {
      this.logger.warn('Stored Git preferences are invalid; using defaults');
      return { ...DEFAULT_GIT_PREFERENCES };
    }
    return parsed.data;
  }

  async update(input: unknown): Promise<GitPreferences> {
    const changes = parseInput(UpdateGitPreferencesSchema, input);
    const next = GitPreferencesSchema.parse({ ...(await this.get()), ...changes });
    await this.store.set(GIT_PREFERENCES_KEY, JSON.stringify(next));
    return next;
  }

  async commitRules(): Promise<CommitMessageRules> {
    const preferences = await this.get();
    return {
      types: preferences.commitTypes,
      requireScope: preferences.requireScope,
      ...(preferences.headerMaxLength === null
        ? {}
        : { headerMaxLength: preferences.headerMaxLength }),
    };
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
