import type { TerminalSession, TerminalWorkspaceLayout } from '@atlas/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, unwrap } from '@/api';
import {
  findPaneBySession,
  listPanes,
  reconcileLayout,
  removeSession,
  showSession,
} from '../state/layout';

const SAVE_DEBOUNCE_MS = 300;

let paneCounter = 0;
export const newLayoutId = () => `p${Date.now().toString(36)}${(paneCounter++).toString(36)}`;

/**
 * Pane layout of one project's terminal workspace. It is presentation state:
 * loaded from and saved to the Engine, and repaired whenever sessions change.
 */
export function useWorkspaceLayout(projectId: string, sessions: TerminalSession[]) {
  const [layout, setLayout] = useState<TerminalWorkspaceLayout | null>(null);
  const loadedRef = useRef(false);
  const sessionIds = sessions.map((session) => session.id).join(',');

  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    unwrap(api().terminals.getLayout(projectId))
      .catch(() => null)
      .then((saved) => {
        if (cancelled) return;
        const ids = sessionIds === '' ? [] : sessionIds.split(',');
        let initial = reconcileLayout(saved, ids);
        const last = ids.at(-1);
        if (initial.root === null && last !== undefined) {
          initial = showSession(initial, last, newLayoutId);
        }
        loadedRef.current = true;
        setLayout(initial);
      });
    return () => {
      cancelled = true;
    };
    // Load once per project; session changes are reconciled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Sessions closed elsewhere (another pane, the CLI) leave their pane.
  useEffect(() => {
    if (!loadedRef.current) return;
    const ids = sessionIds === '' ? [] : sessionIds.split(',');
    setLayout((current) => {
      if (current === null) return current;
      let next = current;
      for (const pane of listPanes(current.root)) {
        if (ids.includes(pane.sessionId)) continue;
        const replacement = [...ids]
          .reverse()
          .find((id) => findPaneBySession(next, id) === undefined);
        next = removeSession(next, pane.sessionId, replacement);
      }
      return next;
    });
  }, [sessionIds]);

  // Debounced save; a pending save is flushed when the workspace unmounts.
  const unsavedRef = useRef<TerminalWorkspaceLayout | null>(null);
  useEffect(() => {
    if (layout === null || !loadedRef.current) return;
    unsavedRef.current = layout;
    const timer = setTimeout(() => {
      unsavedRef.current = null;
      void api().terminals.setLayout(projectId, layout);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [layout, projectId]);
  useEffect(
    () => () => {
      if (unsavedRef.current !== null)
        void api().terminals.setLayout(projectId, unsavedRef.current);
    },
    [projectId],
  );

  const update = useCallback(
    (change: (layout: TerminalWorkspaceLayout) => TerminalWorkspaceLayout) =>
      setLayout((current) => (current === null ? current : change(current))),
    [],
  );

  return { layout, update };
}
