import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import type { ProjectDetails } from '@/types';

/** Registered projects and the selected one, shared by the Projects and Terminals views. */
export function useProjects() {
  const [items, setItems] = useState<ProjectDetails[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await unwrap(api().projects.list());
      setItems(list);
      setLoadError(null);
      return list;
    } catch (error) {
      setLoadError(errorMessage(error));
      return null;
    }
  }, []);

  // Initial load: restore the previously selected project (SDD-001 FR-008).
  useEffect(() => {
    void (async () => {
      const [list, selected] = await Promise.all([
        reload(),
        unwrap(api().projects.getSelected()).catch(() => null),
      ]);
      if (list && selected) setSelectedId(selected.project.id);
    })();
  }, [reload]);

  // Pick up changes made from the CLI while the window was in the background.
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  const select = useCallback(
    async (id: string) => {
      setSelectedId(id);
      try {
        await unwrap(api().projects.select(id));
        await reload();
      } catch (error) {
        setSelectError(errorMessage(error));
      }
    },
    [reload],
  );

  const selected = items?.find((item) => item.project.id === selectedId) ?? null;

  return {
    items,
    selected,
    selectedId,
    setSelectedId,
    loadError,
    selectError,
    clearSelectError: () => setSelectError(null),
    reload,
    select,
  };
}
