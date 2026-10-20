import type { GitStatus, TerminalGitContext } from '@atlas/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api, unwrap } from '@/api';
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

/** Git state of a registered project's directory. */
export function useProjectGit(projectId: string) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    unwrap(api().git.project(projectId))
      .then(setStatus, () => setStatus(null))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    unwrap(api().git.project(projectId))
      .then(
        (value) => !cancelled && setStatus(value),
        () => !cancelled && setStatus(null),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const root = rootOf(status ?? undefined);
  useEffect(() => {
    if (root === null) return;
    return onTerminalLifecycle((event) => {
      if (event.type === 'git' && event.repositoryRoot === root) refresh();
    });
  }, [root, refresh]);

  return { status, loading, refresh };
}
