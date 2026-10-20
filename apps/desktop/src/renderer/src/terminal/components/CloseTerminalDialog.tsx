import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { TerminalSession } from '@atlas/contracts';

interface CloseTerminalDialogProps {
  session: TerminalSession;
  processName?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Confirms terminating a terminal whose shell is running a program. */
export function CloseTerminalDialog({
  session,
  processName,
  onCancel,
  onConfirm,
}: CloseTerminalDialogProps) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent data-testid="close-terminal-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Terminate “{session.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {processName ? (
              <>
                <strong className="text-foreground">{processName}</strong> is still running in this
                terminal.
              </>
            ) : (
              'A program may still be running in this terminal.'
            )}{' '}
            Closing the tab terminates the process. To keep it running, hide the pane instead.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>Keep running</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Terminate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
