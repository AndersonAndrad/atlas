import type {
  AtlasNotification,
  NotificationAction,
  NotificationCategory,
  NotificationType,
} from '@atlas/contracts';
import type { NotificationRepository } from '@atlas/notifications';
import { AtlasError } from '@atlas/shared';
import type { Database } from './database.js';

type Row = Record<string, string | number | null>;

const strOrNull = (row: Row, key: string) => (row[key] as string | null) ?? null;

function toNotification(row: Row): AtlasNotification {
  const action = strOrNull(row, 'action');
  const readAt = strOrNull(row, 'read_at');
  return {
    id: row.id as string,
    type: row.type as NotificationType,
    category: row.category as NotificationCategory,
    title: row.title as string,
    message: row.message as string,
    projectId: strOrNull(row, 'project_id'),
    sourceName: strOrNull(row, 'source_name'),
    sessionId: strOrNull(row, 'session_id'),
    taskId: strOrNull(row, 'task_id'),
    action: action === null ? null : (JSON.parse(action) as NotificationAction),
    read: readAt !== null,
    createdAt: row.created_at as string,
    readAt,
  };
}

/** SQLite storage of the notification center (migration v11). */
export class SqliteNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Database) {}

  private run<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('PROJECT_PERSISTENCE_ERROR', 'Notifications could not be saved.', {
        cause: error,
        details: { operation },
      });
    }
  }

  async insert(notification: AtlasNotification): Promise<void> {
    this.run('insert', () => {
      this.db
        .prepare(
          `INSERT INTO notifications (id, type, category, title, message, project_id, source_name,
             session_id, task_id, action, read_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          notification.id,
          notification.type,
          notification.category,
          notification.title,
          notification.message,
          notification.projectId,
          notification.sourceName,
          notification.sessionId,
          notification.taskId,
          notification.action === null ? null : JSON.stringify(notification.action),
          notification.readAt,
          notification.createdAt,
        );
    });
  }

  async list(query: { unreadOnly: boolean; limit: number }): Promise<AtlasNotification[]> {
    return this.run('list', () =>
      (
        this.db
          .prepare(
            `SELECT * FROM notifications ${query.unreadOnly ? 'WHERE read_at IS NULL' : ''}
             ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(query.limit) as Row[]
      ).map(toNotification),
    );
  }

  async unreadCount(): Promise<number> {
    return this.run('unreadCount', () => {
      const row = this.db
        .prepare('SELECT count(*) AS count FROM notifications WHERE read_at IS NULL')
        .get() as Row;
      return Number(row.count);
    });
  }

  async markRead(id: string, at: string): Promise<boolean> {
    return this.run('markRead', () => {
      const exists = this.db.prepare('SELECT 1 FROM notifications WHERE id = ?').get(id);
      if (exists === undefined) return false;
      this.db
        .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL')
        .run(at, id);
      return true;
    });
  }

  async markAllRead(at: string): Promise<void> {
    this.run('markAllRead', () => {
      this.db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(at);
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.run(
      'remove',
      () => Number(this.db.prepare('DELETE FROM notifications WHERE id = ?').run(id).changes) > 0,
    );
  }

  async clear(): Promise<void> {
    this.run('clear', () => {
      this.db.prepare('DELETE FROM notifications').run();
    });
  }

  async prune({ readBefore, keep }: { readBefore: string; keep: number }): Promise<number> {
    return this.run('prune', () => {
      let removed = Number(
        this.db
          .prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?')
          .run(readBefore).changes,
      );
      // Oldest beyond `keep`: read ones first, then unread ones that need no action.
      for (const condition of [
        'read_at IS NOT NULL',
        "read_at IS NULL AND type <> 'ACTION_REQUIRED'",
      ]) {
        const total = Number(
          (this.db.prepare('SELECT count(*) AS count FROM notifications').get() as Row).count,
        );
        if (total <= keep) break;
        removed += Number(
          this.db
            .prepare(
              `DELETE FROM notifications WHERE id IN (
                 SELECT id FROM notifications WHERE ${condition}
                 ORDER BY created_at, rowid LIMIT ?)`,
            )
            .run(total - keep).changes,
        );
      }
      return removed;
    });
  }
}
