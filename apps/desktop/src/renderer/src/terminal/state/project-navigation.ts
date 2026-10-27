import { useSyncExternalStore } from 'react';

/** How many recently opened projects the command palette offers (PLAN-052). */
export const RECENT_PROJECTS_LIMIT = 5;

/** Lower case without accents, so "Sêres" matches "seres". */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Items whose name contains the query, ignoring case and accents; names that start with
 * it come first, otherwise the original order is kept. An empty query keeps every item.
 */
export function filterByName<T>(
  items: readonly T[],
  query: string,
  name: (item: T) => string,
): T[] {
  const needle = normalize(query);
  if (needle === '') return [...items];
  const starts: T[] = [];
  const contains: T[] = [];
  for (const item of items) {
    const value = normalize(name(item));
    if (value.startsWith(needle)) starts.push(item);
    else if (value.includes(needle)) contains.push(item);
  }
  return [...starts, ...contains];
}

/** Moves `id` to the front of the list, without duplicates, keeping at most `limit` ids. */
export function pushRecent(
  list: readonly string[],
  id: string,
  limit = RECENT_PROJECTS_LIMIT,
): string[] {
  return [id, ...list.filter((item) => item !== id)].slice(0, Math.max(0, limit));
}

// Kept in memory only (PLAN-052 Q2): the list starts empty when the application starts.
let recent: readonly string[] = [];
const listeners = new Set<() => void>();

/** Records a project the user just worked in (opened a terminal or ran a quick command). */
export function markProjectRecent(projectId: string): void {
  recent = pushRecent(recent, projectId);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Recently opened project ids, most recent first. */
export function useRecentProjectIds(): readonly string[] {
  return useSyncExternalStore(subscribe, () => recent);
}
