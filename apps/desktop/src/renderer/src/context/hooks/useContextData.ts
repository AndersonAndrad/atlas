import type { ContextTarget, IpcResult } from '@atlas/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import type { ProjectDetails } from '@/types';

/**
 * Loads data for a key and reloads on demand. The result is keyed, so data of a
 * previous key (e.g. another project) is never shown.
 */
export function useKeyedLoad<T>(key: string | null, load: () => Promise<IpcResult<T>>) {
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const [state, setState] = useState<{ key: string; value: T | null; error: string | null } | null>(
    null,
  );

  const reload = useCallback(async () => {
    if (key === null) return;
    try {
      const value = await unwrap(loader.current());
      setState({ key, value, error: null });
    } catch (caught) {
      setState({ key, value: null, error: errorMessage(caught) });
    }
  }, [key]);

  useEffect(() => {
    void (async () => {
      await reload();
    })();
  }, [reload]);

  const current = state?.key === key ? state : null;
  return { value: current?.value ?? null, error: current?.error ?? null, reload };
}

export interface ContextTargetOption {
  key: string;
  label: string;
  /** "Project" or "Repository". */
  kind: string;
  target: ContextTarget;
}

/**
 * Projects and the Git repositories of open terminals that are not registered
 * projects. The Engine authorizes every target again on each request.
 */
export function useContextTargets(projects: ProjectDetails[]): ContextTargetOption[] {
  const { value: repositories } = useKeyedLoad('repositories', () => api().git.repositories());
  const options: ContextTargetOption[] = projects.map((item) => ({
    key: `project:${item.project.id}`,
    label: item.project.name,
    kind: 'Project',
    target: { projectId: item.project.id },
  }));
  for (const repository of repositories ?? []) {
    if (repository.projectIds.length > 0) continue;
    options.push({
      key: `workspace:${repository.repositoryRoot}`,
      label: repository.name,
      kind: 'Repository',
      target: { workspacePath: repository.repositoryRoot },
    });
  }
  return options;
}
