import {
  DEFAULT_GIT_PREFERENCES,
  DEFAULT_PROJECT_GIT_SETTINGS,
  GitPreferencesSchema,
  ProjectGitSettingsSchema,
  UpdateGitPreferencesSchema,
  parseInput,
  type GitPreferences,
  type ProjectGitSettings,
} from '@atlas/contracts';
import type { CommitMessageRules } from '@atlas/conventional-commits';
import { AtlasError, noopLogger, type Logger } from '@atlas/shared';

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

  /** Preferences to display; defaults when nothing or nothing readable is stored. */
  async get(): Promise<GitPreferences> {
    return (await this.read()).preferences;
  }

  /**
   * Stored preferences with `invalid` set when a stored value exists but cannot be
   * read; `preferences` are then the defaults, so the settings form stays usable.
   */
  async read(): Promise<{ preferences: GitPreferences; invalid: boolean }> {
    const raw = await this.store.get(GIT_PREFERENCES_KEY);
    if (raw === null) return { preferences: { ...DEFAULT_GIT_PREFERENCES }, invalid: false };
    const stored = jsonObject(raw);
    const parsed = GitPreferencesSchema.safeParse({ ...DEFAULT_GIT_PREFERENCES, ...stored });
    if (stored === null || !parsed.success) {
      this.logger.warn('Stored Git preferences are invalid; using defaults for display');
      return { preferences: { ...DEFAULT_GIT_PREFERENCES }, invalid: true };
    }
    return { preferences: parsed.data, invalid: false };
  }

  /** Saves changes on top of the readable preferences (defaults replace invalid ones). */
  async update(input: unknown): Promise<GitPreferences> {
    const changes = parseInput(UpdateGitPreferencesSchema, input);
    const next = GitPreferencesSchema.parse({ ...(await this.get()), ...changes });
    await this.store.set(GIT_PREFERENCES_KEY, JSON.stringify(next));
    return next;
  }

  /**
   * Commit message rules a commit must apply. Invalid stored preferences refuse the
   * commit instead of silently dropping stricter conventions.
   */
  async commitRules(): Promise<CommitMessageRules> {
    const { preferences, invalid } = await this.read();
    if (invalid) {
      const message = 'Git preferences are invalid; open settings to fix.';
      throw new AtlasError('VALIDATION_FAILED', message, {
        issues: [{ field: 'preferences', message }],
      });
    }
    return {
      types: preferences.commitTypes,
      requireScope: preferences.requireScope,
      ...(preferences.headerMaxLength === null
        ? {}
        : { headerMaxLength: preferences.headerMaxLength }),
    };
  }
}

/** The stored JSON object; null when the value is not readable as one. */
function jsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const projectKey = (projectId: string) => `git.project.${projectId}`;

/** Per-project commit settings: Conventional Commits enforcement and pre-commit steps. */
export class ProjectGitSettingsStore {
  constructor(
    private readonly store: KeyValueStore & { delete(key: string): Promise<void> },
    private readonly logger: Logger = noopLogger,
  ) {}

  /** Settings to display; defaults when nothing or nothing readable is stored. */
  async get(projectId: string): Promise<ProjectGitSettings> {
    return (await this.read(projectId)).settings;
  }

  /**
   * Stored settings with `invalid` set when a stored value exists but cannot be
   * read; `settings` are then the defaults, so the settings form stays usable.
   */
  async read(projectId: string): Promise<{ settings: ProjectGitSettings; invalid: boolean }> {
    const raw = await this.store.get(projectKey(projectId));
    if (raw === null)
      return { settings: structuredClone(DEFAULT_PROJECT_GIT_SETTINGS), invalid: false };
    const stored = jsonObject(raw);
    const parsed = ProjectGitSettingsSchema.safeParse({
      ...DEFAULT_PROJECT_GIT_SETTINGS,
      ...stored,
    });
    if (stored === null || !parsed.success) {
      this.logger.warn('Stored project Git settings are invalid; using defaults for display');
      return { settings: structuredClone(DEFAULT_PROJECT_GIT_SETTINGS), invalid: true };
    }
    return { settings: parsed.data, invalid: false };
  }

  /**
   * Settings a commit must apply. Invalid stored settings refuse the commit instead
   * of silently dropping the project's checks.
   */
  async forCommit(projectId: string): Promise<ProjectGitSettings> {
    const { settings, invalid } = await this.read(projectId);
    if (invalid) {
      const message = 'Commit checks settings are invalid; open settings to fix.';
      throw new AtlasError('VALIDATION_FAILED', message, {
        issues: [{ field: 'projectSettings', message }],
      });
    }
    return settings;
  }

  async set(projectId: string, input: unknown): Promise<ProjectGitSettings> {
    const settings = parseInput(ProjectGitSettingsSchema, input);
    await this.store.set(projectKey(projectId), JSON.stringify(settings));
    return settings;
  }

  async remove(projectId: string): Promise<void> {
    await this.store.delete(projectKey(projectId));
  }
}
