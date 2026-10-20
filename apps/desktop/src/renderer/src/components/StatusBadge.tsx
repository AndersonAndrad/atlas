import type { AvailabilityStatus } from '../types';
import { AVAILABILITY_SHORT } from '../format';

export function StatusBadge({ status }: { status: AvailabilityStatus }) {
  const tone = status === 'available' ? 'ok' : 'warn';
  return (
    <span className={`badge badge--${tone}`} data-testid="availability">
      <span className="badge__dot" aria-hidden="true" />
      {AVAILABILITY_SHORT[status]}
    </span>
  );
}
