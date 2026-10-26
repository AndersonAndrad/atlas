/**
 * Score of `path` for a quick-open query: every query character must appear in order
 * (case-insensitive, spaces ignored). Higher is better; null when it does not match.
 * Matches in the file name, at word starts and in runs score higher; long paths lower.
 */
export function fuzzyScore(query: string, path: string): number | null {
  const needle = query.replace(/\s+/g, '').toLowerCase();
  if (needle === '') return 0;
  const haystack = path.toLowerCase();
  const nameStart = path.lastIndexOf('/') + 1;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    const index = haystack.indexOf(char, from);
    if (index === -1) return null;
    const before = path[index - 1];
    if (index === previous + 1) score += 5;
    if (index >= nameStart) score += 3;
    if (
      index === nameStart ||
      before === '/' ||
      before === '-' ||
      before === '_' ||
      before === '.'
    ) {
      score += 4;
    } else if (before !== undefined && /[a-z]/.test(before) && /[A-Z]/.test(path[index]!)) {
      score += 3;
    }
    previous = index;
    from = index + 1;
  }
  if (path.slice(nameStart).toLowerCase().startsWith(needle)) score += 10;
  return score - path.length / 100;
}

/** The `limit` best matches of `query` among `paths`. */
export function bestMatches(query: string, paths: readonly string[], limit: number): string[] {
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const score = fuzzyScore(query, path);
    if (score !== null) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((entry) => entry.path);
}
