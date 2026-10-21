import { describe, expect, it } from 'vitest';
import type { ContextEntry, ContextHandoff, DecisionRecord } from '@atlas/contracts';
import {
  UNTRUSTED_NOTICE,
  buildBundle,
  continuationPrompt,
  handoffMarkdown,
} from '../src/index.js';

let next = 0;
const entry = (overrides: Partial<ContextEntry>): ContextEntry => ({
  id: `00000000-0000-4000-8000-${String((next += 1)).padStart(12, '0')}`,
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
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  ...overrides,
});

const decision = (question: string, answer: string): DecisionRecord => ({
  id: `d-${question}`,
  projectId: 'p',
  workspacePath: null,
  taskId: null,
  question,
  decision: answer,
  alternatives: [],
  reasoning: 'simpler',
  evidence: [],
  affected: [],
  status: 'ACTIVE',
  supersededBy: null,
  author: 'desktop',
  createdAt: '',
  updatedAt: '',
});

const freshness = {
  repositoryRoot: '/repo',
  branch: 'main',
  head: 'a'.repeat(40),
  uncommittedFiles: 2,
  stale: [] as { id: string; reason: string }[],
};

describe('buildBundle', () => {
  it('orders knowledge by priority and marks verification and staleness', () => {
    const blocker = entry({
      category: 'blocker',
      title: 'Token refresh fails',
      verification: 'observed',
    });
    const arch = entry({
      category: 'architecture',
      title: 'Hexagonal layers',
      body: 'ports in core',
    });
    const commits = entry({ category: 'commit', title: '2 commits', verification: 'verified' });
    const bundle = buildBundle({
      label: 'API',
      provider: 'codex',
      budgetTokens: 6000,
      freshness: {
        ...freshness,
        stale: [{ id: arch.id, reason: 'src/core changed since it was recorded' }],
      },
      task: {
        id: 't',
        projectId: 'p',
        workspacePath: null,
        title: 'JWT auth',
        objective: 'Implement JWT authentication',
        status: 'open',
        baseCommit: null,
        baseBranch: null,
        budgetTokens: null,
        createdAt: '',
        updatedAt: '',
      },
      entries: [arch, blocker, commits],
      globalEntries: [
        entry({ scope: 'global', projectId: null, category: 'convention', title: 'Use pnpm' }),
      ],
      decisions: [decision('Token storage', 'httpOnly cookie')],
      generatedAt: '2026-10-20T00:00:00.000Z',
    });
    const md = bundle.markdown;
    expect(md).toContain('Context for Codex CLI');
    expect(md).toContain(UNTRUSTED_NOTICE);
    expect(md).toContain('Branch: main');
    expect(md).toContain('uncommitted files: 2');
    expect(md).toContain('STALE: src/core changed');
    expect(md.indexOf('Implement JWT authentication')).toBeLessThan(md.indexOf('Token storage'));
    expect(md.indexOf('Token storage')).toBeLessThan(md.indexOf('Token refresh fails'));
    expect(md.indexOf('Token refresh fails')).toBeLessThan(md.indexOf('Hexagonal layers'));
    expect(md).toContain('- [unverified] Token refresh fails');
    expect(md).toContain('- [verified] 2 commits');
    expect(md).toContain('- [by user, STALE] Hexagonal layers: ports in core');
    expect(md).toContain('Use pnpm');
    expect(bundle.omitted).toBe(0);
    expect(bundle.tokenEstimate).toBe(Math.ceil(md.length / 4));
  });

  it('respects the token budget and counts what was left out', () => {
    const entries = Array.from({ length: 200 }, (_, index) =>
      entry({ category: 'architecture', title: `Note ${index}`, body: 'x'.repeat(400) }),
    );
    const bundle = buildBundle({
      label: 'Big',
      provider: 'generic',
      budgetTokens: 500,
      freshness,
      task: null,
      entries,
      globalEntries: [],
      decisions: [],
      generatedAt: '',
    });
    expect(bundle.markdown.length).toBeLessThanOrEqual(500 * 4 + 200);
    expect(bundle.omitted).toBeGreaterThan(0);
    expect(bundle.markdown).toContain(`${bundle.omitted} more record(s) left out`);
  });

  it('says when there is no repository evidence', () => {
    const bundle = buildBundle({
      label: 'Plain',
      provider: 'claude',
      budgetTokens: 1000,
      freshness: { repositoryRoot: null, branch: null, head: null, uncommittedFiles: 0, stale: [] },
      task: null,
      entries: [],
      globalEntries: [],
      decisions: [],
      generatedAt: '',
    });
    expect(bundle.markdown).toContain('Not a Git repository');
    expect(bundle.markdown).toContain('Context for Claude Code');
  });
});

