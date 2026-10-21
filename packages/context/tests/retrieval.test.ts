import { describe, expect, it } from 'vitest';
import {
  ContextBudgetSettingsSchema,
  type ContextBudgetSettings,
  type ContextEntry,
  type ContextTask,
  type DecisionRecord,
} from '@atlas/contracts';
import {
  CONTEXT_BUDGETS_KEY,
  ContextBudgetStore,
  LruCache,
  findConflicts,
  findDuplicates,
  fingerprint,
  jaccard,
  matchedTerms,
  missingSources,
  pendingOfClosedTasks,
  queryTerms,
  resolveBudget,
  scoreDecision,
  scoreEntry,
  terms,
  totalScore,
  type RetrievalQuery,
} from '../src/index.js';

let next = 0;
const id = () => `00000000-0000-4000-8000-${String((next += 1)).padStart(12, '0')}`;
const NOW = new Date('2026-10-20T00:00:00.000Z');

const entry = (overrides: Partial<ContextEntry>): ContextEntry => ({
  id: id(),
  scope: 'project',
  projectId: 'p',
  workspacePath: null,
  taskId: null,
  sessionId: null,
  category: 'note',
  title: 'Title',
  body: '',
  status: 'active',
  verification: 'user',
  source: { kind: 'user', ref: null, recordedBy: 'desktop' },
  refs: { files: [], commit: null },
  required: false,
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const decision = (overrides: Partial<DecisionRecord>): DecisionRecord => ({
  id: id(),
  projectId: 'p',
  workspacePath: null,
  taskId: null,
  question: 'Token storage',
  decision: 'httpOnly cookie',
  alternatives: [],
  reasoning: '',
  evidence: [],
  affected: [],
  status: 'ACTIVE',
  supersededBy: null,
  author: 'desktop',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const task = (overrides: Partial<ContextTask>): ContextTask => ({
  id: id(),
  projectId: 'p',
  workspacePath: null,
  title: 'Task',
  objective: 'Objective',
  status: 'open',
  baseCommit: null,
  baseBranch: null,
  budgetTokens: null,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

const query = (overrides: Partial<RetrievalQuery> = {}): RetrievalQuery => ({
  terms: [],
  files: [],
  role: 'generic',
  taskId: null,
  ...overrides,
});
const context = (overrides: Partial<RetrievalQuery> = {}) => ({
  query: query(overrides),
  now: NOW,
  stale: false,
  otherBranch: null,
  searchRank: undefined,
});

describe('text', () => {
  it('normalizes case, diacritics and camelCase and drops stopwords', () => {
    expect(terms('Configuração do SharedContextService para o JWT')).toEqual([
      'configuracao',
      'shared',
      'context',
      'service',
      'jwt',
    ]);
    expect(terms('the and com para')).toEqual([]);
  });

  it('matches equal words and extensions of terms with four or more characters', () => {
    const words = terms('Refresh tokens rotate on login');
    expect(matchedTerms(['token', 'log', 'refresh', 'cookie'], words)).toEqual([
      'token',
      'refresh',
    ]);
  });

  it('fingerprints content stably and measures word overlap', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
    // FNV-1a 64-bit reference vectors.
    expect(fingerprint('')).toBe('cbf29ce484222325');
    expect(fingerprint('a')).toBe('af63dc4c8601ec8c');
    expect(fingerprint('foobar')).toBe('85944171f73967e8');
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });

  it('builds query terms from the objective and keywords, without duplicates', () => {
    expect(queryTerms('Add JWT refresh', ['jwt', 'Redis'])).toEqual([
      'add',
      'jwt',
      'refresh',
      'redis',
    ]);
    expect(queryTerms(null, [])).toEqual([]);
  });
});

describe('scoring (FR-602)', () => {
  it('explains every point: the score is the sum of its factors', () => {
    const factors = scoreEntry(
      entry({ title: 'JWT refresh flow', category: 'architecture', verification: 'verified' }),
      context({ terms: ['jwt', 'refresh'] }),
    );
    expect(factors.map((factor) => factor.name)).toEqual([
      'text',
      'category',
      'verification',
      'recency',
    ]);
    expect(factors.find((factor) => factor.name === 'text')?.detail).toContain('2 of 2');
    expect(totalScore(factors)).toBe(30 + 8 + 10 + factors.at(-1)!.points);
  });

  it('never lets recency outrank a verified decision', () => {
    const fresh = entry({
      title: 'Token storage idea',
      verification: 'observed',
      updatedAt: NOW.toISOString(),
    });
    const old = decision({ updatedAt: '2020-01-01T00:00:00.000Z' });
    const c = context({ terms: ['token', 'storage'] });
    expect(totalScore(scoreDecision(old, c))).toBeGreaterThan(totalScore(scoreEntry(fresh, c)));
  });

  it('weights categories by role and rewards task scope and requested files', () => {
    const tests = entry({ category: 'test-result', title: 'Unit tests' });
    const qa = totalScore(scoreEntry(tests, context({ role: 'qa' })));
    const generic = totalScore(scoreEntry(tests, context({ role: 'generic' })));
    expect(qa).toBeGreaterThan(generic);

    const taskNote = entry({ taskId: 't1', title: 'Step' });
    expect(scoreEntry(taskNote, context({ taskId: 't1' })).map((f) => f.name)).toContain('scope');

    const fileNote = entry({ refs: { files: [{ path: 'src/auth.ts', hash: 'h' }], commit: null } });
    const files = scoreEntry(fileNote, context({ files: ['src/auth.ts'] }));
    expect(files.find((factor) => factor.name === 'files')?.points).toBe(20);
    const near = scoreEntry(fileNote, context({ files: ['src/user.ts'] }));
    expect(near.find((factor) => factor.name === 'files')?.points).toBe(8);
  });

  it('penalizes stale entries and entries written on another branch', () => {
    const note = entry({});
    const base = totalScore(scoreEntry(note, context()));
    const stale = scoreEntry(note, { ...context(), stale: true, otherBranch: 'feature/x' });
    expect(totalScore(stale)).toBe(base - 25);
  });
});

describe('budgets (FR-603)', () => {
  const settings: ContextBudgetSettings = {
    defaultTokens: 6000,
    providers: { claude: 8000 },
    roles: { qa: 4000 },
    profiles: { ECONOMY: 2000 },
  };

  it('applies the most specific budget: request, task, profile, role, provider, default', () => {
    const base = { role: 'qa' as const, provider: 'claude' as const };
    expect(
      resolveBudget(settings, {
        ...base,
        requested: 1000,
        task: { budgetTokens: 3000 },
        profile: 'ECONOMY',
      }),
    ).toEqual({ tokens: 1000, source: 'request' });
    expect(
      resolveBudget(settings, { ...base, task: { budgetTokens: 3000 }, profile: 'ECONOMY' }),
    ).toEqual({ tokens: 3000, source: 'task' });
    expect(resolveBudget(settings, { ...base, profile: 'ECONOMY' })).toEqual({
      tokens: 2000,
      source: 'profile',
    });
    expect(resolveBudget(settings, base)).toEqual({ tokens: 4000, source: 'role' });
    expect(resolveBudget(settings, { role: 'generic', provider: 'claude' })).toEqual({
      tokens: 8000,
      source: 'provider',
    });
    expect(resolveBudget(settings, { role: 'generic', provider: 'codex' })).toEqual({
      tokens: 6000,
      source: 'default',
    });
  });

  it('stores budgets, keeps unchanged groups and falls back to defaults on bad data', async () => {
    const values = new Map<string, string>();
    const store = new ContextBudgetStore({
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => void values.set(key, value),
    });
    expect(await store.get()).toEqual(ContextBudgetSettingsSchema.parse({}));
    await store.update({ defaultTokens: 8000, roles: { qa: 4000 } });
    const updated = await store.update({ providers: { codex: 2000 } });
    expect(updated).toEqual({
      defaultTokens: 8000,
      providers: { codex: 2000 },
      roles: { qa: 4000 },
      profiles: {},
    });
    await expect(store.update({ defaultTokens: 100 })).rejects.toThrow();
    await expect(store.update({ roles: { boss: 4000 } })).rejects.toThrow();
    values.set(CONTEXT_BUDGETS_KEY, '{not json');
    expect((await store.get()).defaultTokens).toBe(6000);
  });
});

describe('consistency (FR-606–FR-608)', () => {
  it('groups exact and near duplicates and keeps the best verified record', () => {
    const a = entry({ title: 'Use pnpm workspaces', body: 'Install with pnpm' });
    const b = entry({
      title: 'use PNPM workspaces',
      body: 'install with pnpm',
      verification: 'verified',
    });
    const c = entry({
      title: 'Hexagonal architecture layers',
      body: 'ports adapters core domain services',
    });
    const d = entry({
      title: 'Hexagonal architecture layers',
      body: 'ports adapters core domain services kept',
    });
    const e = entry({ title: 'Unrelated', body: 'something else entirely different' });
    const groups = findDuplicates([a, b, c, d, e]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ kept: b, duplicates: [a] });
    expect(new Set([groups[1]!.kept.id, ...groups[1]!.duplicates.map((x) => x.id)])).toEqual(
      new Set([c.id, d.id]),
    );
  });

  it('never collapses a required entry into an optional one', () => {
    const required = entry({ title: 'Never edit generated files', required: true });
    const optional = entry({ title: 'Never edit generated files' });
    expect(findDuplicates([required, optional])).toEqual([]);
  });

  it('reports conflicting decisions and notes without choosing one', () => {
    const conflicts = findConflicts(
      [
        entry({ category: 'command', title: 'Build command', body: 'pnpm build' }),
        entry({ category: 'command', title: 'Build command', body: 'make all release' }),
        entry({ category: 'command', title: 'Test command', body: 'pnpm test' }),
      ],
      [
        decision({ question: 'Token storage?', decision: 'cookie' }),
        decision({ question: 'token storage', decision: 'localStorage' }),
        decision({ question: 'Token storage', decision: 'x', status: 'SUPERSEDED' }),
      ],
    );
    expect(conflicts.map((conflict) => conflict.reason)).toEqual([
      '2 active decisions answer "Token storage?" differently',
      '"Build command" is recorded more than once with different content',
    ]);
  });

  it('finds pending work of closed tasks and factual records without a source', () => {
    const done = task({ status: 'done' });
    const open = task({});
    const pending = entry({ taskId: done.id, category: 'next-action', title: 'Add tests' });
    const stillOpen = entry({ taskId: open.id, category: 'next-action' });
    expect(pendingOfClosedTasks([pending, stillOpen], [done, open])).toEqual([
      { entry: pending, task: done },
    ]);

    const unsourced = entry({ category: 'progress', title: 'Login works' });
    const sourced = entry({
      category: 'progress',
      refs: { files: [{ path: 'a.ts', hash: null }], commit: null },
    });
    const note = entry({ category: 'note' });
    expect(missingSources([unsourced, sourced, note])).toEqual([unsourced]);
  });
});

describe('LruCache (FR-612)', () => {
  it('evicts the least recently used value beyond its capacity', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
