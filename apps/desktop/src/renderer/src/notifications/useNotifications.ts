import type { AtlasNotification, NotificationList } from '@atlas/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { onTerminalLifecycle } from '@/terminal/state/terminal-events';

/** Shown at most at once; older toasts stay in the notification center. */
const MAX_TOASTS = 4;

/**
 * Notification center state. History comes from the Engine (it survives reloads and
 * restarts); changes arrive as events, and new notifications also become toasts.
 */
export function useNotifications() {
  const [list, setList] = useState<NotificationList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<AtlasNotification[]>([]);

  const reload = useCallback(async () => {
    try {
      setList(await unwrap(api().notifications.list({ limit: 200 })));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    unwrap(api().notifications.list({ limit: 200 })).then(setList, (caught: unknown) =>
      setError(errorMessage(caught)),
    );
    const stop = onTerminalLifecycle((event) => {
      if (event.type !== 'notifications') return;
      const created = event.created;
      if (created !== null) {
        setToasts((current) => [...current, created].slice(-MAX_TOASTS));
      }
      void reload();
    });
    const stopRestart = api().app.onEngineRestarted(() => void reload());
    return () => {
      stop();
      stopRestart();
    };
  }, [reload]);

  const act = useCallback(
    async (request: Promise<unknown>) => {
      try {
        await request;
        setError(null);
      } catch (caught) {
        setError(errorMessage(caught));
      }
      await reload();
    },
    [reload],
  );

  const dismissToast = useCallback(
    (id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)),
    [],
  );

  return {
    items: list?.items ?? null,
    unread: list?.unread ?? 0,
    error,
    toasts,
    dismissToast,
    markRead: (id: string) => act(unwrap(api().notifications.markRead(id))),
    markAllRead: () => act(unwrap(api().notifications.markAllRead())),
    remove: (id: string) => {
      dismissToast(id);
      return act(unwrap(api().notifications.remove(id)));
    },
    clear: () => {
      setToasts([]);
      return act(unwrap(api().notifications.clear()));
    },
  };
}

export type NotificationsState = ReturnType<typeof useNotifications>;
