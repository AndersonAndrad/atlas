import type { TerminalLlmUsage } from '@atlas/contracts';
import { useEffect, useRef, useState } from 'react';
import { api, unwrap } from '@/api';
import { onTerminalLifecycle } from '../state/terminal-events';

/**
 * The LLM open in a terminal and its session window (PLAN-031). Re-requested when the
 * Engine reports that an LLM opened or closed, or that a provider reported new usage.
 */
export function useTerminalLlmUsage(sessionId: string, enabled: boolean): TerminalLlmUsage | null {
  const [usage, setUsage] = useState<TerminalLlmUsage | null>(null);
  // Answers may arrive out of order; only the latest request is applied.
  const latest = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const load = () => {
      const request = ++latest.current;
      unwrap(api().terminals.llmUsage(sessionId)).then(
        (value) => request === latest.current && setUsage(value),
        () => request === latest.current && setUsage(null),
      );
    };
    load();
    const unsubscribe = onTerminalLifecycle((event) => {
      if (event.type === 'llm-usage') load();
    });
    return () => {
      latest.current += 1;
      unsubscribe();
    };
  }, [sessionId, enabled]);

  return enabled ? usage : null;
}
