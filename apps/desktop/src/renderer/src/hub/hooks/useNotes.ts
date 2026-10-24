import type { NoteListQuery, NoteScope } from '@atlas/contracts';
import { useCallback, useEffect } from 'react';
import { api } from '@/api';
import { useKeyedLoad } from '@/context/hooks/useContextData';
import { onTerminalLifecycle } from '@/terminal/state/terminal-events';

/** Hub scope as a stable string, e.g. for keys and the scope selector. */
export function scopeKey(scope: NoteScope): string {
  return scope.kind === 'project' ? `project:${scope.projectId}` : scope.kind;
}

export function scopeFromKey(key: string): NoteScope {
  if (key.startsWith('project:')) return { kind: 'project', projectId: key.slice(8) };
  return key === 'all' ? { kind: 'all' } : { kind: 'global' };
}

/** Calls `listener` whenever notes change in any client or the Engine restarts. */
export function useNotesChanged(listener: (noteId: string | null) => void) {
  useEffect(() => {
    const stop = onTerminalLifecycle((event) => {
      if (event.type === 'notes') listener(event.noteId);
    });
    const stopRestart = api().app.onEngineRestarted(() => listener(null));
    return () => {
      stop();
      stopRestart();
    };
  }, [listener]);
}

/** A list of notes that reloads when notes change; data of another query is never shown. */
export function useNoteList(query: NoteListQuery) {
  const list = useKeyedLoad(JSON.stringify(query), () => api().notes.list(query));
  const { reload } = list;
  // Reloading on every change keeps counts, categories and order right.
  useNotesChanged(useCallback(() => void reload(), [reload]));
  return list;
}
