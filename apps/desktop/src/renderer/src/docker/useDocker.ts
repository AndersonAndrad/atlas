import type { DockerContainerSummary, DockerContextList, DockerStatus } from '@atlas/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { onTerminalLifecycle } from '@/terminal/state/terminal-events';

/** Missed events are corrected by reading the list again (FR-1312). */
const RECONCILE_MS = 15_000;
/** While Docker cannot be used, ATLAS checks again this often (FR-1303). */
const RECONNECT_MS = 10_000;
const EVENT_DELAY_MS = 250;

/**
 * Container Manager state: connection, contexts and containers of the context in use.
 * Watches Docker events only while mounted; Docker stays the source of truth.
 */
export function useDocker() {
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [contexts, setContexts] = useState<DockerContextList | null>(null);
  const [containers, setContainers] = useState<DockerContainerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState<{ id: string | null; nonce: number }>({
    id: null,
    nonce: 0,
  });
  const context = status?.state === 'CONNECTED' ? status.context : null;

  const check = useCallback(async () => {
    try {
      const [nextStatus, nextContexts] = await Promise.all([
        unwrap(api().docker.status()),
        unwrap(api().docker.contexts()).catch(() => null),
      ]);
      setStatus(nextStatus);
      setContexts(nextContexts);
      if (nextStatus.state !== 'CONNECTED') setContainers(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  const reload = useCallback(async () => {
    if (context === null) return;
    try {
      setContainers(await unwrap(api().docker.containers({ context })));
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'DOCKER_UNAVAILABLE') {
        await check();
        return;
      }
      setError(errorMessage(caught));
    }
  }, [context, check]);

  // Connection: checked when opened, and again while Docker cannot be used.
  useEffect(() => {
    void (async () => check())();
  }, [check]);
  const connected = status?.state === 'CONNECTED';
  useEffect(() => {
    if (status === null || connected) return;
    const timer = setInterval(() => void check(), RECONNECT_MS);
    return () => clearInterval(timer);
  }, [status, connected, check]);

  // Containers: read when the context is known, then on events and periodically.
  useEffect(() => {
    if (context === null) return;
    let cancelled = false;
    unwrap(api().docker.containers({ context })).then(
      (items) => !cancelled && setContainers(items),
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    );
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, RECONCILE_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [context, reload]);

  useEffect(() => {
    void api().docker.watch(true);
    return () => void api().docker.watch(false);
  }, []);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ reload, check });
  useEffect(() => {
    latest.current = { reload, check };
  }, [reload, check]);
  useEffect(() => {
    const stop = onTerminalLifecycle((event) => {
      if (event.type !== 'docker') return;
      if (event.containerId === null) {
        void latest.current.check();
        return;
      }
      setChanged((current) => ({ id: event.containerId, nonce: current.nonce + 1 }));
      pending.current ??= setTimeout(() => {
        pending.current = null;
        void latest.current.reload();
      }, EVENT_DELAY_MS);
    });
    const stopRestart = api().app.onEngineRestarted(() => void latest.current.check());
    return () => {
      stop();
      stopRestart();
      if (pending.current !== null) clearTimeout(pending.current);
    };
  }, []);

  const selectContext = useCallback(
    async (name: string | null) => {
      try {
        setContexts(await unwrap(api().docker.selectContext({ name })));
        setContainers(null);
        await check();
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [check],
  );

  return {
    status,
    contexts,
    containers,
    context,
    error,
    clearError: () => setError(null),
    /** The last container an event named, so an open panel can refresh. */
    changed,
    check,
    reload,
    selectContext,
  };
}

export type DockerState = ReturnType<typeof useDocker>;
