import type { AtlasNotification } from '@atlas/contracts';
import { X } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { TYPE_STYLES } from '../format';
import { NotificationIcon, notificationSource } from './NotificationCenter';

interface ToasterProps {
  toasts: AtlasNotification[];
  onOpen: (notification: AtlasNotification) => void;
  onDismiss: (id: string) => void;
}

/**
 * Short-lived cards for new notifications (FR-910), bottom right so they never cover the
 * actions in a view's header. Closing a toast keeps the notification in the center.
 */
export function Toaster({ toasts, onOpen, onDismiss }: ToasterProps) {
  if (toasts.length === 0) return null;
  return (
    <section
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      aria-label="New notifications"
      data-testid="toasts"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onOpen={onOpen} onDismiss={onDismiss} />
      ))}
    </section>
  );
}

function Toast({
  toast,
  onOpen,
  onDismiss,
}: {
  toast: AtlasNotification;
  onOpen: (notification: AtlasNotification) => void;
  onDismiss: (id: string) => void;
}) {
  const closeAfter = TYPE_STYLES[toast.type].autoCloseMs;
  useEffect(() => {
    if (closeAfter === null) return;
    const timer = setTimeout(() => onDismiss(toast.id), closeAfter);
    return () => clearTimeout(timer);
  }, [closeAfter, onDismiss, toast.id]);
  const urgent = toast.type === 'ERROR' || toast.type === 'ACTION_REQUIRED';

  return (
    <div
      className="bg-popover text-popover-foreground pointer-events-auto flex items-start gap-3 rounded-lg border p-3 shadow-lg"
      role={urgent ? 'alert' : 'status'}
      data-testid="toast"
      data-type={toast.type}
    >
      <NotificationIcon notification={toast} />
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer text-left"
        onClick={() => {
          onDismiss(toast.id);
          onOpen(toast);
        }}
      >
        <span className="block truncate text-sm font-medium">{toast.title}</span>
        {toast.message && (
          <span className="text-muted-foreground line-clamp-2 block text-sm break-words">
            {toast.message}
          </span>
        )}
        <span className="text-muted-foreground block truncate text-xs">
          {notificationSource(toast)}
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Close "${toast.title}"`}
        onClick={() => onDismiss(toast.id)}
      >
        <X />
      </Button>
    </div>
  );
}
