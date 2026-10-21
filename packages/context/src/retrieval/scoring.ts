import type {
  AgentRole,
  BundleSection,
  ContextCategory,
  ContextEntry,
  ContextVerification,
  DecisionRecord,
  ScoreFactor,
} from '@atlas/contracts';
import { matchedTerms, terms } from './text.js';

/** What the context is being selected for (FR-601). */
export interface RetrievalQuery {
  /** Terms of the objective and keywords. */
  terms: string[];
  /** Repository-relative files the work is about. */
  files: string[];
  role: AgentRole;
  taskId: string | null;
}

export interface ScoreContext {
  query: RetrievalQuery;
  now: Date;
  stale: boolean;
  /** The entry was recorded on another branch than the one checked out now. */
  otherBranch: string | null;
  /** Position in the full-text results for the query (0 = best), if it matched. */
  searchRank: number | undefined;
}

/**
 * Category importance per role, 0–15. Roles see the same records, ranked for their
 * work: QA favours test results, security favours constraints and failures, etc.
 */
const BASE_WEIGHTS: Record<ContextCategory, number> = {
  constraint: 15,
  blocker: 12,
  'known-failure': 10,
  'next-action': 10,
  'pending-decision': 10,
  architecture: 8,
  convention: 8,
  'test-result': 8,
  command: 6,
  objective: 6,
  overview: 6,
  progress: 6,
  commit: 4,
  'files-changed': 4,
  summary: 3,
  note: 2,
  'provider-reference': 2,
};

const ROLE_WEIGHTS: Record<AgentRole, Partial<Record<ContextCategory, number>>> = {
  generic: {},
  architect: { architecture: 15, overview: 12, convention: 10, 'pending-decision': 12 },
  developer: { convention: 12, command: 10, 'next-action': 12, 'files-changed': 8, progress: 8 },
  qa: { 'test-result': 15, 'known-failure': 14, command: 10, progress: 8 },
  security: { constraint: 15, 'known-failure': 12, architecture: 10, convention: 10 },
  reviewer: { convention: 12, 'test-result': 10, 'files-changed': 8, commit: 6 },
};

export const categoryWeight = (role: AgentRole, category: ContextCategory) =>
  ROLE_WEIGHTS[role][category] ?? BASE_WEIGHTS[category];

const VERIFICATION_POINTS: Record<ContextVerification, number> = {
  verified: 10,
  user: 6,
  observed: 0,
};

/** Text match is worth at most this many points. */
const TEXT_POINTS = 30;
/** Recency is deliberately small: newer is not more authoritative (FR-602). */
const RECENCY_POINTS = 5;
const RECENCY_HALF_LIFE_DAYS = 30;
const DECISION_POINTS = 20;
const STALE_PENALTY = -20;
const OTHER_BRANCH_PENALTY = -5;
const DAY_MS = 86_400_000;

/** Bundle section of an entry; required entries and constraints come first. */
export function sectionOf(
  entry: ContextEntry,
  query: RetrievalQuery,
  isGlobal: boolean,
): BundleSection {
  if (entry.required || entry.category === 'constraint') return 'constraints';
  if (isGlobal) return 'global';
  if (query.files.length > 0 && fileMatches(entry, query.files).exact > 0) return 'relevant-files';
  switch (entry.category) {
    case 'progress':
    case 'commit':
    case 'files-changed':
    case 'next-action':
    case 'pending-decision':
      return 'task-state';
    case 'test-result':
      return 'validations';
    case 'blocker':
    case 'known-failure':
      return 'blockers';
    case 'overview':
    case 'architecture':
    case 'convention':
    case 'command':
    case 'objective':
      return 'knowledge';
    default:
      return 'history';
  }
}

const directoryOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf('/')));

/** Requested files referenced (exact), in the same directory, or named in the text. */
export function fileMatches(entry: ContextEntry, files: readonly string[]) {
  const referenced = entry.refs.files.map((file) => file.path);
  const text = `${entry.title}\n${entry.body}`;
  let exact = 0;
  let near = 0;
  for (const file of files) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    if (
      referenced.includes(file) ||
      text.includes(file) ||
      (base.length >= 5 && text.includes(base))
    ) {
      exact += 1;
    } else if (
      directoryOf(file) !== '' &&
      referenced.some((path) => directoryOf(path) === directoryOf(file))
    ) {
      near += 1;
    }
  }
  return { exact, near };
}

