import type {
  AiProvider,
  LimitWindowKind,
  UsageDayValue,
  UsageMetric,
  UsageProfile,
  UsageProfileStatus,
  UsageSource,
} from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import type { LimitSnapshot, UsageRepository } from '@atlas/usage';
import type { Database } from './database.js';

type Row = Record<string, string | number | null>;

const str = (row: Row, key: string) => row[key] as string;
const strOrNull = (row: Row, key: string) => (row[key] as string | null) ?? null;

function toProfile(row: Row): UsageProfile {
  const lastError = strOrNull(row, 'last_error');
  return {
    id: str(row, 'id'),
    providerId: str(row, 'provider') as AiProvider,
    displayName: str(row, 'display_name'),
    profileDirectory: str(row, 'directory'),
    origin: str(row, 'origin') as UsageProfile['origin'],
    status: str(row, 'status') as UsageProfileStatus,
    plan: strOrNull(row, 'plan'),
    statusLineEnabled: row.status_line_enabled === 1,
    hidden: row.hidden === 1,
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
    lastUsedAt: strOrNull(row, 'last_used_at'),
    lastSyncAt: strOrNull(row, 'last_sync_at'),
    lastError: lastError === null ? null : (JSON.parse(lastError) as UsageProfile['lastError']),
  };
}

function toSnapshot(row: Row): LimitSnapshot {
  return {
    key: str(row, 'window_key'),
    kind: str(row, 'kind') as LimitWindowKind,
    label: str(row, 'label'),
    usedPercent: row.used_percent as number,
    windowMinutes: (row.window_minutes as number | null) ?? null,
    resetsAt: strOrNull(row, 'resets_at'),
    observedAt: str(row, 'observed_at'),
    source: str(row, 'source') as UsageSource,
  };
}

function toDay(row: Row): UsageDayValue {
  return {
    date: str(row, 'date'),
    metric: str(row, 'metric') as UsageMetric,
    unit: str(row, 'unit'),
    value: row.value as number,
    source: str(row, 'source') as UsageSource,
    isEstimated: row.is_estimated === 1,
  };
}

