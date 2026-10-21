import type {
  ContextCategory,
  ContextEntry,
  ContextTask,
  ContextVerification,
  DecisionRecord,
} from '@atlas/contracts';
import { fingerprint, jaccard, terms } from './text.js';

/** Word overlap from which two entries are considered equivalent (FR-607). */
export const NEAR_DUPLICATE_SIMILARITY = 0.85;
/** Short texts are only compared exactly: a few shared words are not equivalence. */
const MIN_WORDS_FOR_NEAR_DUPLICATE = 4;
/** Pairwise comparison is bounded; larger sets are compared exactly only. */
const MAX_NEAR_DUPLICATE_CANDIDATES = 600;
/** Same title and category, bodies this different: likely conflicting notes. */
const CONFLICT_MAX_SIMILARITY = 0.5;

const VERIFICATION_RANK: Record<ContextVerification, number> = {
  verified: 2,
  user: 1,
  observed: 0,
};

/** Kept entry first: required, better verified, then the newest. */
function preferred(a: ContextEntry, b: ContextEntry): number {
  return (
    Number(b.required) - Number(a.required) ||
    VERIFICATION_RANK[b.verification] - VERIFICATION_RANK[a.verification] ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    a.id.localeCompare(b.id)
  );
}

export interface DuplicateGroup {
  kept: ContextEntry;
  duplicates: ContextEntry[];
}

/**
 * Groups equivalent entries: identical normalized text, or a word overlap of at least
 * NEAR_DUPLICATE_SIMILARITY. Nothing is deleted; callers decide what to show. A
 * required entry is only collapsed into another required entry.
 */
export function findDuplicates(entries: readonly ContextEntry[]): DuplicateGroup[] {
  const words = new Map(entries.map((entry) => [entry.id, terms(`${entry.title} ${entry.body}`)]));
  const parent = new Map(entries.map((entry) => [entry.id, entry.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: ContextEntry, b: ContextEntry) => {
    if (a.required !== b.required) return;
    parent.set(find(a.id), find(b.id));
  };

  const byText = new Map<string, ContextEntry[]>();
  for (const entry of entries) {
    const text = words.get(entry.id)!;
    if (text.length === 0) continue;
    const key = fingerprint(text.join(' '));
    byText.set(key, [...(byText.get(key) ?? []), entry]);
  }
  for (const group of byText.values()) {
    for (const required of [true, false]) {
      const [first, ...others] = group.filter((entry) => entry.required === required);
      for (const other of others) union(first!, other);
    }
  }

  if (entries.length <= MAX_NEAR_DUPLICATE_CANDIDATES) {
    const comparable = entries.filter(
      (entry) => words.get(entry.id)!.length >= MIN_WORDS_FOR_NEAR_DUPLICATE,
    );
    const sets = new Map(comparable.map((entry) => [entry.id, new Set(words.get(entry.id))]));
    for (let i = 0; i < comparable.length; i += 1) {
      for (let j = i + 1; j < comparable.length; j += 1) {
        const a = comparable[i]!;
        const b = comparable[j]!;
        if (find(a.id) === find(b.id)) continue;
        if (jaccard(sets.get(a.id)!, sets.get(b.id)!) >= NEAR_DUPLICATE_SIMILARITY) union(a, b);
      }
    }
  }

  const groups = new Map<string, ContextEntry[]>();
  for (const entry of entries) {
    const root = find(entry.id);
    groups.set(root, [...(groups.get(root) ?? []), entry]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const [kept, ...duplicates] = [...group].sort(preferred);
      return { kept: kept!, duplicates };
    });
}

export interface Conflict {
  ids: string[];
  reason: string;
}

const normalizedTitle = (text: string) => terms(text).join(' ');

/**
 * Heuristic conflicts (FR-606): active decisions answering the same question, and
 * entries with the same category and title whose content differs substantially.
 * They are reported for the user to resolve; nothing is chosen automatically.
 */
export function findConflicts(
  entries: readonly ContextEntry[],
  decisions: readonly DecisionRecord[],
): Conflict[] {
  const conflicts: Conflict[] = [];
  const byQuestion = new Map<string, DecisionRecord[]>();
  for (const decision of decisions) {
    if (decision.status !== 'ACTIVE') continue;
    const key = `${decision.taskId ?? ''}\0${normalizedTitle(decision.question)}`;
    byQuestion.set(key, [...(byQuestion.get(key) ?? []), decision]);
  }
  for (const group of byQuestion.values()) {
    if (group.length < 2 || new Set(group.map((item) => item.decision.trim())).size < 2) continue;
    conflicts.push({
      ids: group.map((item) => item.id),
      reason: `${group.length} active decisions answer "${group[0]!.question}" differently`,
    });
  }

  const byTitle = new Map<string, ContextEntry[]>();
  for (const entry of entries) {
    const title = normalizedTitle(entry.title);
    if (title === '' || entry.body.trim() === '') continue;
    const key = `${entry.category}\0${entry.taskId ?? ''}\0${title}`;
    byTitle.set(key, [...(byTitle.get(key) ?? []), entry]);
  }
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const [first, ...others] = group;
    const differing = others.filter(
      (other) => jaccard(terms(first!.body), terms(other.body)) < CONFLICT_MAX_SIMILARITY,
    );
    if (differing.length === 0) continue;
    conflicts.push({
      ids: [first!.id, ...differing.map((item) => item.id)],
      reason: `"${first!.title}" is recorded more than once with different content`,
    });
  }
  return conflicts;
}

const PENDING_CATEGORIES: readonly ContextCategory[] = ['next-action', 'pending-decision'];

/** Pending work of tasks already done or abandoned (FR-606). */
export function pendingOfClosedTasks(
  entries: readonly ContextEntry[],
  tasks: readonly ContextTask[],
): { entry: ContextEntry; task: ContextTask }[] {
  const closed = new Map(
    tasks.filter((task) => task.status !== 'open').map((task) => [task.id, task]),
  );
  return entries.flatMap((entry) => {
    const task = entry.taskId === null ? undefined : closed.get(entry.taskId);
    return task !== undefined && PENDING_CATEGORIES.includes(entry.category)
      ? [{ entry, task }]
      : [];
  });
}

/** Categories that state facts about the code and should point at evidence. */
const EVIDENCE_CATEGORIES: readonly ContextCategory[] = [
  'architecture',
  'progress',
  'files-changed',
  'commit',
  'test-result',
  'known-failure',
];

/** Factual entries with no file, commit or source reference (FR-608). */
export function missingSources(entries: readonly ContextEntry[]): ContextEntry[] {
  return entries.filter(
    (entry) =>
      EVIDENCE_CATEGORIES.includes(entry.category) &&
      entry.refs.files.length === 0 &&
      entry.refs.commit === null &&
      entry.source.ref === null,
  );
}
