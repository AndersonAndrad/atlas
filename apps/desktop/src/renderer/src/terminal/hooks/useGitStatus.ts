import type { GitStatus, TerminalGitContext } from '@atlas/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api, unwrap } from '@/api';
import { putProjectGitState } from '@/git/state/project-git-states';
import { onTerminalLifecycle } from '../state/terminal-events';

function rootOf(status: GitStatus | undefined): string | null {
  return status?.state === 'repository' ? status.snapshot.repositoryRoot : null;
}

/**
 * Git state that follows a terminal's current directory. Re-requested when the
 * directory changes and when the Engine reports changes in the repository.
 */
export function useTerminalGit(sessionId: string, currentCwd: string, enabled: boolean) {
  const [context, setContext] = useState<TerminalGitContext | null>(null);

  const refresh = useCallback(() => {
    unwrap(api().terminals.git(sessionId)).then(setContext, () => setContext(null));
  }, [sessionId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    unwrap(api().terminals.git(sessionId)).then(
      (value) => !cancelled && setContext(value),
      () => !cancelled && setContext(null),
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, currentCwd, enabled]);

  const root = rootOf(context?.git);
  useEffect(() => {
    if (!enabled || root === null) return;
    return onTerminalLifecycle((event) => {
      if (event.type === 'git' && event.repositoryRoot === root) refresh();
    });
  }, [enabled, root, refresh]);

  return { context, refresh };
}

/**
 * Full Git status of a registered project's directory. With `live` (monitoring on) it is
 * read when shown and after repository changes; otherwise only `refresh` reads it, which
 * also updates the stored state shown by badges (SDD-024).
 */
export function useProjectGit(projectId: string, live = true) {
  // Keyed by project so another project's status is never shown.
  const [result, setResult] = useState<{ projectId: string; status: GitStatus | null } | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const show = useCallback(
    (status: GitStatus | null) => setResult({ projectId, status }),
    [projectId],
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    unwrap(api().git.refreshProject(projectId))
      .then(
        (refreshed) => {
          putProjectGitState(refreshed.state);
          show(refreshed.status);
        },
        () => show(null),
      )
      .finally(() => setRefreshing(false));
  }, [projectId, show]);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    unwrap(api().git.project(projectId)).then(
      (value) => !cancelled && show(value),
      () => !cancelled && show(null),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, live, show]);

  const current = result?.projectId === projectId ? result : null;
  const status = current?.status ?? null;
  const root = rootOf(status ?? undefined);
  useEffect(() => {
    if (!live || root === null) return;
    return onTerminalLifecycle((event) => {
      if (event.type !== 'git' || event.repositoryRoot !== root) return;
      unwrap(api().git.project(projectId)).then(show, () => show(null));
    });
  }, [live, root, projectId, show]);

  return { status, loading: refreshing || (live && current === null), refresh };
}
