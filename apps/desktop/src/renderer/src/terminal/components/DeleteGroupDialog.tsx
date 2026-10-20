import type { TerminalGroup } from '@atlas/contracts';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

interface DeleteGroupDialogProps {
  group: TerminalGroup;
  terminalCount: number;
  runningCount: number;
  onConfirm: (terminateTerminals: boolean) => Promise<void>;
  onClose: () => void;
}

/** Deleting a group keeps its terminals unless the user explicitly terminates them. */
export function DeleteGroupDialog(props: DeleteGroupDialogProps) {
  const [busy, setBusy] = useState(false);
  const confirm = async (terminate: boolean) => {
    setBusy(true);
    await props.onConfirm(terminate);
    setBusy(false);
  };
  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <AlertDialogContent data-testid="delete-group-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">
            Delete “{props.group.name}”?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {props.terminalCount === 0
              ? 'The group is empty.'
              : `Its ${props.terminalCount} terminal${props.terminalCount === 1 ? '' : 's'} will move to Ungrouped and keep running.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {props.runningCount > 0 && (
            <Button variant="outline" disabled={busy} onClick={() => void confirm(true)}>
              Delete and terminate {props.runningCount}
            </Button>
          )}
          <Button variant="destructive" disabled={busy} onClick={() => void confirm(false)}>
            Delete group
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
