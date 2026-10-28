import type { AuditDecisionView, ProjectWorkflowSummary } from '@atlas/contracts';
import { describe, expect, it } from 'vitest';
import { findingState } from '../src/renderer/src/audit/components/review-state';
import { workflowSteps } from '../src/renderer/src/audit/components/workflow-steps';

const summary = (overrides: Partial<ProjectWorkflowSummary> = {}): ProjectWorkflowSummary => ({
  projectId: 'p',
  latestAudit: { id: 'a', status: 'COMPLETED', findingCount: 3, createdAt: 'x' },
  findingsToReview: 0,
  openTasks: 0,
  teamsRunning: 0,
  teamsToReview: 0,
  ...overrides,
});

describe('workflowSteps (PLAN-056)', () => {
  it('starts with Analyze before the first audit and while one runs', () => {
    expect(workflowSteps(null).current).toBe(0);
    expect(workflowSteps(summary({ latestAudit: null })).steps[0]?.action?.label).toBe(
      'Analyze project',
    );
    const running = workflowSteps(
      summary({ latestAudit: { id: 'a', status: 'RUNNING', findingCount: 0, createdAt: 'x' } }),
    );
    expect(running.current).toBe(0);
    expect(running.steps[0]?.action).toBeNull();
  });

  it('points at the next thing to do', () => {
    expect(workflowSteps(summary({ findingsToReview: 2 })).current).toBe(1);
    expect(workflowSteps(summary({ openTasks: 1 })).current).toBe(3);
    expect(workflowSteps(summary({ openTasks: 1, teamsRunning: 1 })).steps[3]?.status).toBe(
      '1 team(s) working',
    );
    expect(workflowSteps(summary({ openTasks: 1, teamsToReview: 1 })).current).toBe(4);
    expect(workflowSteps(summary()).current).toBe(2);
  });
});

describe('findingState (SDD-026 Task 01 Milestone B)', () => {
  const view = (overrides: Partial<AuditDecisionView>): AuditDecisionView => ({
    projectId: 'p',
    fingerprint: 'f',
    decision: 'APPROVED',
    note: null,
    taskId: 't',
    auditId: 'a',
    findingId: 'x',
    decidedAt: 'x',
    task: { id: 't', title: 'T', status: 'open' },
    ...overrides,
  });

  it('maps remembered decisions to what the review shows', () => {
    expect(findingState(undefined)).toBe('to-review');
    expect(findingState(view({}))).toBe('has-task');
    expect(findingState(view({ task: { id: 't', title: 'T', status: 'done' } }))).toBe('resolved');
    expect(findingState(view({ task: null, taskId: null }))).toBe('to-review');
    expect(findingState(view({ decision: 'REJECTED', task: null }))).toBe('rejected');
    expect(findingState(view({ decision: 'DEFERRED', task: null }))).toBe('deferred');
    expect(findingState(view({ decision: 'NEEDS_REVIEW', task: null }))).toBe('to-review');
  });
});