function textFactors(text: string, context: ScoreContext): ScoreFactor[] {
  const factors: ScoreFactor[] = [];
  const queryTerms = context.query.terms;
  if (queryTerms.length > 0) {
    const found = matchedTerms(queryTerms, terms(text));
    if (found.length > 0) {
      factors.push({
        name: 'text',
        points: Math.round((TEXT_POINTS * found.length) / queryTerms.length),
        detail: `matches ${found.length} of ${queryTerms.length} term(s): ${found.slice(0, 5).join(', ')}`,
      });
    }
  }
  if (context.searchRank !== undefined) {
    factors.push({
      name: 'search-rank',
      points: Math.max(1, 10 - context.searchRank),
      detail: `full-text result #${context.searchRank + 1}`,
    });
  }
  return factors;
}

function recencyFactor(updatedAt: string, now: Date): ScoreFactor {
  const time = Date.parse(updatedAt);
  if (Number.isNaN(time)) return { name: 'recency', points: 0, detail: 'no update time' };
  const ageDays = Math.max(0, (now.getTime() - time) / DAY_MS);
  return {
    name: 'recency',
    points: Math.round(RECENCY_POINTS * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS)),
    detail: `updated ${Math.floor(ageDays)} day(s) ago`,
  };
}

function freshnessFactors(context: ScoreContext): ScoreFactor[] {
  const factors: ScoreFactor[] = [];
  if (context.stale) {
    factors.push({
      name: 'stale',
      points: STALE_PENALTY,
      detail: 'refers to files or commits that changed',
    });
  }
  if (context.otherBranch !== null) {
    factors.push({
      name: 'branch',
      points: OTHER_BRANCH_PENALTY,
      detail: `recorded on branch ${context.otherBranch}`,
    });
  }
  return factors;
}

export const totalScore = (factors: readonly ScoreFactor[]) =>
  factors.reduce((sum, factor) => sum + factor.points, 0);

/** Explainable relevance of an entry (FR-602): every point comes from a listed factor. */
export function scoreEntry(entry: ContextEntry, context: ScoreContext): ScoreFactor[] {
  const { query } = context;
  const factors = textFactors(`${entry.title}\n${entry.body}`, context);
  if (query.taskId !== null && entry.taskId === query.taskId) {
    factors.push({ name: 'scope', points: 10, detail: 'belongs to the task' });
  }
  if (query.files.length > 0) {
    const { exact, near } = fileMatches(entry, query.files);
    if (exact + near > 0) {
      factors.push({
        name: 'files',
        points: Math.min(25, exact * 20 + near * 8),
        detail: `${exact} requested file(s) referenced, ${near} in the same folder`,
      });
    }
  }
  factors.push({
    name: 'category',
    points: categoryWeight(query.role, entry.category),
    detail: `${entry.category} for the ${query.role} role`,
  });
  factors.push({
    name: 'verification',
    points: VERIFICATION_POINTS[entry.verification],
    detail: entry.verification,
  });
  factors.push(recencyFactor(entry.updatedAt, context.now));
  factors.push(...freshnessFactors(context));
  return factors;
}

/** Active decisions outrank notes of similar relevance; recency never overrides that. */
export function scoreDecision(decision: DecisionRecord, context: ScoreContext): ScoreFactor[] {
  const factors = textFactors(
    `${decision.question}\n${decision.decision}\n${decision.reasoning}`,
    context,
  );
  factors.push({ name: 'decision', points: DECISION_POINTS, detail: 'active decision' });
  if (context.query.taskId !== null && decision.taskId === context.query.taskId) {
    factors.push({ name: 'scope', points: 10, detail: 'belongs to the task' });
  }
  factors.push({ name: 'verification', points: VERIFICATION_POINTS.user, detail: 'user' });
  factors.push(recencyFactor(decision.updatedAt, context.now));
  return factors;
}

/** Terms of an objective and extra keywords, for scoring and full-text search. */
export function queryTerms(objective: string | null, keywords: readonly string[]): string[] {
  return [
    ...new Set([...terms(objective ?? ''), ...keywords.flatMap((word) => terms(word))]),
  ].slice(0, 40);
}
