import type { SettingsRepository } from '@atlas/projects';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly db: Database) {}

  async get(key: string): Promise<string | null> {
    return this.run('get', () => {
      const row = this.db
        .prepare('SELECT value FROM application_settings WHERE key = ?')
        .get(key) as { value: string } | undefined;
      return row?.value ?? null;
    });
  }

  async set(key: string, value: string): Promise<void> {
    this.run('set', () => {
      this.db
        .prepare(
          `INSERT INTO application_settings (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, value);
    });
  }

  async delete(key: string): Promise<void> {
    this.run('delete', () => {
      this.db.prepare('DELETE FROM application_settings WHERE key = ?').run(key);
    });
  }

  private run<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw new AtlasError(
        'PROJECT_PERSISTENCE_ERROR',
        `Settings repository ${operation} failed.`,
        {
          cause: error,
          details: { operation },
        },
      );
    }
  }
}
