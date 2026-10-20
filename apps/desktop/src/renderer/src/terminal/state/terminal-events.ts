import type { TerminalEvent } from '@atlas/contracts';
import type { TerminalEventMessage } from '@atlas/contracts/ipc';

type OutputListener = (event: Extract<TerminalEvent, { type: 'output' }>) => void;
type LifecycleListener = (event: Exclude<TerminalEvent, { type: 'output' }>) => void;

const outputListeners = new Map<string, OutputListener>();
const lifecycleListeners = new Set<LifecycleListener>();
let unsubscribe: (() => void) | undefined;

/**
 * Single subscription to Engine terminal events. Output is routed directly to
 * the view it is addressed to (never through React state); lifecycle events go
 * to React listeners.
 */
function ensureSubscribed(): void {
  unsubscribe ??= window.atlas.terminals.onEvent((message: TerminalEventMessage) => {
    const { event, viewId } = message;
    if (event.type === 'output') {
      if (viewId !== undefined) outputListeners.get(viewId)?.(event);
      return;
    }
    for (const listener of lifecycleListeners) listener(event);
  });
}

export function onViewOutput(viewId: string, listener: OutputListener): () => void {
  ensureSubscribed();
  outputListeners.set(viewId, listener);
  return () => {
    if (outputListeners.get(viewId) === listener) outputListeners.delete(viewId);
  };
}

export function onTerminalLifecycle(listener: LifecycleListener): () => void {
  ensureSubscribed();
  lifecycleListeners.add(listener);
  return () => lifecycleListeners.delete(listener);
}
