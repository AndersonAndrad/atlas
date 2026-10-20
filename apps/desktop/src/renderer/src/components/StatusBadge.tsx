import { Badge } from '@/components/ui/badge';
import { AVAILABILITY_SHORT } from '@/format';
import { cn } from '@/lib/utils';
import type { AvailabilityStatus } from '@/types';

export function StatusBadge({ status }: { status: AvailabilityStatus }) {
  const available = status === 'available';
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5', available ? 'text-success' : 'text-warning')}
      data-testid="availability"
    >
      <span
        className={cn('size-1.5 rounded-full', available ? 'bg-success' : 'bg-warning')}
        aria-hidden="true"
      />
      {AVAILABILITY_SHORT[status]}
    </Badge>
  );
}