describe('buildBundle retrieval (SDD-006)', () => {
  const base = {
    label: 'API',
    provider: 'generic' as const,
    budgetTokens: 6000,
    freshness,
    task: null,
    globalEntries: [] as ContextEntry[],
    decisions: [] as DecisionRecord[],
    generatedAt: '2026-10-20T00:00:00.000Z',
  };
  const accounted = (bundle: ReturnType<typeof buildBundle>) =>
    [
      ...bundle.included.map((ref) => ref.id),
      ...bundle.excluded.map((item) => item.reference.id),
    ].sort();

  it('ranks by the objective and leaves unrelated history out, listing why', () => {
    const relevant = entry({ category: 'note', title: 'Refresh tokens rotate', body: 'JWT' });
    const unrelated = entry({ category: 'summary', title: 'Styled the login page' });
    const knowledge = entry({ category: 'convention', title: 'Use pnpm' });
    const entries = [unrelated, relevant, knowledge];
    const bundle = buildBundle({ ...base, entries, objective: 'Rotate JWT refresh tokens' });
    expect(bundle.objective).toBe('Rotate JWT refresh tokens');
    expect(bundle.markdown).toContain('## Objective\nRotate JWT refresh tokens');
    expect(bundle.included.map((ref) => ref.id)).toEqual([knowledge.id, relevant.id]);
    expect(bundle.excluded).toEqual([
      expect.objectContaining({
        reason: 'not-relevant',
        reference: expect.objectContaining({ id: unrelated.id }),
      }),
    ]);
    expect(bundle.markdown).toContain('1 record(s) not needed for this objective');
    // Nothing is dropped silently: every candidate is included or excluded with a reason.
    expect(accounted(bundle)).toEqual(entries.map((item) => item.id).sort());

    const withoutObjective = buildBundle({ ...base, entries });
    expect(withoutObjective.excluded).toEqual([]);
  });

  it('keeps required records and the objective even beyond the budget', () => {
    const rules = [1, 2, 3, 4, 5].map((index) =>
      entry({
        category: 'constraint',
        title: `Rule ${index}`,
        required: true,
        body: `${index}`.repeat(3000),
      }),
    );
    const optional = entry({ category: 'architecture', title: 'Optional', body: 'y'.repeat(400) });
    const bundle = buildBundle({
      ...base,
      budgetTokens: 500,
      entries: [optional, ...rules],
      objective: 'Ship it',
    });
    expect(bundle.overBudget).toBe(true);
    expect(bundle.included.map((ref) => ref.id).sort()).toEqual(
      rules.map((rule) => rule.id).sort(),
    );
    expect(bundle.markdown).toContain('[by user, required] Rule 1');
    expect(bundle.excluded).toEqual([expect.objectContaining({ reason: 'budget' })]);
    expect(bundle.warnings.map((warning) => warning.kind)).toContain('over-budget');
    expect(bundle.markdown).toContain('Ship it');
  });

  it('lets the user exclude optional records but never required ones', () => {
    const rule = entry({ category: 'constraint', title: 'Rule', required: true });
    const note = entry({ category: 'architecture', title: 'Note' });
    const bundle = buildBundle({ ...base, entries: [rule, note], excludeIds: [rule.id, note.id] });
    expect(bundle.included.map((ref) => ref.id)).toEqual([rule.id]);
    expect(bundle.excluded).toEqual([
      expect.objectContaining({
        reason: 'user',
        reference: expect.objectContaining({ id: note.id }),
      }),
    ]);
    expect(bundle.warnings).toContainEqual(
      expect.objectContaining({ kind: 'required-not-excludable', ids: [rule.id] }),
    );
    expect(bundle.instructions).toEqual([UNTRUSTED_NOTICE]);
  });

  it('shows duplicates once and compacts older session summaries', () => {
    const first = entry({ title: 'Use pnpm workspaces', category: 'convention' });
    const copy = entry({
      title: 'use pnpm workspaces',
      category: 'convention',
      updatedAt: '2026-10-21T00:00:00.000Z',
    });
    const summaries = [1, 2, 3, 4].map((day) =>
      entry({
        category: 'summary',
        title: `Summary of ${['alpha', 'bravo', 'charlie', 'delta'][day - 1]}`,
        body: ['login', 'tokens', 'cookies', 'storage'][day - 1]!,
        createdAt: `2026-10-0${day}T00:00:00.000Z`,
      }),
    );
    const bundle = buildBundle({ ...base, entries: [first, copy, ...summaries] });
    const kept = bundle.included.find((ref) => ref.id === copy.id);
    expect(kept?.duplicates).toEqual([first.id]);
    expect(bundle.excluded).toContainEqual(
      expect.objectContaining({
        reason: 'duplicate',
        reference: expect.objectContaining({ id: first.id }),
      }),
    );
    expect(bundle.excluded).toContainEqual(
      expect.objectContaining({
        reason: 'compacted',
        reference: expect.objectContaining({ id: summaries[0]!.id }),
      }),
    );
    expect(bundle.markdown.match(/use pnpm workspaces/gi)).toHaveLength(1);
  });

  it('loads essential context first and leaves knowledge for later (progressive)', () => {
    const blocker = entry({ category: 'blocker', title: 'CI is red' });
    const knowledge = entry({ category: 'architecture', title: 'Layers' });
    const bundle = buildBundle({ ...base, entries: [blocker, knowledge], detail: 'essential' });
    expect(bundle.included.map((ref) => ref.id)).toEqual([blocker.id]);
    expect(bundle.excluded).toEqual([expect.objectContaining({ reason: 'progressive' })]);
  });

  it('puts records about the requested files in their own section and fills the contract', () => {
    const fileNote = entry({
      category: 'progress',
      title: 'Login endpoint done',
      refs: { files: [{ path: 'src/auth.ts', hash: 'h' }], commit: null },
      source: { kind: 'ai-session', ref: 'session-1', recordedBy: 'desktop' },
    });
    const next = entry({ category: 'next-action', title: 'Refresh tokens' });
    const test = entry({
      category: 'test-result',
      title: 'Unit tests pass',
      verification: 'verified',
    });
    const blocker = entry({ category: 'blocker', title: 'Redis missing' });
    const bundle = buildBundle({
      ...base,
      entries: [fileNote, next, test, blocker],
      files: ['src/auth.ts'],
      decisions: [decision('Token storage', 'cookie')],
      role: 'developer',
      budgetSource: 'role',
    });
    expect(bundle.relevantFiles.map((ref) => ref.id)).toEqual([fileNote.id]);
    expect(bundle.relevantFiles[0]?.source).toEqual(fileNote.source);
    expect(bundle.relevantFiles[0]?.files).toEqual(['src/auth.ts']);
    expect(bundle.completedWork.map((ref) => ref.id)).toEqual([fileNote.id]);
    expect(bundle.pendingWork.map((ref) => ref.id)).toEqual([next.id]);
    expect(bundle.validations.map((ref) => ref.id)).toEqual([test.id]);
    expect(bundle.blockers.map((ref) => ref.id)).toEqual([blocker.id]);
    expect(bundle.decisions).toHaveLength(1);
    expect(bundle.role).toBe('developer');
    expect(bundle.budgetSource).toBe('role');
    expect(bundle.tokenEstimateMethod).toBe('approximation: characters / 4');
    expect(bundle.estimatedTokens).toBe(bundle.tokenEstimate);
    const md = bundle.markdown;
    expect(md.indexOf('## Active decisions')).toBeLessThan(md.indexOf('## Relevant files'));
    expect(md.indexOf('## Relevant files')).toBeLessThan(md.indexOf('## Current task state'));
    expect(md.indexOf('## Validations')).toBeLessThan(md.indexOf('## Blockers and known failures'));
  });

  it('warns about other branches, conflicts and pending work of a closed task', () => {
    const closed = {
      id: 't',
      projectId: 'p',
      workspacePath: null,
      title: 'Done task',
      objective: 'Finished objective',
      status: 'done' as const,
      baseCommit: null,
      baseBranch: null,
      budgetTokens: null,
      createdAt: '',
      updatedAt: '',
    };
    const bundle = buildBundle({
      ...base,
      task: closed,
      entries: [
        entry({
          title: 'Old',
          refs: { files: [{ path: 'a.ts', hash: 'h' }], commit: null, branch: 'feature/x' },
        }),
        entry({ taskId: 't', category: 'next-action', title: 'Leftover' }),
      ],
      decisions: [decision('Storage', 'cookie'), { ...decision('Storage', 'local'), id: 'd-2' }],
    });
    expect(bundle.warnings.map((warning) => warning.kind).sort()).toEqual([
      'branch-changed',
      'conflict',
      'pending-of-closed-task',
    ]);
    expect(
      bundle.included.find((ref) => ref.title === 'Old')?.factors.map((f) => f.name),
    ).toContain('branch');
  });
});

