import {
  TEAM_ROLES,
  TEAM_ROLE_LABELS,
  TEAM_STAGES_MAX,
  type AiProvider,
  type ContextTarget,
  type ContextTask,
  type TeamExecution,
  type TeamRole,
  type TeamStageProposal,
} from '@atlas/contracts';
import { Plus, TriangleAlert, Users, X } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useKeyedLoad } from '../hooks/useContextData';
import { PROVIDER_NAMES } from './ExecuteTaskDialog';

const DEFAULT_PROFILE = '__default__';
const NO_PREFLIGHT = '__none__';

const COMPLEXITY_LABELS = {
  simple: 'Simple',
  moderate: 'Moderate',
  complex: 'Complex',
} as const;

/** A member as edited in the preview. */
interface EditedStage {
  role: TeamRole;
  reason: string;
  responsibility: string;
  deliverables: string[];
  provider: AiProvider | null;
  profileId: string | null;
  substitution: string | null;
}

interface TeamProposalDialogProps {
  target: ContextTarget;
  targetKey: string;
  label: string;
  task: ContextTask;
  onClose: () => void;
  /** The plan was approved and its first member started. */
  onStarted: (execution: TeamExecution) => void;
}

/**
 * Execute with ATLAS (SDD-026 Task 02, FR-005): the team ATLAS proposes for a task, what
 * each member does and with which provider. Members, providers and accounts can be
 * changed; nothing runs until **Approve and run**.
 */
