/**
 * Asks the App to show a project in the Project Hub (SDD-026, PLAN-056): its audits with
 * the Analyze Project dialog (Projects drawer, project palette), or its tasks (terminal
 * Actions menu, SDD-023 Task A04).
 */
export interface HubNavigation {
  projectId: string;
  tab: 'audits' | 'tasks';
  /** Opens the Analyze Project dialog. */
  analyze: boolean;
}

type Listener = (request: HubNavigation) => void;

const listeners = new Set<Listener>();

function navigate(request: HubNavigation): void {
  for (const listener of listeners) listener(request);
}

export function requestProjectAudit(projectId: string): void {
  navigate({ projectId, tab: 'audits', analyze: true });
}

export function requestProjectTasks(projectId: string): void {
  navigate({ projectId, tab: 'tasks', analyze: false });
}

export function onHubNavigation(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
