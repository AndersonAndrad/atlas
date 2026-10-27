import type { ProjectGitState } from '@atlas/contracts';
import { useEffect, useSyncExternalStore } from 'react';
import { api, unwrap } from '@/api';
import { onTerminalLifecycle } from '@/terminal/state/terminal-events';

/**
 * Stored Git state of every project (SDD-024), shared by all views: one request when the
 * first view needs it, then kept current by `project-git` Engine events. Reading it never
 * runs Git; only the Engine's monitoring or an explicit refresh does.
 */
let states = new Map<string, ProjectGitState>();
let loading: Promise<void> | null = null;
let unsubscribeEvents: (() => void) | null = null;
const listeners = new Set<() => void>();
/** Projects already reloaded for once because their state was missing (new projects). */
const reloadedFor = new Set<string>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Replaces one project's state (from an event or an action's response). */
export function putProjectGitState(state: ProjectGitState): void {
  const next = new Map(states);
  next.set(state.projectId, state);
  states = next;
  emit();
}

export function reloadProjectGitStates(): Promise<void> {
  loading ??= unwrap(api().git.projectStates())
    .then(
      (list) => {
        states = new Map(list.map((state) => [state.projectId, state]));
        emit();
      },
      // Badges then show the unknown state; the next event or reload fills them in.
      () => undefined,
    )
    .finally(() => {
      loading = null;
    });
  return loading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (unsubscribeEvents === null) {
    unsubscribeEvents = onTerminalLifecycle((event) => {
      if (event.type === 'project-git') putProjectGitState(event.state);
    });
    void reloadProjectGitStates();
  }
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => states;

/** The stored Git state of a project; undefined until loaded or for an unknown project. */
export function useProjectGitState(projectId: string): ProjectGitState | undefined {
  const state = useSyncExternalStore(subscribe, snapshot).get(projectId);
  const missing = state === undefined;
  useEffect(() => {
    // A project registered after the last load has no state yet: read them once more.
    if (!missing || reloadedFor.has(projectId)) return;
    const timer = setTimeout(() => {
      reloadedFor.add(projectId);
      void reloadProjectGitStates();
    }, 0);
    return () => clearTimeout(timer);
  }, [missing, projectId]);
  return state;
}
