import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageProfile } from '@atlas/contracts';
import {
  MIGRATIONS,
  SqliteUsageRepository,
  getSchemaVersion,
  openDatabase,
  type Database,
} from '@atlas/persistence';
import type { StoredAiSession } from '@atlas/usage';
import { createTempDir } from '../../../tests/support/temp.js';

const PROFILE = '00000000-0000-4000-8000-000000000001';

const profile: UsageProfile = {
  id: PROFILE,
  providerId: 'claude',
  displayName: 'work',
  profileDirectory: '/home/me/.claude-work',
  origin: 'detected',
  status: 'CONNECTED',
  plan: 'max',
  statusLineEnabled: true,
  hidden: false,
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
  lastUsedAt: null,
  lastSyncAt: null,
  lastError: null,
};

const session = (id: string, updatedAt: string): StoredAiSession => ({
  profileId: PROFILE,
  sessionId: id,
  providerId: 'claude',
  model: 'claude-opus-5-5',
  costBaseUsd: 1.5,
  costRunUsd: 0.25,
  billing: 'SUBSCRIPTION',
  source: 'LOCAL_ESTIMATE',
  firstSeenAt: '2026-10-27T10:00:00.000Z',
  updatedAt,
});

describe('AI session costs in SQLite (Task E01.1)', () => {
  let db: Database;
  let repository: SqliteUsageRepository;

  beforeEach(async () => {
    db = openDatabase({ filePath: ':memory:' });
    repository = new SqliteUsageRepository(db);
    await repository.insertProfile(profile);
  });

  afterEach(() => db.close());

  it('upserts one row per session and lists the newest first', async () => {
    await repository.saveAiSession(session('a', '2026-10-27T10:00:00.000Z'));
    await repository.saveAiSession(session('b', '2026-10-27T11:00:00.000Z'));
    await repository.saveAiSession({
      ...session('a', '2026-10-27T12:00:00.000Z'),
      costRunUsd: 0.75,
      firstSeenAt: '2026-10-27T11:59:00.000Z',
    });
    const listed = await repository.recentAiSessions(PROFILE, 10);
    expect(listed.map((item) => [item.sessionId, item.costBaseUsd, item.costRunUsd])).toEqual([
      ['a', 1.5, 0.75],
      ['b', 1.5, 0.25],
    ]);
    // The first sighting is kept.
    expect(listed[0]?.firstSeenAt).toBe('2026-10-27T10:00:00.000Z');
    expect(await repository.findAiSession(PROFILE, 'missing')).toBeNull();
    expect(await repository.recentAiSessions(PROFILE, 1)).toHaveLength(1);
  });

  it('prunes old sessions and removes them with their profile', async () => {
    await repository.saveAiSession(session('old', '2026-01-01T00:00:00.000Z'));
    await repository.saveAiSession(session('new', '2026-10-27T10:00:00.000Z'));
    await repository.prune('2026-06-01T00:00:00.000Z', '2026-06-01');
    expect((await repository.recentAiSessions(PROFILE, 10)).map((item) => item.sessionId)).toEqual([
      'new',
    ]);
    await repository.removeProfile(PROFILE);
    expect(await repository.recentAiSessions(PROFILE, 10)).toEqual([]);
  });

  it('refuses negative costs and unknown billing kinds', async () => {
    await expect(
      repository.saveAiSession({ ...session('x', '2026-10-27T10:00:00.000Z'), costBaseUsd: -1 }),
    ).rejects.toBeDefined();
    await expect(
      repository.saveAiSession({
        ...session('y', '2026-10-27T10:00:00.000Z'),
        billing: 'FREE' as StoredAiSession['billing'],
      }),
    ).rejects.toBeDefined();
  });
});

describe('migration v16 from a v15 database', () => {
  it('adds the session table without touching usage profiles', async () => {
    const temp = createTempDir();
    try {
      const file = path.join(temp.dir, 'v15.db');
      let db = openDatabase({ filePath: file, migrations: MIGRATIONS.slice(0, 15) });
      await new SqliteUsageRepository(db).insertProfile(profile);
      db.close();
      db = openDatabase({ filePath: file });
      expect(getSchemaVersion(db)).toBe(18);
      expect(db.prepare('SELECT COUNT(*) AS n FROM usage_profiles').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM usage_ai_sessions').get()).toEqual({ n: 0 });
      db.close();
    } finally {
      temp.cleanup();
    }
  });
});
