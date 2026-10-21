import type { GitPreCommitStepResult, PreCommitStep } from '@atlas/contracts';
import { GitOperationFailure, type GitOperationContext } from './coordinator.js';
import { GitCommandError } from './runner.js';
import { redactCredentials, sanitizeGitOutput } from './sanitize.js';

export interface PreCommitStepOutcome {
  status: 'passed' | 'failed' | 'cancelled';
  exitCode: number | null;
  /** Short reason, e.g. "exited with code 1" or "kept running for 15 s". */
  detail: string;
  /** Tail of the combined output. May contain secrets: sanitize before exposing. */
  output: string;
  durationMs: number;
}

/** Runs one configured command. Implemented by the Engine with the user's shell. */
export interface PreCommitStepRunner {
  run(
    step: PreCommitStep,
    options: {
      cwd: string;
      signal: AbortSignal;
      /** Environment for this commit (a fresh shell's); the runner's default otherwise. */
      env?: Record<string, string> | undefined;
    },
  ): Promise<PreCommitStepOutcome>;
}

/** What a commit from ATLAS must satisfy, resolved by the Engine from stored settings. */
export interface CommitChecks {
  enforceConventionalCommits: boolean;
  steps: readonly PreCommitStep[];
  /** Directory the steps run in (the project directory). */
  cwd: string;
}

export const DEFAULT_COMMIT_CHECKS = (cwd: string): CommitChecks => ({
  enforceConventionalCommits: true,
  steps: [],
  cwd,
});

/**
 * Runs the steps in order and stops at the first one that does not pass.
 * Progress, durations and failed output are published on the operation.
 */
export async function runPreCommitSteps(
  checks: CommitChecks,
  runner: PreCommitStepRunner,
  context: GitOperationContext,
  env?: Record<string, string>,
): Promise<void> {
  const results: GitPreCommitStepResult[] = checks.steps.map((step) => ({
    name: redactCredentials(step.name),
    command: redactCredentials(step.command),
    mode: step.mode,
    status: 'pending',
    durationMs: null,
    exitCode: null,
    detail: null,
    output: null,
  }));
  context.setSteps(results);
  for (const [index, step] of checks.steps.entries()) {
    results[index] = { ...results[index]!, status: 'running' };
    context.setSteps(results);
    const outcome = context.signal.aborted
      ? ({
          status: 'cancelled',
          exitCode: null,
          detail: 'cancelled',
          output: '',
          durationMs: 0,
        } as const)
      : await runner.run(step, { cwd: checks.cwd, signal: context.signal, env });
    results[index] = {
      ...results[index]!,
      status: outcome.status,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      detail: redactCredentials(outcome.detail),
      output: outcome.status === 'passed' ? null : sanitizeGitOutput(outcome.output),
    };
    if (outcome.status !== 'passed') {
      for (let rest = index + 1; rest < results.length; rest += 1) {
        results[rest] = { ...results[rest]!, status: 'skipped' };
      }
      context.setSteps(results);
      if (outcome.status === 'cancelled') {
        throw new GitCommandError('cancelled', 'pre-commit step cancelled');
      }
      throw new GitOperationFailure(
        'check-failed',
        `The step "${results[index]!.name}" failed (${results[index]!.detail}). Nothing was committed.`,
        results[index]!.output,
      );
    }
    context.setSteps(results);
  }
}
