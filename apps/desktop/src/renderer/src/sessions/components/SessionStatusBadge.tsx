import type { AtlasSessionStatus } from '@atlas/contracts';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { SESSION_STATUS, type StatusTone } from '../format';

const TONE_CLASSES: Record<StatusTone, { text: string; dot: string }> = {
  neutral: { text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  info: { text: 'text-sidebar-primary', dot: 'bg-sidebar-primary' },
  success: { text: 'text-success', dot: 'bg-success' },
  warning: { text: 'text-warning', dot: 'bg-warning' },
  danger: { text: 'text-destructive', dot: 'bg-destructive' },
};

export function SessionStatusBadge({ status }: { status: AtlasSessionStatus }) {
  const { label, tone } = SESSION_STATUS[status];
  const classes = TONE_CLASSES[tone];
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5', classes.text)}
      data-testid="session-status"
      data-status={status}
    >
      <span className={cn('size-1.5 rounded-full', classes.dot)} aria-hidden="true" />
      {label}
    </Badge>
  );
}
