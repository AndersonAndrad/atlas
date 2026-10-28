import {
  ACTIVE_TEAM_EXECUTION_STATUSES,
  TEAM_ROLE_LABELS,
  type ContextTarget,
  type TeamContinueAction,
  type TeamExecution,
  type TeamExecutionStatus,
  type TeamPauseReason,
  type TeamPreflightResult,
  type TeamStageStatus,
} from '@atlas/contracts';
import { useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { onTerminalLifecycle } from '@/terminal/state/terminal-events';
import { formatDateTime } from '../format';
import { useKeyedLoad } from '../hooks/useContextData';
import { PROVIDER_NAMES } from './ExecuteTaskDialog';

const TEAM_STATUS: Record<TeamExecutionStatus, string> = {
  RUNNING: 'Team running',
  PAUSED: 'Team paused',
  CHECKING: 'Running Preflight',
  REVIEW_REQUIRED: 'Team finished · review required',
  CANCELLED: 'Team cancelled',
};

const STAGE_STATUS: Record<TeamStageStatus, string> = {
  PENDING: 'waiting',
  RUNNING: 'running',
  SUCCEEDED: 'finished',
  FAILED: 'failed',
  UNTRACKED: 'not tracked',
  INTERRUPTED: 'interrupted',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped',
};

const PAUSES: Record<TeamPauseReason, string> = {
  'manual-advance': 'The previous member finished. Start the next one when you are ready.',
  'stage-failed': 'A member failed. Retry it, skip it or cancel the team.',
  'stage-untracked':
    'ATLAS cannot tell when this member ends (no wrapper). Confirm when it finished.',
  'stage-interrupted': 'A member was interrupted. Retry it, skip it or cancel the team.',
  'launch-failed': 'A member could not start. Retry it, skip it or cancel the team.',
  'engine-restart': 'ATLAS quit while the team ran. Retry the member or skip it.',
};

const PREFLIGHT: Record<TeamPreflightResult, string> = {
  'not-requested': 'Preflight not requested',
  running: 'Preflight running',
  passed: 'Preflight passed',
  failed: 'Preflight failed',
  'needs-authorization': 'Preflight needs a new authorization: run it from Preflight',
  'not-run': 'Preflight did not run',
};

/** Team executions of a task, newest first, kept current by `team-execution` events. */
export function useTeamExecutions(target: ContextTarget, targetKey: string, taskId: string) {
  const loaded = useKeyedLoad(`${targetKey}:teams:${taskId}`, () =>
    api().ai.teamExecutions(target, taskId),
  );
  const [updates, setUpdates] = useState<Map<string, TeamExecution>>(new Map());
  useEffect(
    () =>
      onTerminalLifecycle((event) => {
        if (event.type !== 'team-execution' || event.execution.taskId !== taskId) return;
        setUpdates((current) => new Map(current).set(event.execution.id, event.execution));
      }),
    [taskId],
  );
  const merged = new Map((loaded.value ?? []).map((item) => [item.id, item]));
  for (const [id, execution] of updates) merged.set(id, execution);
  return [...merged.values()].sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
}

export function teamLabel(execution: TeamExecution): string {
  return TEAM_STATUS[execution.status];
}

/** "Member 2 of 3 — Frontend Engineer working (Claude Code)", or null when none is current. */
export function teamHeadline(execution: TeamExecution): string | null {
  const index = execution.currentStage;
  if (index === null) return null;
  const stage = execution.stages[index]!;
  const doing =
    stage.status === 'RUNNING'
      ? 'working'
      : stage.status === 'PENDING'
        ? 'up next'
        : STAGE_STATUS[stage.status];
  return `Member ${index + 1} of ${execution.stages.length} — ${TEAM_ROLE_LABELS[stage.role]} ${doing} (${PROVIDER_NAMES[stage.provider]})`;
}

/** The terminal to watch: the current member's, else the last one that ran. */
function watchTerminal(execution: TeamExecution): string | null {
  const current =
    execution.currentStage === null ? null : execution.stages[execution.currentStage]!.terminalId;
  return (
    current ??
    [...execution.stages].reverse().find((stage) => stage.terminalId !== null)?.terminalId ??
    null
  );
}

/** The pause's choices: what continuing, retrying or skipping means here. */
function choices(execution: TeamExecution): { action: TeamContinueAction; label: string }[] {
  if (execution.status !== 'PAUSED') return [];
  if (execution.currentStage === null) {
    return [
      { action: 'retry', label: 'Run Preflight again' },
      { action: 'next', label: 'Skip Preflight' },
    ];
  }
  switch (execution.pause) {
    case 'manual-advance':
      return [
        { action: 'next', label: 'Start next member' },
        { action: 'skip', label: 'Skip member' },
      ];
    case 'stage-untracked':
      return [
        { action: 'next', label: 'Member finished' },
        { action: 'retry', label: 'Retry member' },
      ];
    default:
      return [
        { action: 'retry', label: 'Retry member' },
        { action: 'skip', label: 'Skip member' },
      ];
  }
}

interface TeamExecutionsProps {
  target: ContextTarget;
  executions: TeamExecution[];
  onOpenTerminal: (terminalId: string) => void;
}

/** Progress, decisions and results of ATLAS teams (FR-010 to FR-012, FR-015). */
export function TeamExecutions({ target, executions, onOpenTerminal }: TeamExecutionsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (executions.length === 0) return null;

  async function act(key: string, run: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await run();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="team-executions">
      {executions.slice(0, 3).map((execution) => {
        const active = ACTIVE_TEAM_EXECUTION_STATUSES.includes(execution.status);
        return (
          <section
            key={execution.id}
            className="flex min-w-0 flex-col gap-2 rounded-md border p-2.5 text-sm"
            data-testid="team-execution"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium" data-testid="team-status">
                {TEAM_STATUS[execution.status]}
                {execution.reviewedAt ? ' · reviewed' : ''}
              </span>
              <span className="text-muted-foreground text-xs">
                Approved {formatDateTime(execution.approvedAt)}
              </span>
            </div>
            {teamHeadline(execution) && (
              <p className="text-sm" data-testid="team-headline">
                {teamHeadline(execution)}
              </p>
            )}
            <ol className="flex flex-col gap-1" aria-label="Team members">
              {execution.stages.map((stage, index) => (
                <li
                  key={stage.role}
                  className={cn(
                    'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs',
                    execution.currentStage === index && 'font-medium',
                  )}
                  data-testid="team-stage-status"
                >
                  <span>
                    {index + 1}. {TEAM_ROLE_LABELS[stage.role]}
                  </span>
                  <span className="text-muted-foreground">
                    {PROVIDER_NAMES[stage.provider]} · {stage.profileName ?? 'default account'}
                  </span>
                  <span className="bg-accent rounded px-1.5 py-0.5">
                    {STAGE_STATUS[stage.status]}
                    {stage.exitCode !== null && stage.status === 'FAILED'
                      ? ` (exit ${stage.exitCode})`
                      : ''}
                  </span>
                  {stage.changedFiles.length > 0 && (
                    <span className="text-muted-foreground">
                      {stage.changedFiles.length} file(s)
                    </span>
                  )}
                  {stage.terminalId && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => onOpenTerminal(stage.terminalId!)}
                    >
                      Terminal
                    </Button>
                  )}
                </li>
              ))}
            </ol>

            {execution.status === 'PAUSED' && execution.pause && (
              <p className="text-warning text-xs" role="status" data-testid="team-pause">
                {PAUSES[execution.pause]}
                {execution.pauseDetail ? ` ${execution.pauseDetail}` : ''}
              </p>
            )}

            {execution.summary && (
              <div className="flex flex-col gap-1 text-xs" data-testid="team-summary">
                <span>
                  {execution.summary.changedFiles.length} file(s) changed ·{' '}
                  {execution.summary.commits.length} commit(s)
                  {execution.preflight ? ` · ${PREFLIGHT[execution.preflight.result]}` : ''}
                </span>
                {execution.summary.changedFiles.length > 0 && (
                  <details>
                    <summary className="cursor-pointer">Changed files</summary>
                    <ul className="font-mono break-all">
                      {execution.summary.changedFiles.map((file) => (
                        <li key={file}>{file}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {execution.summary.commits.length > 0 && (
                  <details>
                    <summary className="cursor-pointer">Commits</summary>
                    <ul>
                      {execution.summary.commits.map((commit) => (
                        <li key={commit.hash} className="break-words">
                          <span className="font-mono">{commit.hash.slice(0, 8)}</span>{' '}
                          {commit.subject}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <span className="text-muted-foreground" data-testid="team-usage">
                  {execution.summary.usage.length === 0
                    ? 'Usage: not reported for these accounts.'
                    : `Subscription use now: ${execution.summary.usage
                        .map(
                          (note) =>
                            `${note.profileName} ${note.usedPercent === null ? 'unknown' : `${Math.round(note.usedPercent)}%`}`,
                        )
                        .join(', ')} (a percentage of the plan, not a cost).`}{' '}
                  Tests ran only if a member or Preflight ran them; check each member’s terminal.
                </span>
              </div>
            )}

            <div className="flex flex-wrap gap-1.5">
              {watchTerminal(execution) !== null && (
                <Button
                  size="xs"
                  variant={active ? 'default' : 'outline'}
                  onClick={() => onOpenTerminal(watchTerminal(execution)!)}
                  data-testid="team-watch"
                >
                  Watch team
                </Button>
              )}
              {choices(execution).map((choice) => (
                <Button
                  key={choice.action}
                  size="xs"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`${execution.id}:${choice.action}`, () =>
                      unwrap(api().ai.continueTeamExecution(target, execution.id, choice.action)),
                    )
                  }
                >
                  {choice.label}
                </Button>
              ))}
              {active && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`${execution.id}:cancel`, () =>
                      unwrap(api().ai.cancelTeamExecution(target, execution.id)),
                    )
                  }
                  data-testid="team-cancel"
                >
                  Cancel team
                </Button>
              )}
              {!active && execution.reviewedAt === null && execution.status !== 'CANCELLED' && (
                <Button
                  size="xs"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`${execution.id}:review`, () =>
                      unwrap(api().ai.reviewTeamExecution(target, execution.id)),
                    )
                  }
                  data-testid="team-review"
                >
                  Mark reviewed
                </Button>
              )}
            </div>
          </section>
        );
      })}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
