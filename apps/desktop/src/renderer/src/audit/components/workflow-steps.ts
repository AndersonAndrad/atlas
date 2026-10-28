import type { ProjectWorkflowSummary } from '@atlas/contracts';

export type WorkflowTarget = 'analyze' | 'audits' | 'tasks';

export interface WorkflowStep {
  title: string;
  status: string;
  done: boolean;
  action: { label: string; target: WorkflowTarget } | null;
}

/** The five steps and which one comes next (PLAN-056). */
export function workflowSteps(summary: ProjectWorkflowSummary | null): {
  steps: WorkflowStep[];
  current: number;
} {
  const audited = summary?.latestAudit != null;
  const running =
    summary?.latestAudit?.status === 'QUEUED' || summary?.latestAudit?.status === 'RUNNING';
  const toReview = summary?.findingsToReview ?? 0;
  const openTasks = summary?.openTasks ?? 0;
  const teamsRunning = summary?.teamsRunning ?? 0;
  const teamsToReview = summary?.teamsToReview ?? 0;
  const steps: WorkflowStep[] = [
    {
      title: 'Analyze',
      status: running
        ? 'Audit running…'
        : audited
          ? `Last audit: ${summary!.latestAudit!.findingCount} finding(s)`
          : 'Find what to improve',
      done: audited && !running,
      action: running
        ? null
        : { label: audited ? 'Analyze again' : 'Analyze project', target: 'analyze' },
    },
    {
      title: 'Review findings',
      status: toReview > 0 ? `${toReview} to review` : audited ? 'All reviewed' : 'After the audit',
      done: audited && !running && toReview === 0,
      action: toReview > 0 ? { label: 'Review', target: 'audits' } : null,
    },
    {
      title: 'Tasks',
      status: `${openTasks} open task(s)`,
      done: openTasks > 0 || teamsRunning > 0 || teamsToReview > 0,
      action: openTasks > 0 ? { label: 'Open tasks', target: 'tasks' } : null,
    },
    {
      title: 'Execute with ATLAS',
      status: teamsRunning > 0 ? `${teamsRunning} team(s) working` : 'Pick a task and run its team',
      done: teamsToReview > 0,
      action:
        openTasks > 0 ? { label: teamsRunning > 0 ? 'Watch' : 'Execute', target: 'tasks' } : null,
    },
    {
      title: 'Review result',
      status: teamsToReview > 0 ? `${teamsToReview} result(s) to review` : 'When a team finishes',
      done: false,
      action: teamsToReview > 0 ? { label: 'Review', target: 'tasks' } : null,
    },
  ];
  let current = 2;
  if (!audited || running) current = 0;
  else if (toReview > 0) current = 1;
  else if (teamsToReview > 0) current = 4;
  else if (teamsRunning > 0 || openTasks > 0) current = 3;
  return { steps, current };
}
