import type { SkillDiff, SkillDiffLine, SkillFile } from '@atlas/contracts';

/** Lines compared exactly; longer texts are reported as replaced (bounds memory and time). */
const MAX_DIFF_LINES = 2000;

/** Line diff by longest common subsequence: removed lines before added ones. */
export function diffLines(
  before: string,
  after: string,
): { lines: SkillDiffLine[]; truncated: boolean } {
  const a = before.replace(/\r\n?/g, '\n').split('\n');
  const b = after.replace(/\r\n?/g, '\n').split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return {
      lines: [
        ...a.slice(0, MAX_DIFF_LINES).map((text) => ({ kind: 'removed' as const, text })),
        ...b.slice(0, MAX_DIFF_LINES).map((text) => ({ kind: 'added' as const, text })),
      ],
      truncated: true,
    };
  }
  // lengths[i][j] = LCS length of a[i..] and b[j..], stored row by row.
  const width = b.length + 1;
  const lengths = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }
  const lines: SkillDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      lines.push({ kind: 'removed', text: a[i]! });
      i += 1;
    } else {
      lines.push({ kind: 'added', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) lines.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) lines.push({ kind: 'added', text: b[j++]! });
  return { lines, truncated: false };
}

/** Files added, removed or changed between two versions. */
export function diffFiles(
  before: readonly SkillFile[],
  after: readonly SkillFile[],
): SkillDiff['files'] {
  const old = new Map(before.map((file) => [file.path, file.hash]));
  const current = new Map(after.map((file) => [file.path, file.hash]));
  const changes: SkillDiff['files'] = [];
  for (const [path, hash] of current) {
    if (!old.has(path)) changes.push({ path, change: 'added' });
    else if (old.get(path) !== hash) changes.push({ path, change: 'changed' });
  }
  for (const path of old.keys()) if (!current.has(path)) changes.push({ path, change: 'removed' });
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}
