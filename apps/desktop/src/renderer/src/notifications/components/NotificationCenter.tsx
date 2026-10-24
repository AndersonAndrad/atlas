import type { AtlasNotification } from '@atlas/contracts';
import { Bell, Check, CheckCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { relativeTime } from '@/components/git/git-format';
import { cn } from '@/lib/utils';
import { CATEGORY_LABELS, TYPE_STYLES } from '../format';
import type { NotificationsState } from '../useNotifications';

interface NotificationCenterProps {
  state: NotificationsState;
  /** Opens what the notification is about; resolves once navigation was attempted. */
  onOpen: (notification: AtlasNotification) => Promise<void>;
}

/** Severity icon of a notification, in a tinted circle. */
export function NotificationIcon({ notification }: { notification: AtlasNotification }) {
  const style = TYPE_STYLES[notification.type];
  const Icon = style.icon;
  return (
    <span
      className={cn('grid size-7 shrink-0 place-items-center rounded-md', style.tone)}
      role="img"
      aria-label={style.label}
    >
      <Icon className="size-4" />
    </span>
  );
}

/** "Git · atlas" style line under a notification. */
export function notificationSource(notification: AtlasNotification): string {
  return [CATEGORY_LABELS[notification.category], notification.sourceName]
    .filter((part) => part !== null && part !== '')
    .join(' · ');
}

/** Bell with the unread count; opens the list of notifications (FR-906, FR-907). */
export function NotificationCenter({ state, onOpen }: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const items = (state.items ?? []).filter((item) => filter === 'all' || !item.read);
  const label = state.unread > 0 ? `Notifications (${state.unread} unread)` : 'Notifications';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={label}
          title={label}
          data-testid="notifications-button"
        >
          <Bell />
          {state.unread > 0 && (
            <span
              className="bg-destructive text-destructive-foreground ring-background pointer-events-none absolute -top-1 -right-1 min-w-4 rounded-full px-1 text-[10px] leading-4 font-semibold tabular-nums ring-2"
              aria-hidden="true"
              data-testid="notifications-unread"
            >
              {state.unread > 99 ? '99+' : state.unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex max-h-[min(36rem,calc(100vh-4rem))] w-[min(26rem,calc(100vw-2rem))] flex-col gap-2 p-0"
        data-testid="notification-center"
      >
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <Bell className="size-4" />
          <h2 className="text-sm font-semibold">Notifications</h2>
          {state.unread > 0 && (
            <span className="bg-destructive/10 text-destructive rounded-full px-1.5 text-xs tabular-nums">
              {state.unread}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              disabled={state.unread === 0}
              onClick={() => void state.markAllRead()}
            >
              <CheckCheck />
              Mark all read
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={(state.items ?? []).length === 0}
              onClick={() => void state.clear()}
            >
              <Trash2 />
              Clear all
            </Button>
          </div>
        </div>
        <Tabs
          value={filter}
          onValueChange={(value) => setFilter(value === 'unread' ? 'unread' : 'all')}
          className="px-3"
        >
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="unread">Unread</TabsTrigger>
          </TabsList>
        </Tabs>
        {state.error && (
          <p className="text-destructive px-3 text-xs" role="alert">
            {state.error}
          </p>
        )}
        <ul
          className="min-h-0 flex-1 overflow-y-auto px-1 pb-1"
          aria-label="Notifications"
          data-testid="notification-list"
        >
          {state.items !== null && items.length === 0 && (
            <li className="text-muted-foreground px-2 py-8 text-center text-sm">
              {filter === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}
            </li>
          )}
          {items.map((notification) => (
            <li
              key={notification.id}
              className={cn(
                'group flex items-start gap-3 rounded-md px-2 py-2.5',
                !notification.read && 'bg-muted/50',
              )}
              data-testid="notification"
              data-read={notification.read}
              data-type={notification.type}
            >
              <NotificationIcon notification={notification} />
              <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer text-left"
                onClick={() => {
                  setOpen(false);
                  void onOpen(notification);
                }}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {notification.title}
                  </span>
                  <time
                    className="text-muted-foreground shrink-0 text-xs"
                    dateTime={notification.createdAt}
                    title={new Date(notification.createdAt).toLocaleString()}
                  >
                    {relativeTime(notification.createdAt)}
                  </time>
                </span>
                {notification.message && (
                  <span className="text-muted-foreground line-clamp-2 block text-sm break-words">
                    {notification.message}
                  </span>
                )}
                <span className="text-muted-foreground block truncate text-xs">
                  {notificationSource(notification)}
                </span>
              </button>
              <div className="flex shrink-0 flex-col gap-1">
                {!notification.read && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Mark "${notification.title}" as read`}
                    title="Mark as read"
                    onClick={() => void state.markRead(notification.id)}
                  >
                    <Check />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Delete "${notification.title}"`}
                  title="Delete"
                  onClick={() => void state.remove(notification.id)}
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground border-t px-3 py-2 text-xs">
          Stored on this computer. Read notifications are removed after 30 days.
        </p>
      </PopoverContent>
    </Popover>
  );
}