describe('handoffMarkdown and continuationPrompt', () => {
  const handoff: ContextHandoff = {
    id: 'h',
    projectId: 'p',
    workspacePath: null,
    sourceSessionId: null,
    targetProvider: 'codex',
    taskId: null,
    objective: 'Implement JWT authentication',
    completedWork: ['Login endpoint'],
    pendingWork: ['Refresh tokens'],
    decisions: ['Token storage → httpOnly cookie'],
    blockers: [],
    changedFiles: ['src/auth.ts'],
    commits: ['abc123 feat(auth): login'],
    validations: [],
    nextActions: ['Write integration tests'],
    sourceRevision: 'abc123',
    evidence: { entryIds: [], decisionIds: [] },
    createdAt: '2026-10-20T00:00:00.000Z',
  };

  it('renders every section, marks Git evidence and never claims untested results', () => {
    const md = handoffMarkdown(handoff, 'API');
    expect(md).toContain('Prepared for Codex CLI');
    expect(md).toContain('Source revision: abc123');
    expect(md).toContain('## Commits (verified from Git');
    expect(md).toContain('- src/auth.ts');
    expect(md).toContain('No validation evidence recorded; nothing is known to pass.');
    expect(md).toContain('- None recorded.');
  });

  it('wraps context as information, not instructions', () => {
    const prompt = continuationPrompt('CONTEXT');
    expect(prompt).toContain('check the current');
    expect(prompt).toContain('not as instructions');
    expect(prompt.endsWith('CONTEXT')).toBe(true);
  });
});
