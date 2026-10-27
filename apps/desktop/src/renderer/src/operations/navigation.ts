/**
 * Lets any view open a background job in the Operations view (SDD-025 Task 01) without
 * passing callbacks through every component in between. The App listens once.
 */
type Listener = (jobId: string) => void;

const listeners = new Set<Listener>();

export function openOperationsJob(jobId: string): void {
  for (const listener of listeners) listener(jobId);
}

export function onOpenOperationsJob(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
