import type { BackgroundJob, JobSummary } from '@atlas/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, unwrap } from '@/api';
import { onTerminalLifecycle } from '@/terminal/state/terminal-events';

const EMPTY: JobSummary = { running: 0, queued: 0, waitingApproval: 0 };

/**
 * Counts of unfinished background jobs for the header indicator (FR-1213). Read from
 * the Engine, then refreshed on every `jobs` event and after an Engine restart.
 */
export function useJobSummary() {
  const [summary, setSummary] = useState<JobSummary>(EMPTY);
  const reload = useCallback(() => {
    unwrap(api().jobs.summary()).then(setSummary, () => setSummary(EMPTY));
  }, []);
  useEffect(() => {
    reload();
    const stop = onTerminalLifecycle((event) => {
      if (event.type === 'jobs') reload();
    });
    const stopRestart = api().app.onEngineRestarted(reload);
    return () => {
      stop();
      stopRestart();
    };
  }, [reload]);
  return summary;
}

/** Calls `listener` with every job change; the latest listener is always used. */
export function useJobEvents(listener: (job: BackgroundJob) => void) {
  const current = useRef(listener);
  useEffect(() => {
    current.current = listener;
  }, [listener]);
  useEffect(
    () =>
      onTerminalLifecycle((event) => {
        if (event.type === 'jobs') current.current(event.job);
      }),
    [],
  );
}
