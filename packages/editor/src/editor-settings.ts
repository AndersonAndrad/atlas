import {
  EditorLayoutSchema,
  EditorPreferencesSchema,
  ProjectIdSchema,
  UpdateEditorPreferencesSchema,
  parseInput,
  type EditorLayout,
  type EditorPreferences,
} from '@atlas/contracts';
import { noopLogger, type Logger } from '@atlas/shared';
import type { KeyValueStore } from './ports.js';

export const EDITOR_PREFERENCES_SETTING = 'editor.preferences';
const LAYOUT_SETTING_PREFIX = 'editor.layout.';
const LAST_PROJECT_SETTING = 'editor.lastProject';

/** Editor preferences (FR-1108) and per-project layouts (FR-1110) in application settings. */
export class EditorSettings {
  constructor(
    private readonly store: KeyValueStore,
    private readonly logger: Logger = noopLogger,
  ) {}

  async getPreferences(): Promise<EditorPreferences> {
    const raw = await this.store.get(EDITOR_PREFERENCES_SETTING);
    if (raw === null) return EditorPreferencesSchema.parse({});
    const parsed = EditorPreferencesSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      this.logger.warn('Stored editor preferences are invalid; using defaults');
      return EditorPreferencesSchema.parse({});
    }
    return parsed.data;
  }

  async updatePreferences(input: unknown): Promise<EditorPreferences> {
    const changes = parseInput(UpdateEditorPreferencesSchema, input);
    const next = EditorPreferencesSchema.parse({
      ...(await this.getPreferences()),
      ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)),
    });
    await this.store.set(EDITOR_PREFERENCES_SETTING, JSON.stringify(next));
    return next;
  }

  async getLayout(projectId: string): Promise<EditorLayout | null> {
    const id = parseInput(ProjectIdSchema, projectId);
    const raw = await this.store.get(LAYOUT_SETTING_PREFIX + id);
    if (raw === null) return null;
    const parsed = EditorLayoutSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      this.logger.warn('Stored editor layout is invalid; discarding it', { projectId: id });
      return null;
    }
    return parsed.data;
  }

  async setLayout(projectId: string, layout: unknown): Promise<void> {
    const id = parseInput(ProjectIdSchema, projectId);
    await this.store.set(
      LAYOUT_SETTING_PREFIX + id,
      JSON.stringify(parseInput(EditorLayoutSchema, layout)),
    );
  }

  async getLastProject(): Promise<string | null> {
    const raw = await this.store.get(LAST_PROJECT_SETTING);
    return raw !== null && ProjectIdSchema.safeParse(raw).success ? raw : null;
  }

  async setLastProject(projectId: string | null): Promise<void> {
    if (projectId === null) {
      await this.store.delete(LAST_PROJECT_SETTING);
      return;
    }
    await this.store.set(LAST_PROJECT_SETTING, parseInput(ProjectIdSchema, projectId));
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
