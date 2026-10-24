import { z } from 'zod';

// ---------------------------------------------------------------------------
// Notifications (SDD-009 Milestone A, PLAN-030)
// ---------------------------------------------------------------------------

export const NOTIFICATION_TYPES = [
  'INFO',
  'SUCCESS',
  'WARNING',
  'ERROR',
  'ACTION_REQUIRED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_CATEGORIES = [
  'SYSTEM',
  'PROJECT',
  'TERMINAL',
  'GIT',
  'PREFLIGHT',
  'AGENT',
  'SESSION',
  'BACKGROUND_TASK',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_TITLE_MAX = 120;
export const NOTIFICATION_MESSAGE_MAX = 500;
/** Stored notifications beyond this are removed, read ones first (FR-905). */
export const NOTIFICATION_MAX_STORED = 1_000;
/** Read notifications older than this are removed. */
export const NOTIFICATION_READ_RETENTION_DAYS = 30;

export const NotificationIdSchema = z.uuid({ message: 'Invalid notification identifier.' });

/**
 * Where a notification leads (FR-908). Only internal destinations: never a command or a
 * URL. The renderer checks the target still exists before showing it.
 */
export const NotificationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('git-operation'),
    repositoryRoot: z.string().min(1).max(4096),
    operationId: z.uuid(),
  }),
  z.object({
    type: z.literal('preflight-run'),
    workspaceId: z.uuid(),
    runId: z.uuid(),
  }),
]);
export type NotificationAction = z.infer<typeof NotificationActionSchema>;

export interface AtlasNotification {
  id: string;
  type: NotificationType;
  category: NotificationCategory;
  /** Plain text; never rendered as HTML. */
  title: string;
  message: string;
  projectId: string | null;
  /** Shown with the notification, e.g. the project or repository name. */
  sourceName: string | null;
  sessionId: string | null;
  /** The operation the notification is about, e.g. a Git operation or Preflight run id. */
  taskId: string | null;
  action: NotificationAction | null;
  read: boolean;
  createdAt: string;
  readAt: string | null;
}

/** What publishers provide; the service assigns id, timestamps and read state. */
export interface CreateNotificationInput {
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  message: string;
  projectId?: string | null;
  sourceName?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  action?: NotificationAction | null;
}

export const NotificationListQuerySchema = z.strictObject({
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(NOTIFICATION_MAX_STORED).default(200),
});
export type NotificationListQuery = z.input<typeof NotificationListQuerySchema>;

export interface NotificationList {
  items: AtlasNotification[];
  unread: number;
}

/** Work that stops when the application quits; asked before closing the window. */
export interface BackgroundWork {
  gitOperations: number;
  preflightRuns: number;
}
