import { useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import type { Project } from '@/types';

interface RemoveProjectDialogProps {
  project: Project;
  /** Terminals of this project with a live process; they keep running, unassociated. */
  runningTerminals: number;
  onClose: () => void;
  onRemoved: (id: string) => void;
}

export function RemoveProjectDialog({
  project,
  runningTerminals,
  onClose,
  onRemoved,
}: RemoveProjectDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api().projects.remove(project.id));
      onRemoved(project.id);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogContent data-testid="remove-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove project</AlertDialogTitle>
          <AlertDialogDescription>
            Remove <strong className="text-foreground">{project.name}</strong> from the ATLAS
            registry? Only the registry entry is removed. The directory, its files and any Git
            repository are not modified or deleted. Its sessions keep the directory as a standalone
            workspace.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {runningTerminals > 0 && (
          <Alert className="border-warning/40" data-testid="remove-terminals-warning">
            <AlertDescription>
              {runningTerminals === 1
                ? '1 running terminal of this project keeps running as a standalone terminal.'
                : `${runningTerminals} running terminals of this project keep running as standalone terminals.`}
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} autoFocus>
            Cancel
          </AlertDialogCancel>
          {/* A plain button keeps the dialog open while the removal runs. */}
          <Button variant="destructive" onClick={confirm} disabled={busy}>
            {busy ? 'Removing…' : 'Remove from registry'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
