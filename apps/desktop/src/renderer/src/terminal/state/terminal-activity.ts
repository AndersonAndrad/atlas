import type { TerminalActivitySummary } from '@atlas/contracts';
import { useSyncExternalStore } from 'react';
import { api, unwrap } from '@/api';
import { onTerminalLifecycle } from './terminal-events';

/**
 * Tracked activity of terminals (SDD-023 Task A02), shared by tabs, panes and the sidebar:
 * one request when first needed, then kept current by `terminal-activity` events. One
 * subscription for the whole renderer; reading it never polls.
 */
let summaries = new Map<string, TerminalActivitySummary>();
let subscribed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function putTerminalActivity(summary: TerminalActivitySummary): void {
  const next = new Map(summaries);
  next.set(summary.terminalId, summary);
  summaries = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!subscribed) {
    subscribed = true;
    onTerminalLifecycle((event) => {
      if (event.type === 'terminal-activity') putTerminalActivity(event.summary);
      if (event.type === 'removed' && summaries.has(event.sessionId)) {
        const next = new Map(summaries);
        next.delete(event.sessionId);
        summaries = next;
        emit();
      }
    });
    unwrap(api().terminals.activities()).then(
      (list) => {
        // Events that arrived meanwhile are newer than the list.
        const next = new Map(list.map((summary) => [summary.terminalId, summary]));
        for (const [id, summary] of summaries) next.set(id, summary);
        summaries = next;
        emit();
      },
      () => undefined,
    );
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Selects one terminal's summary, so other terminals' changes do not re-render it. */
export function useTerminalActivity(terminalId: string): TerminalActivitySummary | undefined {
  return useSyncExternalStore(subscribe, () => summaries.get(terminalId));
}

/** Explicit "Mark as reviewed" (never automatic). */
export async function markTerminalReviewed(terminalId: string): Promise<void> {
  putTerminalActivity(await unwrap(api().terminals.markReviewed(terminalId)));
}
