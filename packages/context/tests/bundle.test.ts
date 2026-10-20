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
