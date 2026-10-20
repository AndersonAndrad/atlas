import type { AtlasSessionDetails, AtlasSessionListItem, SessionEvent } from '@atlas/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';

/** Runs `reload` when a session changes in any client or the Engine restarts. */
function useSessionChanges(reload: () => void, sessionId?: string | null) {
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });
  useEffect(() => {
    const offChanged = api().sessions.onChanged((event) => {
      if (sessionId === undefined || event.sessionId === sessionId) reloadRef.current();
    });
    const offRestarted = api().app.onEngineRestarted(() => reloadRef.current());
    // Changes written by a CLI without a running Engine have no event; refresh on focus.
    const onFocus = () => reloadRef.current();
    window.addEventListener('focus', onFocus);
    return () => {
      offChanged();
      offRestarted();
      window.removeEventListener('focus', onFocus);
    };
  }, [sessionId]);
}

/** Session list, refreshed whenever any session changes. */
export function useSessions(includeArchived: boolean) {
  const [items, setItems] = useState<AtlasSessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await unwrap(api().sessions.list({ includeArchived }));
      setItems(list);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [includeArchived]);

  useEffect(() => {
    void (async () => {
      await reload();
    })();
  }, [reload]);
  useSessionChanges(() => void reload());

  return { items, error, reload };
}

interface LoadedSession {
  sessionId: string;
  details: AtlasSessionDetails | null;
  events: SessionEvent[];
  error: string | null;
}

/** Details and event history of one session, refreshed when it changes. */
export function useSessionDetails(sessionId: string | null) {
  const [loaded, setLoaded] = useState<LoadedSession | null>(null);
  const requested = useRef<string | null>(null);
  useEffect(() => {
    requested.current = sessionId;
  }, [sessionId]);

  const reload = useCallback(async () => {
    if (sessionId === null) return;
    try {
      const [details, events] = await Promise.all([
        unwrap(api().sessions.get(sessionId)),
        unwrap(api().sessions.events(sessionId)),
      ]);
      // Ignore answers for a session that is no longer shown.
      if (requested.current === sessionId) setLoaded({ sessionId, details, events, error: null });
    } catch (caught) {
      if (requested.current !== sessionId) return;
      setLoaded((current) => ({
        sessionId,
        details: current?.sessionId === sessionId ? current.details : null,
        events: current?.sessionId === sessionId ? current.events : [],
        error: errorMessage(caught),
      }));
    }
  }, [sessionId]);

  useEffect(() => {
    void (async () => {
      await reload();
    })();
  }, [reload]);
  useSessionChanges(() => void reload(), sessionId);

  // State loaded for another session is never shown.
  const current = loaded !== null && loaded.sessionId === sessionId ? loaded : null;
  return {
    details: current?.details ?? null,
    events: current?.events ?? [],
    error: current?.error ?? null,
    reload,
  };
}
