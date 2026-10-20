import type {
  GitDiffArea,
  GitFileDiff,
  GitOperation,
  GitPreferences,
  GitRepositoryEntry,
  GitWorkingTree,
} from '@atlas/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { onTerminalLifecycle } from '@/terminal/state/terminal-events';

/** Calls `run` at most once per `delayMs`, coalescing bursts of events. */
function useCoalesced(run: () => void, delayMs: number): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  }, [run]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current();
    }, delayMs);
  }, [delayMs]);
}

/** Repositories of registered projects and open terminals, kept current as terminals change. */
export function useGitRepositories() {
  const [repositories, setRepositories] = useState<GitRepositoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRepositories(await unwrap(api().git.repositories()));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);
  const scheduleReload = useCoalesced(() => void reload(), 1000);

  useEffect(() => {
    void (async () => {
      await reload();
    })();
  }, [reload]);
  useEffect(
    () =>
      onTerminalLifecycle((event) => {
        if (event.type === 'session' || event.type === 'removed') scheduleReload();
      }),
    [scheduleReload],
  );

  return { repositories, error, reload };
}

/** Detailed working tree, refreshed when the Engine reports changes in the repository. */
export function useGitWorkingTree(repositoryRoot: string | null) {
  // Keyed by repository so a previous repository's state is never shown.
  const [loaded, setLoaded] = useState<{
    root: string;
    tree: GitWorkingTree | null;
    error: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    if (repositoryRoot === null) return;
    const id = (request.current += 1);
    setLoading(true);
    try {
      const value = await unwrap(api().git.workingTree(repositoryRoot));
      if (id === request.current) setLoaded({ root: repositoryRoot, tree: value, error: null });
    } catch (caught) {
      if (id !== request.current) return;
      setLoaded((current) => ({
        root: repositoryRoot,
        tree: current?.root === repositoryRoot ? current.tree : null,
        error: errorMessage(caught),
      }));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [repositoryRoot]);
  const scheduleRefresh = useCoalesced(() => void refresh(), 300);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);
  useEffect(() => {
    if (repositoryRoot === null) return;
    return onTerminalLifecycle((event) => {
      if (event.type === 'git' && event.repositoryRoot === repositoryRoot) scheduleRefresh();
    });
  }, [repositoryRoot, scheduleRefresh]);

  const current = loaded?.root === repositoryRoot ? loaded : null;
  return { tree: current?.tree ?? null, error: current?.error ?? null, loading, refresh };
}

const OPERATION_HISTORY = 30;

/** Git operations of a repository, newest first, updated live from Engine events. */
export function useGitOperations(repositoryRoot: string | null) {
  const [operations, setOperations] = useState<GitOperation[]>([]);

  useEffect(() => {
    let cancelled = false;
    const upsert = (operation: GitOperation) =>
      setOperations((current) => {
        const next = current.filter((item) => item.id !== operation.id);
        next.push(operation);
        return next.slice(-OPERATION_HISTORY);
      });
    const unsubscribe = onTerminalLifecycle((event) => {
      if (event.type === 'git-operation') upsert(event.operation);
    });
    unwrap(api().git.operations()).then(
      (list) => {
        if (!cancelled) setOperations((current) => [...list, ...current].slice(-OPERATION_HISTORY));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const unique = new Map(operations.map((operation) => [operation.id, operation]));
  return [...unique.values()]
    .filter((operation) => operation.repositoryRoot === repositoryRoot)
    .reverse();
}

export interface DiffSelection {
  path: string;
  area: GitDiffArea;
}

export function useGitDiff(
  repositoryRoot: string | null,
  selection: DiffSelection | null,
  version: unknown,
) {
  // Keyed by what was requested, so a stale diff is never shown for another file.
  const [loaded, setLoaded] = useState<{
    key: string;
    diff: GitFileDiff | null;
    error: string | null;
  } | null>(null);
  const path = selection?.path ?? null;
  const area = selection?.area ?? null;
  const key =
    repositoryRoot === null || path === null || area === null
      ? null
      : `${repositoryRoot}\0${area}\0${path}`;

  useEffect(() => {
    if (repositoryRoot === null || path === null || area === null || key === null) return;
    let cancelled = false;
    unwrap(api().git.diff({ repositoryRoot, path, area })).then(
      (value) => !cancelled && setLoaded({ key, diff: value, error: null }),
      (caught: unknown) =>
        !cancelled && setLoaded({ key, diff: null, error: errorMessage(caught) }),
    );
    return () => {
      cancelled = true;
    };
  }, [repositoryRoot, path, area, key, version]);

  const current = key !== null && loaded?.key === key ? loaded : null;
  return { diff: current?.diff ?? null, error: current?.error ?? null };
}

export function useGitPreferences() {
  const [preferences, setPreferences] = useState<GitPreferences | null>(null);
  useEffect(() => {
    let cancelled = false;
    unwrap(api().git.getPreferences()).then(
      (value) => !cancelled && setPreferences(value),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const update = useCallback(async (changes: Partial<GitPreferences>) => {
    const next = await unwrap(api().git.setPreferences(changes));
    setPreferences(next);
    return next;
  }, []);
  return { preferences, update };
}
