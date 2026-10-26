import { Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useJobSummary } from '../useJobs';

/**
 * Header indicator of background jobs (SDD-012 FR-1213): how many run and wait. Hidden
 * when nothing does; it never replaces the notification center.
 */
export function OperationsIndicator({ onOpen }: { onOpen: () => void }) {
  const { running, queued, waitingApproval } = useJobSummary();
  if (running + queued + waitingApproval === 0) return null;
  const parts = [
    `${running} running`,
    queued > 0 ? `${queued} queued` : null,
    waitingApproval > 0 ? `${waitingApproval} waiting` : null,
  ].filter((part): part is string => part !== null);
  const label = `Background jobs: ${parts.join(', ')}`;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-xs"
      onClick={onOpen}
      aria-label={label}
      title={label}
      data-testid="operations-indicator"
    >
      <Activity className={running > 0 ? 'text-primary animate-pulse' : undefined} />
      <span>{parts.join(' · ')}</span>
    </Button>
  );
}
