import { SESSION_STATUSES, type AtlasSessionStatus } from '@atlas/contracts';
import { describe, expect, it } from 'vitest';
import {
  availableSessionActions,
  canTransitionTask,
  nextSessionStatus,
  tasksEditable,
  type SessionTrigger,
} from '../src/index.js';

const NO_EXECUTOR = { executorAvailable: false };
const EXECUTOR = { executorAvailable: true };

const TRIGGERS: SessionTrigger[] = [
  'markReady',
  'returnToDraft',
  'start',
  'pause',
  'resume',
  'cancel',
  'run',
  'requestApproval',
  'approve',
  'complete',
  'fail',
  'interrupt',
];

/** Every allowed transition without an executor; anything else must be rejected. */
const ALLOWED: Record<AtlasSessionStatus, Partial<Record<SessionTrigger, AtlasSessionStatus>>> = {
  DRAFT: { markReady: 'READY', cancel: 'CANCELLED' },
  READY: { returnToDraft: 'DRAFT', start: 'WAITING_EXECUTOR', cancel: 'CANCELLED' },
  WAITING_EXECUTOR: { pause: 'PAUSED', cancel: 'CANCELLED', run: 'RUNNING' },
  RUNNING: {
    pause: 'PAUSED',
    requestApproval: 'WAITING_APPROVAL',
    complete: 'COMPLETED',
    fail: 'FAILED',
    cancel: 'CANCELLED',
    interrupt: 'INTERRUPTED',
  },
  WAITING_APPROVAL: {
    approve: 'RUNNING',
    fail: 'FAILED',
    cancel: 'CANCELLED',
    interrupt: 'INTERRUPTED',
  },
  PAUSED: { resume: 'WAITING_EXECUTOR', cancel: 'CANCELLED' },
  INTERRUPTED: { resume: 'WAITING_EXECUTOR', cancel: 'CANCELLED' },
  COMPLETED: {},
  FAILED: {},
  CANCELLED: {},
};

describe('session state machine', () => {
  it('accepts exactly the defined transitions', () => {
    for (const status of SESSION_STATUSES) {
      for (const trigger of TRIGGERS) {
        expect(nextSessionStatus(status, trigger, NO_EXECUTOR), `${status} --${trigger}`).toBe(
          ALLOWED[status][trigger] ?? null,
        );
      }
    }
  });

  it('waits for an executor instead of pretending to run', () => {
    expect(nextSessionStatus('READY', 'start', NO_EXECUTOR)).toBe('WAITING_EXECUTOR');
    expect(nextSessionStatus('PAUSED', 'resume', NO_EXECUTOR)).toBe('WAITING_EXECUTOR');
    expect(nextSessionStatus('READY', 'start', EXECUTOR)).toBe('RUNNING');
    expect(nextSessionStatus('INTERRUPTED', 'resume', EXECUTOR)).toBe('RUNNING');
  });

  it('never completes an interrupted, waiting or cancelled session', () => {
    for (const status of ['INTERRUPTED', 'WAITING_EXECUTOR', 'PAUSED', 'CANCELLED'] as const) {
      expect(nextSessionStatus(status, 'complete', EXECUTOR)).toBeNull();
    }
    expect(nextSessionStatus('DRAFT', 'start', EXECUTOR)).toBeNull();
  });

  it('lists user actions per status, archiving only finished sessions', () => {
    expect(availableSessionActions('DRAFT', false, NO_EXECUTOR)).toEqual(['markReady', 'cancel']);
    expect(availableSessionActions('READY', false, NO_EXECUTOR)).toEqual([
      'returnToDraft',
      'start',
      'cancel',
    ]);
    expect(availableSessionActions('WAITING_EXECUTOR', false, NO_EXECUTOR)).toEqual([
      'pause',
      'cancel',
    ]);
    expect(availableSessionActions('INTERRUPTED', false, NO_EXECUTOR)).toEqual([
      'resume',
      'cancel',
    ]);
    expect(availableSessionActions('CANCELLED', false, NO_EXECUTOR)).toEqual(['archive']);
    expect(availableSessionActions('CANCELLED', true, NO_EXECUTOR)).toEqual([]);
    // Executor-only triggers are never offered to users.
    expect(availableSessionActions('RUNNING', false, EXECUTOR)).toEqual(['pause', 'cancel']);
  });

  it('allows task planning until the session ends', () => {
    expect(tasksEditable('DRAFT', false)).toBe(true);
    expect(tasksEditable('WAITING_EXECUTOR', false)).toBe(true);
    expect(tasksEditable('COMPLETED', false)).toBe(false);
    expect(tasksEditable('CANCELLED', false)).toBe(false);
  });

  it('validates task transitions', () => {
    expect(canTransitionTask('PENDING', 'IN_PROGRESS')).toBe(true);
    expect(canTransitionTask('PENDING', 'COMPLETED')).toBe(false);
    expect(canTransitionTask('IN_PROGRESS', 'INTERRUPTED')).toBe(true);
    expect(canTransitionTask('COMPLETED', 'PENDING')).toBe(false);
    expect(canTransitionTask('CANCELLED', 'PENDING')).toBe(false);
  });
});
