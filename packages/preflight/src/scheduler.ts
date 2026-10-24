import type { PreflightCheckStatus } from '@atlas/contracts';

export interface ScheduledCheck {
  position: number;
  id: string;
  /** Ids of checks of the same run that must pass first; other ids are ignored. */
  dependsOn: readonly string[];
  exclusive: boolean;
}

export interface ScheduleCallbacks {
  /** Runs one check and returns its final status. Must not throw. */
  execute(position: number): Promise<PreflightCheckStatus>;
  /** A check that will not run: a dependency did not pass, or the run was cancelled. */
  skip(position: number, status: 'SKIPPED' | 'CANCELLED', reason: string): void;
}

/**
 * Runs checks in order, at most `concurrency` at a time (FR-715). A check starts once
 * the checks it depends on finished; it is skipped when one of them did not pass. An
 * exclusive check runs alone. After `signal` aborts nothing new starts and the waiting
 * checks are cancelled; running ones are stopped by their own executor.
 */
export async function runSchedule(
  checks: readonly ScheduledCheck[],
  concurrency: number,
  signal: AbortSignal,
  callbacks: ScheduleCallbacks,
): Promise<void> {
  const ids = new Set(checks.map((check) => check.id));
  const finished = new Map<string, PreflightCheckStatus>();
  const waiting = [...checks];
  const running = new Map<number, { exclusive: boolean; done: Promise<void> }>();

  const dependencies = (check: ScheduledCheck) =>
    check.dependsOn.filter((dependency) => ids.has(dependency) && dependency !== check.id);

  while (waiting.length > 0 || running.size > 0) {
    if (signal.aborted) {
      for (const check of waiting.splice(0)) {
        callbacks.skip(check.position, 'CANCELLED', 'The run was cancelled.');
        finished.set(check.id, 'CANCELLED');
      }
    }
    let progressed = false;
    for (let index = 0; index < waiting.length;) {
      const check = waiting[index]!;
      const pending = dependencies(check).filter((dependency) => !finished.has(dependency));
      const failed = dependencies(check).filter(
        (dependency) => finished.has(dependency) && finished.get(dependency) !== 'PASSED',
      );
      if (pending.length === 0 && failed.length > 0) {
        waiting.splice(index, 1);
        callbacks.skip(
          check.position,
          'SKIPPED',
          `Depends on ${failed.join(', ')}, which did not pass.`,
        );
        finished.set(check.id, 'SKIPPED');
        progressed = true;
        continue;
      }
      const busyExclusive = [...running.values()].some((entry) => entry.exclusive);
      const canStart =
        pending.length === 0 &&
        !busyExclusive &&
        running.size < concurrency &&
        (!check.exclusive || running.size === 0);
      if (!canStart) {
        index += 1;
        // Keep the configured order for checks that are ready: a later check never
        // overtakes an earlier exclusive one that waits for the others to finish.
        if (pending.length === 0) break;
        continue;
      }
      waiting.splice(index, 1);
      const done = callbacks
        .execute(check.position)
        .catch((): PreflightCheckStatus => 'FAILED')
        .then((status) => {
          finished.set(check.id, status);
          running.delete(check.position);
        });
      running.set(check.position, { exclusive: check.exclusive, done });
      progressed = true;
    }
    if (running.size > 0) {
      await Promise.race([...running.values()].map((entry) => entry.done));
    } else if (!progressed && waiting.length > 0) {
      // Unreachable with a validated configuration (no cycles); never loop forever.
      for (const check of waiting.splice(0)) {
        callbacks.skip(check.position, 'SKIPPED', 'Its dependencies could not be resolved.');
        finished.set(check.id, 'SKIPPED');
      }
    }
  }
}
