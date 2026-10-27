import type { JobPriority, JobSettings } from '@atlas/contracts';

const PRIORITY_RANK: Record<JobPriority, number> = { HIGH: 0, NORMAL: 1, LOW: 2 };

export interface QueuedCandidate {
  id: string;
  priority: JobPriority;
  projectId: string | null;
  /** See `JobExecutor.resourceKey`. */
  resource: string | null;
  /** See `JobExecutor.isReady`. */
  ready: boolean;
  /** See `JobExecutor.exemptFromLimits`; absent means limited. */
  exempt?: boolean;
}

export interface RunningSlot {
  projectId: string | null;
  resource: string | null;
  exempt?: boolean;
}

/**
 * The queued jobs to start now (FR-1205, FR-1206), given in queue order (oldest first).
 * Higher priorities go first and equal ones keep their order. A job that cannot start
 * yet (its project is at its limit, its resource is busy or it is not ready) is passed
 * over, so it never blocks jobs of other projects.
 */
export function selectJobsToStart(
  queued: readonly QueuedCandidate[],
  running: readonly RunningSlot[],
  limits: JobSettings,
): string[] {
  let total = running.length;
  const perProject = new Map<string, number>();
  const resources = new Set<string>();
  for (const slot of running) {
    if (slot.resource !== null) resources.add(slot.resource);
    // Exempt jobs neither count toward nor wait for the limits.
    if (slot.exempt) {
      total -= 1;
      continue;
    }
    if (slot.projectId !== null) {
      perProject.set(slot.projectId, (perProject.get(slot.projectId) ?? 0) + 1);
    }
  }
  const ordered = [...queued].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const selected: string[] = [];
  for (const job of ordered) {
    if (!job.ready) continue;
    if (job.resource !== null && resources.has(job.resource)) continue;
    if (job.exempt) {
      selected.push(job.id);
      if (job.resource !== null) resources.add(job.resource);
      continue;
    }
    if (total >= limits.maxConcurrentJobs) continue;
    const projectCount = job.projectId === null ? 0 : (perProject.get(job.projectId) ?? 0);
    if (job.projectId !== null && projectCount >= limits.maxJobsPerProject) continue;
    selected.push(job.id);
    total += 1;
    if (job.projectId !== null) perProject.set(job.projectId, projectCount + 1);
    if (job.resource !== null) resources.add(job.resource);
  }
  return selected;
}