export function TeamProposalDialog(props: TeamProposalDialogProps) {
  const { target, targetKey, task } = props;
  // One id per confirmation: retries and double clicks return the same execution.
  const [requestId] = useState(() => crypto.randomUUID());
  const proposal = useKeyedLoad(`${targetKey}:team-proposal:${task.id}`, () =>
    api().ai.teamProposal(target, task.id),
  );
  const [edited, setEdited] = useState<EditedStage[] | null>(null);
  const [automatic, setAutomatic] = useState(true);
  const [preflightProfile, setPreflightProfile] = useState(NO_PREFLIGHT);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = proposal.value;
  const stages: EditedStage[] =
    edited ?? value?.stages.map((stage: TeamStageProposal) => ({ ...stage })) ?? [];
  const installed = (value?.providers ?? []).filter((item) => item.availability !== 'missing');
  const unusedRoles = TEAM_ROLES.filter((role) => !stages.some((stage) => stage.role === role));
  const chosenPreflight =
    value?.preflight?.profiles.find((profile) => profile.id === preflightProfile) ?? null;
  const needsAuthorization =
    chosenPreflight?.checks.filter((check) => check.authorization !== null) ?? [];

  const ready =
    value !== null &&
    stages.length > 0 &&
    stages.every((stage) => stage.provider !== null) &&
    (needsAuthorization.length === 0 || authorized);

  const update = (index: number, patch: Partial<EditedStage>) =>
    setEdited(
      stages.map((stage, position) => (position === index ? { ...stage, ...patch } : stage)),
    );

  function addRole(role: TeamRole) {
    const provider = installed[0]?.provider ?? null;
    const next = [
      ...stages,
      {
        role,
        reason: 'Added by you.',
        responsibility: '',
        deliverables: [],
        provider,
        profileId: null,
        substitution: null,
      },
    ].sort((a, b) => TEAM_ROLES.indexOf(a.role) - TEAM_ROLES.indexOf(b.role));
    setEdited(next);
  }

  async function approve() {
    if (!ready || value === null) return;
    setBusy(true);
    setError(null);
    try {
      const execution = await unwrap(
        api().ai.approveTeamPlan({
          requestId,
          target,
          taskId: task.id,
          stages: stages.map((stage) => ({
            role: stage.role,
            provider: stage.provider!,
            ...(stage.profileId ? { profileId: stage.profileId } : {}),
          })),
          advance: automatic ? 'automatic' : 'manual',
          preflight:
            chosenPreflight === null || value.preflight === null
              ? null
              : {
                  workspaceId: value.preflight.workspaceId,
                  profileId: chosenPreflight.id,
                  authorizations: authorized
                    ? needsAuthorization.map((check) => ({
                        checkId: check.checkId,
                        digest: check.digest,
                      }))
                    : [],
                },
        }),
      );
      props.onStarted(execution);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues.length > 0
          ? caught.issues.map((issue) => issue.message).join(' ')
          : errorMessage(caught),
      );
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
        data-testid="team-proposal-dialog"
      >
        <DialogHeader>
          <DialogTitle>Execute with ATLAS</DialogTitle>
          <DialogDescription>
            ATLAS assessed the task and proposes the smallest team for it. Members work one after
            another, each in its own terminal of {props.label}. Nothing starts until you approve.
          </DialogDescription>
        </DialogHeader>

        <section className="flex min-w-0 flex-col gap-1 rounded-md border p-3" aria-label="Task">
          <span className="font-medium break-words">{task.title}</span>
          <p className="text-muted-foreground line-clamp-3 text-sm break-words whitespace-pre-wrap">
            {task.objective}
          </p>
        </section>

        {value === null && !proposal.error && (
          <p className="text-muted-foreground text-sm">Assessing the task…</p>
        )}

        {value !== null && (
          <section
            className="flex flex-col gap-1.5 rounded-md border p-3 text-sm"
            aria-label="Assessment"
            data-testid="team-assessment"
          >
            <span className="font-medium" data-testid="team-complexity">
              {COMPLEXITY_LABELS[value.assessment.complexity]} task
            </span>
            <ul className="text-muted-foreground list-disc pl-5 text-xs">
              {value.assessment.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <span className="text-muted-foreground text-xs">
              {value.assessment.acceptanceCriteria.length} acceptance criteria ·{' '}
              {value.assessment.files.length} file(s) named · {value.assessment.decisions.length}{' '}
              active decision(s) to respect
            </span>
          </section>
        )}

        {value !== null && (
          <section className="flex flex-col gap-2" aria-label="Proposed team">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Users className="size-4" aria-hidden />
              Team ({stages.length})
            </h3>
            <ol className="flex flex-col gap-2" data-testid="team-stages">
              {stages.map((stage, index) => {
                const profiles = value.profiles.filter((item) => item.provider === stage.provider);
                return (
                  <li
                    key={stage.role}
                    className="flex min-w-0 flex-col gap-2 rounded-md border p-3"
                    data-testid="team-stage"
                  >
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium">
                          {index + 1}. {TEAM_ROLE_LABELS[stage.role]}
                        </span>
                        <span className="text-muted-foreground text-xs break-words">
                          {stage.reason}
                        </span>
                      </span>
                      {stages.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${TEAM_ROLE_LABELS[stage.role]}`}
                          onClick={() =>
                            setEdited(stages.filter((_, position) => position !== index))
                          }
                        >
                          <X />
                        </Button>
                      )}
                    </div>
                    {stage.responsibility && (
                      <p className="text-sm break-words">
                        {stage.responsibility}
                        {stage.deliverables.length > 0 && (
                          <span className="text-muted-foreground">
                            {' '}
                            Delivers: {stage.deliverables.join('; ')}.
                          </span>
                        )}
                      </p>
                    )}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Select
                        value={stage.provider ?? ''}
                        onValueChange={(provider) =>
                          update(index, {
                            provider: provider as AiProvider,
                            profileId: null,
                            substitution: null,
                          })
                        }
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label={`Provider for ${TEAM_ROLE_LABELS[stage.role]}`}
                        >
                          <SelectValue placeholder="No provider installed" />
                        </SelectTrigger>
                        <SelectContent>
                          {value.providers.map((item) => (
                            <SelectItem
                              key={item.provider}
                              value={item.provider}
                              disabled={item.availability === 'missing'}
                            >
                              {PROVIDER_NAMES[item.provider]}
                              {item.availability === 'missing' ? ' · not installed' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={stage.profileId ?? DEFAULT_PROFILE}
                        onValueChange={(profileId) =>
                          update(index, {
                            profileId: profileId === DEFAULT_PROFILE ? null : profileId,
                          })
                        }
                        disabled={stage.provider === null}
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label={`Account for ${TEAM_ROLE_LABELS[stage.role]}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={DEFAULT_PROFILE}>The CLI’s default account</SelectItem>
                          {profiles.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.displayName}
                              {item.usedPercent === null
                                ? ' · use unknown'
                                : ` · ${Math.round(item.usedPercent)}% used`}
                              {item.limited ? ' · limited' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {stage.substitution && (
                      <p className="text-warning text-xs" data-testid="team-substitution">
                        {stage.substitution} Approving the plan accepts it.
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
            {unusedRoles.length > 0 && stages.length < TEAM_STAGES_MAX && (
              <Select value="" onValueChange={(role) => addRole(role as TeamRole)}>
                <SelectTrigger size="sm" className="w-56" aria-label="Add a team member">
                  <Plus />
                  <SelectValue placeholder="Add a member" />
                </SelectTrigger>
                <SelectContent>
                  {unusedRoles.map((role) => (
                    <SelectItem key={role} value={role}>
                      {TEAM_ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </section>
        )}

        {value !== null && (
          <section className="flex flex-col gap-2 text-sm" aria-label="Execution">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={automatic}
                onCheckedChange={(checked) => setAutomatic(checked === true)}
                aria-label="Start each member automatically"
              />
              Start each member automatically after the previous one succeeds
            </label>
            <span className="text-muted-foreground text-xs">
              A failed, interrupted or untracked member always pauses the team for your decision.
            </span>
            {value.preflight !== null && (
              <div className="flex flex-col gap-1.5" data-testid="team-preflight">
                <Select
                  value={preflightProfile}
                  onValueChange={(next) => {
                    setPreflightProfile(next);
                    setAuthorized(false);
                  }}
                >
                  <SelectTrigger className="w-full sm:w-80" aria-label="Preflight at the end">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PREFLIGHT}>No Preflight at the end</SelectItem>
                    {value.preflight.profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        Run Preflight “{profile.name}” at the end
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {needsAuthorization.length > 0 && (
                  <Alert role="alert" className="border-warning/40">
                    <TriangleAlert className="text-warning" />
                    <AlertDescription className="flex flex-col gap-1.5">
                      <span>These checks need your authorization to run:</span>
                      <ul className="list-disc pl-5 text-xs">
                        {needsAuthorization.map((check) => (
                          <li key={check.checkId}>
                            {check.name}
                            {check.warnings.length > 0 ? ` — ${check.warnings.join(' ')}` : ''}
                          </li>
                        ))}
                      </ul>
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={authorized}
                          onCheckedChange={(checked) => setAuthorized(checked === true)}
                        />
                        Authorize these checks for this team
                      </label>
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}
          </section>
        )}

        {value !== null && value.risks.length > 0 && (
          <section aria-label="Risks" data-testid="team-risks">
            <span className="text-sm font-medium">Risks</span>
            <ul className="text-muted-foreground list-disc pl-5 text-xs">
              {value.risks.map((risk) => (
                <li key={risk}>{risk}</li>
              ))}
            </ul>
          </section>
        )}
        {value !== null && (
          <p className="text-muted-foreground text-xs">
            Cost is not estimated: no reliable data exists before running. Measured usage appears in
            the Usage view.
          </p>
        )}

        {(error ?? proposal.error) && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="team-error">{error ?? proposal.error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={props.onClose}
            disabled={busy || value === null}
            data-testid="team-reject"
          >
            Reject proposal
          </Button>
          <Button onClick={() => void approve()} disabled={!ready || busy}>
            {busy ? 'Starting…' : 'Approve and run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
