import type { GitFileChange, GitFileChangeKind } from '@atlas/contracts';
import { ProjectGitSettingsSchema } from '@atlas/contracts';
import { describe, expect, it } from 'vitest';
import {
  NEW_STEP,
  fromDraft,
  moveStep,
  stepIssueMessage,
  toDraft,
} from '../src/renderer/src/git/commit-steps';
import { nextToReview, plural, reviewProgress } from '../src/renderer/src/git/format';

const change = (
  path: string,
  staged: GitFileChangeKind | null,
  unstaged: GitFileChangeKind | null,
): GitFileChange => ({
  path,
  originalPath: null,
  staged,
  unstaged,
  stagedStats: null,
  unstagedStats: null,
});

describe('reviewProgress', () => {
  it('counts fully staged files as reviewed and excludes conflicts', () => {
    expect(
      reviewProgress([
        change('a.ts', 'modified', null),
        change('b.ts', 'modified', 'modified'),
        change('c.ts', null, 'untracked'),
        change('d.ts', 'conflicted', 'conflicted'),
      ]),
    ).toEqual({ reviewed: 1, total: 3 });
  });

  it('is empty without files', () => {
    expect(reviewProgress([])).toEqual({ reviewed: 0, total: 0 });
  });
});

describe('nextToReview', () => {
  const files = [
    change('a.ts', null, 'modified'),
    change('b.ts', 'modified', null),
    change('c.ts', 'conflicted', 'conflicted'),
    change('d.ts', null, 'untracked'),
  ];

  it('returns the next file with unstaged changes after the current one', () => {
    expect(nextToReview(files, 'a.ts')).toBe('d.ts');
  });

  it('wraps around to the first pending file', () => {
    expect(nextToReview(files, 'd.ts')).toBe('a.ts');
  });

  it('skips staged-only and conflicted files', () => {
    expect(nextToReview(files, 'b.ts')).toBe('d.ts');
  });

  it('returns null when the current file is the only one left', () => {
    expect(nextToReview([change('a.ts', null, 'modified')], 'a.ts')).toBeNull();
  });

  it('returns null when nothing is left to review', () => {
    expect(nextToReview([change('a.ts', 'modified', null)], 'a.ts')).toBeNull();
  });

  it('starts from the first pending file when the path is unknown', () => {
    expect(nextToReview(files, 'missing.ts')).toBe('a.ts');
  });
});

describe('plural', () => {
  it('adds an s except for one', () => {
    expect(plural(0, 'file')).toBe('0 files');
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(2, 'commit')).toBe('2 commits');
  });
});

describe('commit step drafts', () => {
  it('gives every draft a distinct key that is not saved', () => {
    const first = toDraft(NEW_STEP);
    const second = toDraft(NEW_STEP);
    expect(first.key).not.toBe(second.key);
    expect(fromDraft(first)).toEqual(NEW_STEP);
    expect(fromDraft(first)).not.toHaveProperty('key');
  });

  it('moves a step by key and ignores moves past either end', () => {
    const steps = ['a', 'b', 'c'].map((name) => toDraft({ ...NEW_STEP, name }));
    const names = (list: typeof steps) => list.map((step) => step.name);
    expect(names(moveStep(steps, steps[0]!.key, 1))).toEqual(['b', 'a', 'c']);
    expect(names(moveStep(steps, steps[2]!.key, -1))).toEqual(['a', 'c', 'b']);
    expect(moveStep(steps, steps[0]!.key, -1)).toBe(steps);
    expect(moveStep(steps, steps[2]!.key, 1)).toBe(steps);
    expect(moveStep(steps, 'unknown', 1)).toBe(steps);
  });

  it('names invalid fields by their visible labels', () => {
    const steps = [
      toDraft({ ...NEW_STEP, name: 'Tests', command: 'npm test' }),
      toDraft({ ...NEW_STEP, name: 'Server', command: 'npm start', mode: 'start' }),
    ];
    steps[1]!.timeoutSeconds = '1';
    const parsed = ProjectGitSettingsSchema.safeParse({
      enforceConventionalCommits: true,
      preCommitSteps: steps.map(fromDraft),
    });
    expect(parsed.success).toBe(false);
    const message = stepIssueMessage(parsed.error!.issues[0]!, steps);
    expect(message).toMatch(/^Step 2 — Ready text timeout \(s\): /);
    expect(message).not.toContain('timeoutSeconds');
  });

  it('labels each field as shown in the form', () => {
    const complete = [{ mode: 'complete' as const }];
    const issue = (field: string) => ({ path: ['preCommitSteps', 0, field], message: 'Bad.' });
    expect(stepIssueMessage(issue('name'), complete)).toBe('Step 1 — Name: Bad.');
    expect(stepIssueMessage(issue('command'), complete)).toBe('Step 1 — Command: Bad.');
    expect(stepIssueMessage(issue('timeoutSeconds'), complete)).toBe('Step 1 — Timeout (s): Bad.');
    expect(stepIssueMessage(issue('readyAfterSeconds'), complete)).toBe(
      'Step 1 — Must keep running (s): Bad.',
    );
    expect(stepIssueMessage({ path: ['preCommitSteps'], message: 'Up to 5 steps.' }, [])).toBe(
      'Up to 5 steps.',
    );
  });
});
