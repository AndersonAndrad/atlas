import { describe, expect, it } from 'vitest';
import {
  hasPendingReview,
  terminalIndicator,
  type TerminalActivity,
  type TerminalActivitySummary,
} from '@atlas/contracts';
import { TerminalActivityService, type TerminalActivityStore } from '../src/index.js';

const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-000000000002';

class MemoryStore implements TerminalActivityStore {
  rows = new Map<string, TerminalActivity>();
  terminals = new Set([T1, T2]);
  async list() {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
  async upsert(activity: TerminalActivity) {
    if (!this.terminals.has(activity.terminalId)) return false;
    this.rows.set(`${activity.terminalId}:${activity.ref}`, { ...activity });
    return true;
  }
  async pruneAcknowledged(terminalId: string, keepRef: string) {
    for (const [id, row] of this.rows) {
      if (row.terminalId === terminalId && row.acknowledgedAt !== null && row.ref !== keepRef) {
        this.rows.delete(id);
      }
    }
  }
}

function setup(store = new MemoryStore()) {
  let clock = Date.parse('2026-10-27T12:00:00.000Z');
  const changes: TerminalActivitySummary[] = [];
  const service = new TerminalActivityService({
    store,
    now: () => new Date((clock += 1000)),
    onChange: (summary) => changes.push(summary),
  });
  const ai = (run: string, terminalId = T1) => ({ terminalId, provider: 'claude' as const, run });
  return { store, service, changes, ai };
}

describe('terminal tab indicator (SDD-023 A02)', () => {
  const summary = (...states: TerminalActivity['state'][]): TerminalActivitySummary => ({
    terminalId: T1,
    activities: states.map((state, index) => ({
      terminalId: T1,
      kind: 'ai',
      provider: 'claude',
      ref: `r${index}`,
      state,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      acknowledgedAt: null,
      contextSessionId: null,
    })),
    reviewed: null,
  });

  it('applies the documented precedence', () => {
    expect(terminalIndicator('RUNNING', undefined)).toBe('IDLE');
    expect(terminalIndicator('STARTING', undefined)).toBe('IDLE');
    expect(terminalIndicator('RUNNING', summary('RUNNING'))).toBe('AI_RUNNING');
    expect(terminalIndicator('RUNNING', summary('RUNNING', 'ATTENTION_REQUIRED'))).toBe(
      'ATTENTION_REQUIRED',
    );
    expect(terminalIndicator('RUNNING', summary('INTERRUPTED'))).toBe('ATTENTION_REQUIRED');
    expect(terminalIndicator('RUNNING', summary('ATTENTION_REQUIRED', 'FAILED', 'RUNNING'))).toBe(
      'FAILED',
    );
    expect(terminalIndicator('EXITED', summary('FAILED'))).toBe('DISCONNECTED');
    expect(terminalIndicator('TERMINATED', undefined)).toBe('DISCONNECTED');
  });

  it('is green only after an explicit review, and reports results pending on ended terminals', () => {
    const reviewed = { ...summary(), reviewed: summary('ATTENTION_REQUIRED').activities[0]! };
    expect(terminalIndicator('RUNNING', reviewed)).toBe('REVIEWED');
    expect(hasPendingReview(summary('RUNNING'))).toBe(false);
    expect(hasPendingReview(summary('RUNNING', 'FAILED'))).toBe(true);
  });
});

describe('TerminalActivityService', () => {
  it('follows an AI run from start to review', async () => {
    const { service, changes, ai } = setup();
    await service.aiStarted(ai('run-1'));
    expect(terminalIndicator('RUNNING', service.summary(T1))).toBe('AI_RUNNING');
    await service.aiEnded({ ...ai('run-1'), exitCode: 0 });
    const done = service.summary(T1);
    expect(done.activities[0]).toMatchObject({ state: 'ATTENTION_REQUIRED', exitCode: 0 });
    expect(terminalIndicator('RUNNING', done)).toBe('ATTENTION_REQUIRED');
    // Never reviewed by itself.
    expect(done.activities[0]?.acknowledgedAt).toBeNull();

    const reviewed = await service.markReviewed(T1);
    expect(reviewed.activities).toEqual([]);
    expect(reviewed.reviewed?.ref).toBe('run-1');
    expect(terminalIndicator('RUNNING', reviewed)).toBe('REVIEWED');
    expect(changes.map((change) => change.activities.map((item) => item.state))).toEqual([
      ['RUNNING'],
      ['ATTENTION_REQUIRED'],
      [],
    ]);
  });

  it('marks a failing run as failed, also without an exit code', async () => {
    const { service, ai } = setup();
    await service.aiStarted(ai('a'));
    await service.aiEnded({ ...ai('a'), exitCode: 2 });
    await service.aiEnded({ ...ai('b'), exitCode: null });
    expect(service.summary(T1).activities.map((item) => item.state)).toEqual(['FAILED', 'FAILED']);
  });

  it('keeps each run separate on one terminal and ignores stale events', async () => {
    const { service, store, ai } = setup();
    await service.aiStarted(ai('first'));
    await service.aiStarted(ai('second'));
    await service.aiEnded({ ...ai('first'), exitCode: 0 });
    // The second run is still running; reviewing leaves it alone.
    await service.markReviewed(T1);
    expect(service.summary(T1).activities).toEqual([
      expect.objectContaining({ ref: 'second', state: 'RUNNING' }),
    ]);
    expect(terminalIndicator('RUNNING', service.summary(T1))).toBe('AI_RUNNING');
    // A late start or a repeated end of a finished run changes nothing.
    await service.aiStarted(ai('first'));
    await service.aiEnded({ ...ai('first'), exitCode: 1 });
    // `reviewed` is only shown when nothing newer exists; the stored result is unchanged.
    expect(service.summary(T1).reviewed).toBeNull();
    expect(store.rows.get(`${T1}:first`)).toMatchObject({
      exitCode: 0,
      state: 'ATTENTION_REQUIRED',
    });
    expect(store.rows.get(`${T1}:first`)?.acknowledgedAt).not.toBeNull();
    // Events of other terminals stay there.
    await service.aiStarted(ai('other', T2));
    expect(service.summary(T1).activities).toHaveLength(1);
  });

  it('interrupts what was running when the terminal ends, and keeps it pending', async () => {
    const { service, ai } = setup();
    await service.aiStarted(ai('run'));
    await service.terminalEnded(T1);
    const summary = service.summary(T1);
    expect(summary.activities[0]).toMatchObject({ state: 'INTERRUPTED' });
    expect(terminalIndicator('EXITED', summary)).toBe('DISCONNECTED');
    expect(hasPendingReview(summary)).toBe(true);
    // The end reported after the terminal ended does not resurrect it.
    await service.aiEnded({ ...ai('run'), exitCode: 0 });
    expect(service.summary(T1).activities[0]?.state).toBe('INTERRUPTED');
  });

  it('restores pending results after a restart and never trusts a stored RUNNING', async () => {
    const first = setup();
    await first.service.aiStarted(first.ai('done'));
    await first.service.aiEnded({ ...first.ai('done'), exitCode: 0 });
    await first.service.aiStarted(first.ai('alive'));

    const second = setup(first.store);
    await second.service.load();
    expect(second.service.summary(T1).activities.map((item) => [item.ref, item.state])).toEqual([
      ['done', 'ATTENTION_REQUIRED'],
      ['alive', 'INTERRUPTED'],
    ]);
    expect(first.store.rows.get(`${T1}:alive`)?.state).toBe('INTERRUPTED');
  });

  it('ignores terminals unknown to the store and forgets removed ones', async () => {
    const { service, ai } = setup();
    await service.aiStarted(ai('x', '00000000-0000-4000-8000-0000000000ff'));
    expect(service.summaries()).toEqual([]);
    await service.aiStarted(ai('y'));
    service.terminalRemoved(T1);
    expect(service.summaries()).toEqual([]);
  });

  it('keeps only the latest reviewed result', async () => {
    const { service, store, ai } = setup();
    await service.aiEnded({ ...ai('one'), exitCode: 0 });
    await service.markReviewed(T1);
    await service.aiEnded({ ...ai('two'), exitCode: 0 });
    await service.markReviewed(T1);
    expect([...store.rows.values()].map((row) => row.ref)).toEqual(['two']);
  });
});
