import type {
  PreflightCheckResult,
  PreflightCheckStatus,
  PreflightRequiredOutcome,
  PreflightRunStatus,
} from '@atlas/contracts';

const FAILURES: readonly PreflightCheckStatus[] = ['FAILED', 'TIMED_OUT'];

function verdict(
  results: readonly Pick<PreflightCheckResult, 'status'>[],
): 'PASSED' | 'FAILED' | 'INCOMPLETE' {
  if (results.some((result) => FAILURES.includes(result.status))) return 'FAILED';
  if (results.every((result) => result.status === 'PASSED')) return 'PASSED';
  return 'INCOMPLETE';
}

/**
 * A finished run's state (FR-713). A run passes only when every check ran and passed:
 * a blocked, unsupported, skipped or cancelled check never counts as a pass.
 */
export function runStatus(
  results: readonly Pick<PreflightCheckResult, 'status'>[],
  cancelled: boolean,
): PreflightRunStatus {
  const result = verdict(results);
  if (cancelled && result !== 'FAILED') return 'CANCELLED';
  return result;
}

/** The same verdict over required checks only, for quality gates (Milestone B). */
export function requiredOutcome(
  results: readonly Pick<PreflightCheckResult, 'status' | 'required'>[],
): PreflightRequiredOutcome {
  const required = results.filter((result) => result.required);
  return required.length === 0 ? 'NONE' : verdict(required);
}

export function statusCounts(
  results: readonly Pick<PreflightCheckResult, 'status'>[],
): Partial<Record<PreflightCheckStatus, number>> {
  const counts: Partial<Record<PreflightCheckStatus, number>> = {};
  for (const { status } of results) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}
