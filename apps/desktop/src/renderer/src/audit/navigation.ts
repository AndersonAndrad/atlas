/**
 * Asks the App to show a project's audits in the Project Hub and open the Analyze
 * Project dialog (SDD-026 FR-001), from the Projects drawer or the project palette.
 */
type Listener = (projectId: string) => void;

const listeners = new Set<Listener>();

export function requestProjectAudit(projectId: string): void {
  for (const listener of listeners) listener(projectId);
}

export function onProjectAuditRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
