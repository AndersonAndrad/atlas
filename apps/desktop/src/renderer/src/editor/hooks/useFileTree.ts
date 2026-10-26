import type { DirectoryListing, FileEntry } from '@atlas/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { isWithin, parentPath } from '../state/tabs';

type Listing = { state: 'ready'; listing: DirectoryListing } | { state: 'error'; error: string };

export interface TreeRow {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  /** The folder's listing failed or is loading. */
  status: 'ready' | 'loading' | 'error';
}

export interface TreeOptions {
  showHidden: boolean;
  showIgnored: boolean;
}

interface TreeState {
  /** Project and visibility options the listings belong to. */
  key: string | null;
  listings: ReadonlyMap<string, Listing>;
  expanded: ReadonlySet<string>;
}

const NO_LISTINGS: ReadonlyMap<string, Listing> = new Map();

/**
 * The explorer tree of a project (FR-1101): folders are listed when expanded, never
 * eagerly, and listed again when the Engine reports a change in them.
 */
export function useFileTree(
  projectId: string | null,
  options: TreeOptions,
  initialExpanded: readonly string[],
) {
  const { showHidden, showIgnored } = options;
  const key = projectId === null ? null : `${projectId}\0${showHidden}\0${showIgnored}`;
  const [stored, setStored] = useState<TreeState>({
    key: null,
    listings: NO_LISTINGS,
    expanded: new Set(),
  });
  // A new project (or new visibility options) starts from its saved expanded folders.
  const fresh = useMemo<TreeState>(
    () => ({ key, listings: NO_LISTINGS, expanded: new Set(initialExpanded) }),
    [key, initialExpanded],
  );
  const tree = stored.key === key ? stored : fresh;
  const treeRef = useRef(tree);
  useEffect(() => {
    treeRef.current = tree;
  });

  const update = useCallback(
    (change: (current: TreeState) => TreeState) =>
      setStored((current) => change(current.key === fresh.key ? current : fresh)),
    [fresh],
  );

  const load = useCallback(
    async (directory: string) => {
      if (projectId === null) return;
      let next: Listing;
      try {
        const listing = await unwrap(
          api().projectFiles.list({ projectId, path: directory, showHidden, showIgnored }),
        );
        next = { state: 'ready', listing };
      } catch (caught) {
        next = { state: 'error', error: errorMessage(caught) };
      }
      // A listing for a previous project (or previous options) is dropped.
      if (treeRef.current.key !== fresh.key) return;
      update((current) => ({
        ...current,
        listings: new Map(current.listings).set(directory, next),
      }));
    },
    [projectId, showHidden, showIgnored, fresh.key, update],
  );

  useEffect(() => {
    if (fresh.key === null) return;
    void load('');
    for (const folder of fresh.expanded) void load(folder);
  }, [fresh, load]);

  const toggle = useCallback(
    (folder: string) => {
      const opening = !treeRef.current.expanded.has(folder);
      update((current) => {
        const expanded = new Set(current.expanded);
        if (opening) expanded.add(folder);
        else for (const path of current.expanded) if (isWithin(path, folder)) expanded.delete(path);
        return { ...current, expanded };
      });
      if (opening && treeRef.current.listings.get(folder)?.state !== 'ready') void load(folder);
    },
    [load, update],
  );

  /** Expands every folder above `path`, e.g. to reveal the active file. */
  const reveal = useCallback(
    (path: string) => {
      const folders: string[] = [];
      for (let folder = parentPath(path); folder !== ''; folder = parentPath(folder)) {
        folders.unshift(folder);
      }
      update((current) => ({ ...current, expanded: new Set([...current.expanded, ...folders]) }));
      for (const folder of folders) {
        if (treeRef.current.listings.get(folder)?.state !== 'ready') void load(folder);
      }
    },
    [load, update],
  );

  /** Lists again the loaded folders that contain (or are) the changed paths. */
  const refresh = useCallback(
    (paths: readonly string[] | null) => {
      const loaded = treeRef.current.listings;
      const folders =
        paths === null
          ? [...loaded.keys()]
          : [...new Set(paths.flatMap((path) => [parentPath(path), path]))].filter((folder) =>
              loaded.has(folder),
            );
      for (const folder of folders) void load(folder);
    },
    [load],
  );

  const { listings, expanded } = tree;
  const rows = useMemo(() => {
    const result: TreeRow[] = [];
    const walk = (folder: string, depth: number) => {
      const listing = listings.get(folder);
      if (listing?.state !== 'ready') return;
      for (const entry of listing.listing.entries) {
        const isFolder = entry.kind === 'directory' && !entry.outside;
        const open = isFolder && expanded.has(entry.path);
        const child = listings.get(entry.path);
        result.push({
          entry,
          depth,
          expanded: open,
          status: !open ? 'ready' : (child?.state ?? 'loading'),
        });
        if (open) walk(entry.path, depth + 1);
      }
    };
    walk('', 0);
    return result;
  }, [listings, expanded]);

  const root = listings.get('');
  return {
    rows,
    expanded,
    rootError: root?.state === 'error' ? root.error : null,
    rootLoading: root === undefined,
    hiddenIgnored: root?.state === 'ready' ? root.listing.hiddenIgnored : 0,
    toggle,
    reveal,
    refresh,
  };
}
