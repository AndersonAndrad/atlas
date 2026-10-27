import type {
  ExtensionCategory,
  ExtensionContributions,
  ExtensionSearchResult,
  InstalledExtension,
} from '@atlas/contracts';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { extensionRuntime } from './runtime/runtime';

export interface SearchState {
  result: ExtensionSearchResult | null;
  loading: boolean;
  error: string | null;
  /** The registry could not be reached; installed extensions still work. */
  registryDown: boolean;
}

const SEARCH_DELAY_MS = 350;

/** Open VSX search, debounced while typing (FR-1501). */
export function useExtensionSearch(
  query: string,
  category: ExtensionCategory | null,
  publisher: string,
): SearchState {
  const [state, setState] = useState<SearchState>({
    result: null,
    loading: false,
    error: null,
    registryDown: false,
  });
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setState((current) => ({ ...current, loading: true }));
        try {
          const result = await unwrap(
            api().extensions.search({
              query,
              category,
              publisher: publisher.trim() === '' ? null : publisher.trim(),
              size: 30,
            }),
          );
          if (!cancelled) setState({ result, loading: false, error: null, registryDown: false });
        } catch (caught) {
          if (cancelled) return;
          setState({
            result: null,
            loading: false,
            error: errorMessage(caught),
            registryDown:
              caught instanceof ApiError && caught.code === 'EXTENSION_REGISTRY_UNAVAILABLE',
          });
        }
      })();
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, category, publisher]);
  return state;
}

/** Installed extensions and the contributions active in a project. */
export function useInstalledExtensions(projectId: string | null) {
  const [installed, setInstalled] = useState<InstalledExtension[] | null>(null);
  const [contributions, setContributions] = useState<ExtensionContributions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, active] = await Promise.all([
          unwrap(api().extensions.list({ projectId })),
          unwrap(api().extensions.contributions({ projectId })),
        ]);
        if (cancelled) return;
        setInstalled(list);
        setContributions(active);
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  /** Reloads the lists and re-applies contributions to open editors. */
  const reload = useCallback(() => {
    setVersion((current) => current + 1);
    void extensionRuntime.refresh();
  }, []);

  return { installed, contributions, error, reload };
}
