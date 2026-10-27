import {
  EditorPreferencesSchema,
  type EditorPreferences,
  type UpdateEditorPreferencesInput,
} from '@atlas/contracts';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';

const DEFAULTS: EditorPreferences = EditorPreferencesSchema.parse({});

// Shared by the editor and Settings, so a change in one shows in the other at once.
let current: EditorPreferences | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<(preferences: EditorPreferences) => void>();

function publish(next: EditorPreferences) {
  current = next;
  for (const listener of listeners) listener(next);
}

/** Follows preference changes outside React (the extension runtime, SDD-015). */
export function subscribeEditorPreferences(
  listener: (preferences: EditorPreferences) => void,
): () => void {
  listeners.add(listener);
  if (current !== null) listener(current);
  return () => {
    listeners.delete(listener);
  };
}

/** Editor preferences (FR-1108), stored by the Engine with the other application settings. */
export function useEditorPreferences() {
  const [preferences, setPreferences] = useState<EditorPreferences>(current ?? DEFAULTS);
  const [loaded, setLoaded] = useState(current !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const listener = (next: EditorPreferences) => {
      setPreferences(next);
      setLoaded(true);
    };
    listeners.add(listener);
    loading ??= unwrap(api().editor.getPreferences()).then(publish, (caught: unknown) => {
      loading = null;
      setError(errorMessage(caught));
      setLoaded(true);
    });
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const update = useCallback(async (changes: UpdateEditorPreferencesInput) => {
    setError(null);
    try {
      publish(await unwrap(api().editor.setPreferences(changes)));
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues[0]
          ? caught.issues[0].message
          : errorMessage(caught),
      );
    }
  }, []);

  return { preferences, loaded, error, update };
}
