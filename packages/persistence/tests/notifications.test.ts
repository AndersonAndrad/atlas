import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AtlasNotification } from '@atlas/contracts';
import { SqliteNotificationRepository, openDatabase, type Database } from '@atlas/persistence';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 23, 12, minute)).toISOString();

const notification = (
  n: number,
  overrides: Partial<AtlasNotification> = {},
): AtlasNotification => ({
  id: id(n),
  type: 'SUCCESS',
  category: 'GIT',
  title: `N${n}`,
  message: 'Done.',
  projectId: null,
  sourceName: 'atlas',
  sessionId: null,
  taskId: id(100 + n),
  action: { type: 'git-operation', repositoryRoot: '/repo', operationId: id(100 + n) },
  read: false,
  createdAt: at(n),
  readAt: null,
  ...overrides,
});

describe('SqliteNotificationRepository', () => {
  let db: Database;
  let repository: SqliteNotificationRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    repository = new SqliteNotificationRepository(db);
  });
  afterEach(() => db.close());

  it('stores notifications newest first with their action, and filters unread ones', async () => {
    await repository.insert(notification(1));
    await repository.insert(notification(2, { action: null, type: 'ERROR' }));
    expect(await repository.list({ unreadOnly: false, limit: 10 })).toEqual([
      notification(2, { action: null, type: 'ERROR' }),
      notification(1),
    ]);
    expect(await repository.markRead(id(1), at(5))).toBe(true);
    expect(await repository.markRead(id(9), at(5))).toBe(false);
    expect(await repository.unreadCount()).toBe(1);
    expect((await repository.list({ unreadOnly: true, limit: 10 })).map((item) => item.id)).toEqual(
      [id(2)],
    );
    const [, first] = await repository.list({ unreadOnly: false, limit: 10 });
    expect(first).toMatchObject({ read: true, readAt: at(5) });
  });

  it('marks all read, removes one and clears all', async () => {
    await repository.insert(notification(1));
    await repository.insert(notification(2));
    await repository.markAllRead(at(9));
    expect(await repository.unreadCount()).toBe(0);
    expect(await repository.remove(id(1))).toBe(true);
    expect(await repository.remove(id(1))).toBe(false);
    await repository.clear();
    expect(await repository.list({ unreadOnly: false, limit: 10 })).toEqual([]);
  });

  it('prunes old read ones, then the oldest beyond the limit, keeping pending actions', async () => {
    await repository.insert(notification(1, { readAt: at(2), read: true }));
    await repository.insert(notification(2, { type: 'ACTION_REQUIRED' }));
    await repository.insert(notification(3));
    await repository.insert(notification(4, { readAt: at(30), read: true }));
    await repository.insert(notification(5));

    // Read before minute 10: notification 1.
    expect(await repository.prune({ readBefore: at(10), keep: 10 })).toBe(1);
    // Two over the limit: the read one goes first, then the oldest unread that needs no action.
    expect(await repository.prune({ readBefore: at(10), keep: 2 })).toBe(2);
    expect(
      (await repository.list({ unreadOnly: false, limit: 10 })).map((item) => item.id),
    ).toEqual([id(5), id(2)]);
    // An unread action request is never removed, even beyond the limit.
    expect(await repository.prune({ readBefore: at(10), keep: 0 })).toBe(1);
    expect(
      (await repository.list({ unreadOnly: false, limit: 10 })).map((item) => item.id),
    ).toEqual([id(2)]);
  });

  it('refuses rows that break the table constraints', async () => {
    await expect(repository.insert(notification(1, { title: '' }))).rejects.toMatchObject({
      code: 'PROJECT_PERSISTENCE_ERROR',
    });
  });
});
