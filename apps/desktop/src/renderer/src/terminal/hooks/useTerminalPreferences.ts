import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type TerminalPreferences,
  type UpdateTerminalPreferencesInput,
} from '@atlas/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';

export const DEFAULT_FONT_SIZE = 13;

const FALLBACK: TerminalPreferences = {
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: 'system',
  scrollback: 5000,
  defaultShellId: null,
  defaultWorkingDirectory: null,
};

/** Terminal preferences persisted by the Engine. */
export function useTerminalPreferences() {
  const [preferences, setPreferences] = useState<TerminalPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    unwrap(api().terminals.getPreferences()).then(setPreferences, (caught: unknown) => {
      setError(errorMessage(caught));
      setPreferences(FALLBACK);
    });
  }, []);

  const update = useCallback(async (changes: UpdateTerminalPreferencesInput) => {
    try {
      setPreferences(await unwrap(api().terminals.setPreferences(changes)));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  // Tracks the latest requested size so repeated shortcuts accumulate correctly
  // before the Engine has answered.
  const requestedFontSize = useRef<number | null>(null);
  const changeFontSize = useCallback(
    (delta: number | 'reset') => {
      if (preferences === null) return;
      const base = requestedFontSize.current ?? preferences.fontSize;
      const next =
        delta === 'reset'
          ? DEFAULT_FONT_SIZE
          : Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, base + delta));
      if (next === base) return;
      requestedFontSize.current = next;
      void update({ fontSize: next }).finally(() => {
        if (requestedFontSize.current === next) requestedFontSize.current = null;
      });
    },
    [preferences, update],
  );

  return { preferences, error, update, changeFontSize };
}