/** SQLite storage of account profiles and usage observations (migration v9). */
export class SqliteUsageRepository implements UsageRepository {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Usage data could not be saved.', {
        cause: error,
        details: { operation },
      });
    }
  }

  async listProfiles(): Promise<UsageProfile[]> {
    return this.run('listProfiles', () =>
      (
        this.db
          .prepare('SELECT * FROM usage_profiles ORDER BY provider, display_name, directory')
          .all() as Row[]
      ).map(toProfile),
    );
  }

  async findProfile(id: string): Promise<UsageProfile | null> {
    return this.run('findProfile', () => {
      const row = this.db.prepare('SELECT * FROM usage_profiles WHERE id = ?').get(id) as
        Row | undefined;
      return row ? toProfile(row) : null;
    });
  }

  async findProfileByDirectory(
    providerId: AiProvider,
    directory: string,
  ): Promise<UsageProfile | null> {
    return this.run('findProfileByDirectory', () => {
      const row = this.db
        .prepare('SELECT * FROM usage_profiles WHERE provider = ? AND directory = ?')
        .get(providerId, directory) as Row | undefined;
      return row ? toProfile(row) : null;
    });
  }

  private profileValues(profile: UsageProfile) {
    return [
      profile.providerId,
      profile.displayName,
      profile.profileDirectory,
      profile.origin,
      profile.status,
      profile.plan,
      profile.statusLineEnabled ? 1 : 0,
      profile.hidden ? 1 : 0,
      profile.createdAt,
      profile.updatedAt,
      profile.lastUsedAt,
      profile.lastSyncAt,
      profile.lastError === null ? null : JSON.stringify(profile.lastError),
    ];
  }

  async insertProfile(profile: UsageProfile): Promise<void> {
    this.run('insertProfile', () => {
      this.db
        .prepare(
          `INSERT INTO usage_profiles (provider, display_name, directory, origin, status, plan,
             status_line_enabled, hidden, created_at, updated_at, last_used_at, last_sync_at,
             last_error, id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...this.profileValues(profile), profile.id);
    });
  }

  async updateProfile(profile: UsageProfile): Promise<void> {
    this.run('updateProfile', () => {
      this.db
        .prepare(
          `UPDATE usage_profiles SET provider = ?, display_name = ?, directory = ?, origin = ?,
             status = ?, plan = ?, status_line_enabled = ?, hidden = ?, created_at = ?,
             updated_at = ?, last_used_at = ?, last_sync_at = ?, last_error = ?
           WHERE id = ?`,
        )
        .run(...this.profileValues(profile), profile.id);
    });
  }

  async removeProfile(id: string): Promise<void> {
    this.run('removeProfile', () => {
      this.db.prepare('DELETE FROM usage_profiles WHERE id = ?').run(id);
    });
  }

  async latestWindows(profileId: string): Promise<LimitSnapshot[]> {
    return this.run('latestWindows', () =>
      (
        this.db
          .prepare(
            `SELECT s.* FROM usage_window_snapshots s
             JOIN (SELECT window_key, MAX(observed_at) AS observed_at FROM usage_window_snapshots
                   WHERE profile_id = ? GROUP BY window_key) latest
               ON latest.window_key = s.window_key AND latest.observed_at = s.observed_at
             WHERE s.profile_id = ?`,
          )
          .all(profileId, profileId) as Row[]
      ).map(toSnapshot),
    );
  }

  async addWindowSnapshot(profileId: string, snapshot: LimitSnapshot): Promise<void> {
    this.run('addWindowSnapshot', () => {
      // The same window observed twice at the same instant is one observation.
      this.db
        .prepare(
          `INSERT OR REPLACE INTO usage_window_snapshots (profile_id, window_key, kind, label,
             used_percent, window_minutes, resets_at, observed_at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          profileId,
          snapshot.key,
          snapshot.kind,
          snapshot.label,
          snapshot.usedPercent,
          snapshot.windowMinutes,
          snapshot.resetsAt,
          snapshot.observedAt,
          snapshot.source,
        );
    });
  }

  async setDaily(profileId: string, value: UsageDayValue): Promise<void> {
    this.run('setDaily', () => {
      this.db
        .prepare(
          `INSERT INTO usage_daily (profile_id, date, metric, source, unit, is_estimated, value)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (profile_id, date, metric, source)
           DO UPDATE SET value = excluded.value, unit = excluded.unit,
             is_estimated = excluded.is_estimated`,
        )
        .run(...this.dayValues(profileId, value));
    });
  }

  async addDaily(profileId: string, value: UsageDayValue): Promise<void> {
    this.run('addDaily', () => {
      this.db
        .prepare(
          `INSERT INTO usage_daily (profile_id, date, metric, source, unit, is_estimated, value)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (profile_id, date, metric, source)
           DO UPDATE SET value = usage_daily.value + excluded.value`,
        )
        .run(...this.dayValues(profileId, value));
    });
  }

  private dayValues(profileId: string, value: UsageDayValue) {
    return [
      profileId,
      value.date,
      value.metric,
      value.source,
      value.unit,
      value.isEstimated ? 1 : 0,
      value.value,
    ] as const;
  }

  async daily(profileId: string, fromDate: string): Promise<UsageDayValue[]> {
    return this.run('daily', () =>
      (
        this.db
          .prepare(
            `SELECT * FROM usage_daily WHERE profile_id = ? AND date >= ?
             ORDER BY date, metric, source`,
          )
          .all(profileId, fromDate) as Row[]
      ).map(toDay),
    );
  }

  async sessionProgress(
    profileId: string,
    sessionId: string,
    metric: UsageMetric,
  ): Promise<number | null> {
    return this.run('sessionProgress', () => {
      const row = this.db
        .prepare(
          `SELECT value FROM usage_session_progress
           WHERE profile_id = ? AND session_id = ? AND metric = ?`,
        )
        .get(profileId, sessionId, metric) as { value: number } | undefined;
      return row?.value ?? null;
    });
  }

  async setSessionProgress(
    profileId: string,
    sessionId: string,
    metric: UsageMetric,
    value: number,
    at: string,
  ): Promise<void> {
    this.run('setSessionProgress', () => {
      this.db
        .prepare(
          `INSERT INTO usage_session_progress (profile_id, session_id, metric, value, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (profile_id, session_id, metric)
           DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(profileId, sessionId, metric, value, at);
    });
  }

  async prune(before: string, beforeDate: string): Promise<void> {
    this.run('prune', () => {
      this.db.prepare('DELETE FROM usage_window_snapshots WHERE observed_at < ?').run(before);
      this.db.prepare('DELETE FROM usage_session_progress WHERE updated_at < ?').run(before);
      this.db.prepare('DELETE FROM usage_daily WHERE date < ?').run(beforeDate);
    });
  }
}
