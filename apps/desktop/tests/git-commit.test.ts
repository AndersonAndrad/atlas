import type { GitOperation, GitOperationKind, PreCommitStep } from '@atlas/contracts';
import { describe, expect, it } from 'vitest';
import {
  NEW_STEP,
  fromDraft,
  savedDrafts,
  toDraft,
  waitsForReadyText,
} from '../src/renderer/src/git/commit-steps';
import { commitSubmission, submittedCommit } from '../src/renderer/src/git/format';
import { createSaveQueue } from '../src/renderer/src/git/save-queue';

const operation = (id: string, kind: GitOperationKind, startedAt: string): GitOperation => ({
  id,
  kind,
  repositoryRoot: '/repo',
  status: 'running',
  startedAt,
  finishedAt: null,
  progress: null,
  summary: null,
  error: null,
  cancellable: true,
  steps: null,
});

/** A promise settled from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('createSaveQueue', () => {
  it('runs saves one at a time, in the order they were requested', async () => {
    const queue = createSaveQueue();
    const first = deferred<string>();
    const started: string[] = [];
    const a = queue.enqueue(() => {
      started.push('a');
      return first.promise;
    });
    const b = queue.enqueue(async () => {
      started.push('b');
      return 'b';
    });
    await Promise.resolve();
    expect(started).toEqual(['a']);
    first.resolve('a');
    await expect(a.result).resolves.toBe('a');
    await expect(b.result).resolves.toBe('b');
    expect(started).toEqual(['a', 'b']);
  });

  it('keeps running later saves after one failed', async () => {
    const queue = createSaveQueue();
    const failed = queue.enqueue(() => Promise.reject(new Error('locked')));
    const next = queue.enqueue(async () => 'stored');
    await expect(failed.result).rejects.toThrow('locked');
    await expect(next.result).resolves.toBe('stored');
  });

  it('treats only the latest requested save as current', async () => {
    const queue = createSaveQueue();
    const older = queue.enqueue(async () => 1);
    expect(queue.isLatest(older.ticket)).toBe(true);
    const newer = queue.enqueue(async () => 2);
    // An older save that settles after a newer request never counts as the latest.
    await older.result;
    expect(queue.isLatest(older.ticket)).toBe(false);
    expect(queue.isLatest(newer.ticket)).toBe(true);
  });
});

describe('submittedCommit', () => {
  const at = Date.parse('2026-10-20T10:00:00.000Z');

  it('ignores everything until a commit was submitted', () => {
    expect(submittedCommit([operation('c1', 'commit', '2026-10-20T10:00:01.000Z')], null)).toBe(
      undefined,
    );
  });

  it('matches the first new commit started after the submission', () => {
    const submission = commitSubmission([operation('old', 'commit', '2026-10-20T09:00:00Z')], at);
    // Newest first, as the operations hook returns them.
    const operations = [
      operation('later', 'commit', '2026-10-20T10:00:05.000Z'),
      operation('push', 'push', '2026-10-20T10:00:03.000Z'),
      operation('mine', 'commit', '2026-10-20T10:00:01.000Z'),
      operation('old', 'commit', '2026-10-20T09:00:00.000Z'),
    ];
    expect(submittedCommit(operations, submission)?.id).toBe('mine');
  });

  it('never takes a known or older commit that arrives late for the submitted one', () => {
    const submission = commitSubmission([operation('known', 'commit', '2026-10-20T10:00:02Z')], at);
    expect(
      submittedCommit(
        [
          operation('known', 'commit', '2026-10-20T10:00:02.000Z'),
          operation('late', 'commit', '2026-10-20T09:59:59.000Z'),
        ],
        submission,
      ),
    ).toBe(undefined);
  });
});

describe('start steps with a ready text', () => {
  const start = (readyText: string, readyAfterSeconds: string) => ({
    ...toDraft({ ...NEW_STEP, name: 'Server', command: 'npm start', mode: 'start' }),
    readyText,
    readyAfterSeconds,
  });

  it('waits for the ready text only when one is set on a start step', () => {
    expect(waitsForReadyText(start('listening on', '15'))).toBe(true);
    expect(waitsForReadyText(start('  ', '15'))).toBe(false);
    expect(waitsForReadyText({ mode: 'complete', readyText: 'listening on' })).toBe(false);
  });

  it('replaces an unusable keep-running duration only while it is unused', () => {
    expect(fromDraft(start('listening on', '1')).readyAfterSeconds).toBe(
      NEW_STEP.readyAfterSeconds,
    );
    expect(fromDraft(start('listening on', '')).readyAfterSeconds).toBe(NEW_STEP.readyAfterSeconds);
    expect(fromDraft(start('listening on', '30')).readyAfterSeconds).toBe(30);
    // Without a ready text the duration is used, so it is validated as entered.
    expect(fromDraft(start('', '1')).readyAfterSeconds).toBe(1);
  });
});

describe('savedDrafts', () => {
  const steps: PreCommitStep[] = [
    { ...NEW_STEP, name: 'Tests', command: 'npm test' },
    { ...NEW_STEP, name: 'Lint', command: 'npm run lint' },
  ];

  it('keeps the form keys when the saved steps are the submitted ones', () => {
    const submitted = steps.map(toDraft);
    const drafts = savedDrafts(structuredClone(steps), steps, submitted);
    expect(drafts.map((draft) => draft.key)).toEqual(submitted.map((draft) => draft.key));
    expect(drafts.map(fromDraft)).toEqual(steps);
  });

  it('gives new keys when the stored steps differ from the submitted ones', () => {
    const submitted = steps.map(toDraft);
    const stored = [steps[1]!, steps[0]!];
    const drafts = savedDrafts(stored, steps, submitted);
    expect(drafts.map(fromDraft)).toEqual(stored);
    for (const draft of drafts) {
      expect(submitted.map((step) => step.key)).not.toContain(draft.key);
    }
    expect(savedDrafts(steps.slice(0, 1), steps, submitted)).toHaveLength(1);
  });
});
