import type { BackgroundJob } from '@atlas/contracts';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { openOperationsJob } from '../navigation';

/**
 * Feedback once a dialog handed its operation to the Engine (SDD-025 Task 01): it keeps
 * running in the background; the link opens it in Operations.
 */
export function SubmittedNotice({
  job,
  onDismiss,
  className,
}: {
  job: BackgroundJob;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        'bg-muted/60 flex min-w-0 items-center gap-2 rounded-md border px-2 py-1 text-xs',
        className,
      )}
      data-testid="background-submitted"
    >
      <span className="min-w-0 flex-1 truncate" title={job.title}>
        <span className="font-medium">{job.title}</span> started in the background.
      </span>
      <Button
        variant="link"
        size="sm"
        className="h-auto shrink-0 p-0 text-xs"
        onClick={() => openOperationsJob(job.id)}
      >
        View in Operations
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}
