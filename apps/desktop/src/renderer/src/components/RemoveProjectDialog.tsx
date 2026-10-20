import { useState } from 'react';
import { api, errorMessage, unwrap } from '../api';
import type { Project } from '../types';
import { Modal } from './Modal';

interface RemoveProjectDialogProps {
  project: Project;
  onClose: () => void;
  onRemoved: (id: string) => void;
}

export function RemoveProjectDialog({ project, onClose, onRemoved }: RemoveProjectDialogProps) {
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
    <Modal title="Remove project" onClose={onClose} busy={busy} testId="remove-dialog">
      <p>
        Remove <strong>{project.name}</strong> from the ATLAS registry?
      </p>
      <p className="muted">
        Only the registry entry is removed. The directory, its files and any Git repository are not
        modified or deleted.
      </p>
      {error && (
        <p className="callout callout--error" role="alert">
          {error}
        </p>
      )}
      <footer className="modal__footer">
        <button type="button" className="button" onClick={onClose} disabled={busy} autoFocus>
          Cancel
        </button>
        <button type="button" className="button button--danger" onClick={confirm} disabled={busy}>
          {busy ? 'Removing…' : 'Remove from registry'}
        </button>
      </footer>
    </Modal>
  );
}
