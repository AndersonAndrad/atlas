import { isFinalTerminalStatus, type TerminalSession } from '@atlas/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { onTerminalLifecycle } from '../state/terminal-events';

export interface TerminalSessionsState {
  /** Every session known to the Engine, ordered by creation; null while loading. */
  sessions: TerminalSession[] | null;
  error: string | null;
  /** Incremented when the Engine restarted and views must be rebuilt. */
  epoch: number;
  reload: () => Promise<void>;
  upsert: (session: TerminalSession) => void;
}

/** Engine-owned terminal sessions, kept in sync through lifecycle events. */
export function useTerminalSessions(): TerminalSessionsState {
  const [sessions, setSessions] = useState<TerminalSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  const reload = useCallback(async () => {
    try {
      setSessions(await unwrap(api().terminals.list()));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  const upsert = useCallback((session: TerminalSession) => {
    setSessions((current) => {
      if (current === null) return current;
      const index = current.findIndex((item) => item.id === session.id);
      if (index === -1) return [...current, session];
      const next = [...current];
      next[index] = session;
      return next;
    });
  }, []);

  useEffect(() => {
    unwrap(api().terminals.list()).then(setSessions, (caught: unknown) =>
      setError(errorMessage(caught)),
    );
    const stopLifecycle = onTerminalLifecycle((event) => {
      if (event.type === 'session') upsert(event.session);
      else setSessions((current) => current?.filter((item) => item.id !== event.sessionId) ?? null);
    });
    const stopRestart = api().app.onEngineRestarted(() => {
      setEpoch((value) => value + 1);
      void reload();
    });
    return () => {
      stopLifecycle();
      stopRestart();
    };
  }, [reload, upsert]);

  return { sessions, error, epoch, reload, upsert };
}

export function runningSessionCount(sessions: TerminalSession[] | null, projectId: string): number {
  return (sessions ?? []).filter(
    (session) => session.projectId === projectId && !isFinalTerminalStatus(session.status),
  ).length;
}
