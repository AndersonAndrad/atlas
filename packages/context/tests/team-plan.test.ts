import type { DecisionRecord, TeamProfileOption, TeamProviderOption } from '@atlas/contracts';
import {
  STAGE_OBJECTIVE_MAX,
  allocateProvider,
  assessTask,
  criteriaLines,
  filesInText,
  proposeStages,
  recommendRoles,
  stageObjective,
  teamRisks,
} from '@atlas/context';
import { describe, expect, it } from 'vitest';

const providers = (claude = 'wrapped', codex = 'wrapped'): TeamProviderOption[] =>
  [
    { provider: 'claude', availability: claude },
    { provider: 'codex', availability: codex },
  ] as TeamProviderOption[];

const profile = (overrides: Partial<TeamProfileOption>): TeamProfileOption => ({
  id: 'p',
  provider: 'claude',
  displayName: 'default',
  status: 'CONNECTED',
  plan: null,
  usedPercent: null,
  limited: false,
  ...overrides,
});

const assess = (title: string, objective: string, contextFiles: string[] = []) =>
  assessTask({ task: { title, objective }, contextFiles, decisions: [] });

describe('assessTask (SDD-026 Task 02 FR-002)', () => {
  it('rates a focused change as simple', () => {
    const assessment = assess('Fix typo in greeting', 'The greeting says "Helo".');
    expect(assessment.complexity).toBe('simple');
    expect(assessment.reasons).toEqual(['A focused change with no cross-cutting signals.']);
  });

  it('finds disciplines, files and criteria, and rates a cross-cutting task as complex', () => {
    const assessment = assess(
      'JWT authentication for the API and login page',
      [
        'Add JWT authentication to the API endpoints and a login form in the React UI.',
        '- Tokens expire after 15 minutes',
        '- Invalid tokens return 401',
        '- The login page shows errors',
        '- Tests cover expiry',
        'Touch src/server/auth.ts and web/pages/Login.tsx.',
      ].join('\n'),
    );
    expect(assessment.complexity).toBe('complex');
    const disciplines = assessment.disciplines.map((item) => item.discipline);
    expect(disciplines).toEqual(
      expect.arrayContaining(['backend', 'frontend', 'security', 'testing']),
    );
    expect(assessment.files).toEqual(['src/server/auth.ts', 'web/pages/Login.tsx']);
    expect(assessment.acceptanceCriteria).toHaveLength(4);
  });

  it('keeps only active decisions', () => {
    const decision = (id: string, status: DecisionRecord['status']) =>
      ({ id, question: 'q', decision: 'd', status }) as DecisionRecord;
    const assessment = assessTask({
      task: { title: 't', objective: 'o' },
      contextFiles: [],
      decisions: [decision('a', 'ACTIVE'), decision('b', 'SUPERSEDED')],
    });
    expect(assessment.decisions.map((item) => item.id)).toEqual(['a']);
  });

  it('reads paths and criteria safely', () => {
    expect(filesInText('see ../etc/passwd and /abs/x.ts and `src/a.ts`.')).toEqual(['src/a.ts']);
    expect(criteriaLines('1. one\n* two\n[ ] three\nplain\nGiven a user')).toEqual([
      'one',
      'two',
      'three',
      'Given a user',
    ]);
  });
});

describe('recommendRoles (FR-003)', () => {
  it('recommends one engineer for a simple task, a specialist for docs only', () => {
    expect(recommendRoles(assess('Fix typo', 'Wrong word.')).map((item) => item.role)).toEqual([
      'executor',
    ]);
    expect(
      recommendRoles(assess('Update README', 'Explain the install in the docs.')).map(
        (item) => item.role,
      ),
    ).toEqual(['docs']);
  });

  it('adds only the roles a complex task needs, in stage order, with reasons', () => {
    const roles = recommendRoles(
      assess(
        'JWT authentication for the API and login page',
        'API endpoints and a React login form; tests for expiry.\n- a\n- b\n- c\n- d',
      ),
    );
    expect(roles.map((item) => item.role)).toEqual([
      'architect',
      'backend',
      'frontend',
      'security',
      'qa',
    ]);
    expect(roles.every((item) => item.reason.length > 0)).toBe(true);
  });

  it('uses one engineer when only one side is involved', () => {
    const roles = recommendRoles(
      assess('Refactor the job service', 'Restructure the queue module; keep tests green.'),
    );
    expect(roles.map((item) => item.role)).toEqual(['architect', 'executor', 'qa']);
  });
});

describe('allocateProvider (FR-004)', () => {
  it('prefers Claude Code and the account with the lowest known use', () => {
    expect(
      allocateProvider(providers(), [
        profile({ id: 'a', usedPercent: 80 }),
        profile({ id: 'b', usedPercent: 20 }),
        profile({ id: 'c', usedPercent: 5, limited: true }),
      ]),
    ).toEqual({ provider: 'claude', profileId: 'b', substitution: null });
  });

  it('keeps the default account when no use is known, never inventing capacity', () => {
    expect(allocateProvider(providers(), [profile({ id: 'a' })]).profileId).toBeNull();
  });

  it('proposes another provider with an explanation, or none', () => {
    const substituted = allocateProvider(providers('missing'), []);
    expect(substituted.provider).toBe('codex');
    expect(substituted.substitution).toMatch(/Claude Code is not available/);
    expect(allocateProvider(providers('missing', 'missing'), []).provider).toBeNull();
  });

  it('lists the risks of the plan', () => {
    const assessment = assess('Fix auth token check', 'Validate the token.');
    const stages = proposeStages(assessment, providers('missing', 'missing'), []);
    const risks = teamRisks(assessment, stages, providers('missing', 'shadowed'));
    expect(risks.join(' ')).toMatch(/No AI provider is installed/);
    expect(risks.join(' ')).toMatch(/without the ATLAS wrapper/);
    expect(risks.join(' ')).toMatch(/no acceptance criteria/);
  });
});

describe('stageObjective (FR-008)', () => {
  const task = { title: 'Login', objective: 'Add a login form.' };
  const stages = [{ role: 'backend' as const }, { role: 'frontend' as const }];

  it('states the role, the team and the task', () => {
    const text = stageObjective({ task, stages, index: 0, previous: [] });
    expect(text).toContain('You are the Backend Engineer of an ATLAS team (stage 1 of 2');
    expect(text).toContain('Task: Login');
    expect(text).not.toContain('Handoff');
  });

  it('hands off what Git shows the earlier members changed, within the limit', () => {
    const text = stageObjective({
      task: { ...task, objective: 'x'.repeat(5000) },
      stages,
      index: 1,
      previous: [
        {
          role: 'backend',
          status: 'SUCCEEDED',
          changedFiles: Array.from({ length: 20 }, (_, n) => `src/f${n}.ts`),
          commits: [{ hash: 'abcdef1234', subject: 'feat: api' }],
        },
      ],
    });
    expect(text.length).toBeLessThanOrEqual(STAGE_OBJECTIVE_MAX);
    const short = stageObjective({
      task,
      stages,
      index: 1,
      previous: [
        {
          role: 'backend',
          status: 'SUCCEEDED',
          changedFiles: Array.from({ length: 20 }, (_, n) => `src/f${n}.ts`),
          commits: [{ hash: 'abcdef1234', subject: 'feat: api' }],
        },
      ],
    });
    expect(short).toContain('Handoff from the earlier members (from Git):');
    expect(short).toContain('abcdef12 feat: api');
    expect(short).toContain('src/f14.ts, …');
    expect(short).not.toContain('src/f15.ts');
  });
});
