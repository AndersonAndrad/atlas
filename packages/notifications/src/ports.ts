import type { AtlasNotification } from '@atlas/contracts';

/** Storage of notifications (SQLite in the Engine, memory in tests). */
export interface NotificationRepository {
  insert(notification: AtlasNotification): Promise<void>;
  /** Newest first. */
  list(query: { unreadOnly: boolean; limit: number }): Promise<AtlasNotification[]>;
  unreadCount(): Promise<number>;
  /** False when the notification does not exist. */
  markRead(id: string, at: string): Promise<boolean>;
  markAllRead(at: string): Promise<void>;
  /** False when the notification does not exist. */
  remove(id: string): Promise<boolean>;
  clear(): Promise<void>;
  /**
   * Removes read notifications read before `readBefore`, then the oldest ones beyond
   * `keep`: read ones first, then unread ones. Unread ACTION_REQUIRED notifications are
   * never removed. Returns how many were removed.
   */
  prune(options: { readBefore: string; keep: number }): Promise<number>;
}
