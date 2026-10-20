import type { TerminalGroup } from '@atlas/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { onTerminalLifecycle } from '../state/terminal-events';

/** Terminal groups ordered for display, kept in sync with Engine events. */
export function useTerminalGroups() {
  const [groups, setGroups] = useState<TerminalGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setGroups(await unwrap(api().groups.list()));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    unwrap(api().groups.list()).then(setGroups, (caught: unknown) =>
      setError(errorMessage(caught)),
    );
    const stop = onTerminalLifecycle((event) => {
      if (event.type === 'groups') setGroups(event.groups);
    });
    const stopRestart = api().app.onEngineRestarted(() => void reload());
    return () => {
      stop();
      stopRestart();
    };
  }, [reload]);

  return { groups, error, reload };
}
