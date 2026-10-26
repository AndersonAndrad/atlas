import type { EditorLayout, FileEncoding, FileEol } from '@atlas/contracts';

/** Why the buffer and the file on disk disagree (FR-1107). */
export type TabConflict = 'changed' | 'deleted';

/** An open file. Its text lives in a Monaco model; this is what the UI shows about it. */
export interface EditorTab {
  path: string;
  status: 'loading' | 'ready' | 'error';
  /** Why the file cannot be shown (too large, binary…). */
  error: string | null;
  encoding: FileEncoding;
  eol: FileEol;
  mixedEol: boolean;
  readOnly: boolean;
  /** Version on disk the buffer started from or was last saved as. */
  version: string | null;
  dirty: boolean;
  saving: boolean;
  /** Set when the file changed on disk; `dirty` decides whether that is a conflict. */
  conflict: TabConflict | null;
  /** The file was reloaded from disk without user action (shown briefly). */
  reloaded: boolean;
}

export interface TabsState {
  tabs: EditorTab[];
  activePath: string | null;
}

export const EMPTY_TABS: TabsState = { tabs: [], activePath: null };

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/**
 * Names shown on tabs: the file name, plus enough of its folder to tell apart
 * open files with the same name (e.g. `index.ts — src/a` and `index.ts — src/b`).
 */
export function tabLabels(paths: readonly string[]): Map<string, { name: string; hint: string }> {
  const labels = new Map<string, { name: string; hint: string }>();
  const byName = new Map<string, string[]>();
  for (const path of paths) {
    const name = fileName(path);
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  for (const [name, group] of byName) {
    for (const path of group) {
      labels.set(path, { name, hint: group.length > 1 ? parentPath(path) || '/' : '' });
    }
  }
  return labels;
}

export function newTab(path: string): EditorTab {
  return {
    path,
    status: 'loading',
    error: null,
    encoding: 'utf8',
    eol: 'LF',
    mixedEol: false,
    readOnly: false,
    version: null,
    dirty: false,
    saving: false,
    conflict: null,
    reloaded: false,
  };
}

export function openTab(state: TabsState, path: string): TabsState {
  const exists = state.tabs.some((tab) => tab.path === path);
  return {
    tabs: exists ? state.tabs : [...state.tabs, newTab(path)],
    activePath: path,
  };
}

/** Closes a tab; the neighbour on the right (or left) becomes active. */
export function closeTab(state: TabsState, path: string): TabsState {
  const index = state.tabs.findIndex((tab) => tab.path === path);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.path !== path);
  if (state.activePath !== path) return { tabs, activePath: state.activePath };
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activePath: next?.path ?? null };
}

export function updateTab(
  state: TabsState,
  path: string,
  patch: Partial<Omit<EditorTab, 'path'>>,
): TabsState {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.path !== path) return tab;
    const next = { ...tab, ...patch };
    changed = (Object.keys(patch) as (keyof EditorTab)[]).some((key) => next[key] !== tab[key]);
    return changed ? next : tab;
  });
  return changed ? { ...state, tabs } : state;
}

/** Whether `path` is `prefix` or inside the folder `prefix`. */
export function isWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Follows a rename or move of a file or folder: open tabs keep their buffers. */
export function renameTabs(state: TabsState, from: string, to: string): TabsState {
  const move = (path: string) => (isWithin(path, from) ? to + path.slice(from.length) : path);
  if (!state.tabs.some((tab) => isWithin(tab.path, from))) return state;
  return {
    tabs: state.tabs.map((tab) =>
      isWithin(tab.path, from) ? { ...tab, path: move(tab.path) } : tab,
    ),
    activePath: state.activePath === null ? null : move(state.activePath),
  };
}

export interface ViewState {
  line?: number;
  column?: number;
  scrollTop?: number;
}

/** What is remembered of the open tabs: references and positions, never contents. */
export function layoutTabs(
  state: TabsState,
  views: ReadonlyMap<string, ViewState>,
  max: number,
): Pick<EditorLayout, 'tabs' | 'activePath'> {
  const tabs = state.tabs.slice(-max).map((tab) => ({ path: tab.path, ...views.get(tab.path) }));
  const activePath =
    state.activePath !== null && tabs.some((tab) => tab.path === state.activePath)
      ? state.activePath
      : (tabs[tabs.length - 1]?.path ?? null);
  return { tabs, activePath };
}

/** Folders whose changes matter: the expanded ones and those of open files. */
export function watchedDirectories(
  tabs: readonly EditorTab[],
  expanded: Iterable<string>,
  max: number,
): string[] {
  const directories = new Set<string>(['']);
  for (const tab of tabs) directories.add(parentPath(tab.path));
  for (const folder of expanded) directories.add(folder);
  return [...directories].slice(0, max);
}
