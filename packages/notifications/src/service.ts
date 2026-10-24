import {
  NOTIFICATION_MAX_STORED,
  NOTIFICATION_MESSAGE_MAX,
  NOTIFICATION_READ_RETENTION_DAYS,
  NOTIFICATION_TITLE_MAX,
  NotificationActionSchema,
  NotificationListQuerySchema,
  type AtlasNotification,
  type CreateNotificationInput,
  type NotificationList,
  type NotificationListQuery,
} from '@atlas/contracts';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import type { NotificationRepository } from './ports.js';

export interface NotificationServiceOptions {
  repository: NotificationRepository;
  clock: { now(): Date };
  generateId: () => string;
  logger: Logger;
  /** Called after every change; `created` is the notification just published. */
  onChange?: (created: AtlasNotification | null) => void;
  /** Overrides the default retention (FR-905). */
  retention?: { keep: number; readRetentionDays: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Single-line plain text: control characters removed, whitespace collapsed, length capped. */
export function plainText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point.
  const controls = /[\u0000-\u001f\u007f-\u009f]+/g;
  const text = value.replace(controls, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Notification center of the Engine (FR-901). Publishing never throws: a notification
 * that cannot be stored is logged and dropped, so the operation it reports is never
 * affected (FR-922).
 */
export class NotificationService {
  constructor(private readonly options: NotificationServiceOptions) {}

  async publish(input: CreateNotificationInput): Promise<AtlasNotification | null> {
    try {
      const action =
        input.action === undefined || input.action === null
          ? null
          : NotificationActionSchema.parse(input.action);
      const notification: AtlasNotification = {
        id: this.options.generateId(),
        type: input.type,
        category: input.category,
        title: plainText(input.title, NOTIFICATION_TITLE_MAX) || 'Notification',
        message: plainText(input.message, NOTIFICATION_MESSAGE_MAX),
        projectId: input.projectId ?? null,
        sourceName:
          input.sourceName === undefined || input.sourceName === null
            ? null
            : plainText(input.sourceName, NOTIFICATION_TITLE_MAX) || null,
        sessionId: input.sessionId ?? null,
        taskId: input.taskId ?? null,
        action,
        read: false,
        createdAt: this.options.clock.now().toISOString(),
        readAt: null,
      };
      await this.options.repository.insert(notification);
      await this.prune();
      this.changed(notification);
      return notification;
    } catch (error) {
      this.options.logger.warn('Notification could not be published', {
        category: input.category,
        error: describeError(error),
      });
      return null;
    }
  }

  async list(query: NotificationListQuery = {}): Promise<NotificationList> {
    const { unreadOnly, limit } = NotificationListQuerySchema.parse(query);
    const [items, unread] = await Promise.all([
      this.options.repository.list({ unreadOnly, limit }),
      this.options.repository.unreadCount(),
    ]);
    return { items, unread };
  }

  async unreadCount(): Promise<number> {
    return this.options.repository.unreadCount();
  }

  async markAsRead(id: string): Promise<void> {
    if (!(await this.options.repository.markRead(id, this.now()))) {
      throw new AtlasError('NOTIFICATION_NOT_FOUND');
    }
    this.changed(null);
  }

  async markAllAsRead(): Promise<void> {
    await this.options.repository.markAllRead(this.now());
    this.changed(null);
  }

  /** Deletes the notification. */
  async dismiss(id: string): Promise<void> {
    if (!(await this.options.repository.remove(id))) {
      throw new AtlasError('NOTIFICATION_NOT_FOUND');
    }
    this.changed(null);
  }

  async clear(): Promise<void> {
    await this.options.repository.clear();
    this.changed(null);
  }

  private async prune(): Promise<void> {
    const keep = this.options.retention?.keep ?? NOTIFICATION_MAX_STORED;
    const days = this.options.retention?.readRetentionDays ?? NOTIFICATION_READ_RETENTION_DAYS;
    const readBefore = new Date(this.options.clock.now().getTime() - days * DAY_MS).toISOString();
    await this.options.repository.prune({ readBefore, keep });
  }

  private changed(created: AtlasNotification | null): void {
    try {
      this.options.onChange?.(created);
    } catch (error) {
      this.options.logger.warn('Notification listener failed', { error: describeError(error) });
    }
  }

  private now(): string {
    return this.options.clock.now().toISOString();
  }
}
