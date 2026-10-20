import { PreCommitStepSchema, type PreCommitStep } from '@atlas/contracts';

export const NEW_STEP: PreCommitStep = {
  name: '',
  command: '',
  mode: 'complete',
  timeoutSeconds: 600,
  readyAfterSeconds: 15,
  readyText: null,
};

/**
 * A step being edited. Number inputs are edited as text and validated on save. `key` only
 * identifies the step in the form (stable across reordering) and is never saved.
 */
export type StepDraft = Omit<
  PreCommitStep,
  'timeoutSeconds' | 'readyAfterSeconds' | 'readyText'
> & {
  key: string;
  timeoutSeconds: string;
  readyAfterSeconds: string;
  readyText: string;
};

let draftCount = 0;

export const toDraft = (step: PreCommitStep): StepDraft => ({
  ...step,
  key: `step-${(draftCount += 1)}`,
  timeoutSeconds: String(step.timeoutSeconds),
  readyAfterSeconds: String(step.readyAfterSeconds),
  readyText: step.readyText ?? '',
});

/** True when a `start` step passes on its ready text instead of after running for a while. */
export const waitsForReadyText = (step: Pick<StepDraft, 'mode' | 'readyText'>) =>
  step.mode === 'start' && step.readyText.trim() !== '';

/**
 * The step to save: only the persisted fields, without the form key. While a ready text is set,
 * "Must keep running" is unused and disabled in the form, so a value it cannot hold falls back to
 * the default instead of blocking the save on a field the user cannot edit.
 */
export const fromDraft = (step: StepDraft) => {
  const readyAfterSeconds = Number(step.readyAfterSeconds);
  const unusable =
    step.readyAfterSeconds.trim() === '' ||
    !PreCommitStepSchema.shape.readyAfterSeconds.safeParse(readyAfterSeconds).success;
  return {
    name: step.name,
    command: step.command,
    mode: step.mode,
    timeoutSeconds: Number(step.timeoutSeconds),
    readyAfterSeconds:
      waitsForReadyText(step) && unusable ? NEW_STEP.readyAfterSeconds : readyAfterSeconds,
    readyText: step.readyText.trim() === '' ? null : step.readyText,
  };
};

const sameStep = (a: PreCommitStep, b: PreCommitStep) =>
  a.name === b.name &&
  a.command === b.command &&
  a.mode === b.mode &&
  a.timeoutSeconds === b.timeoutSeconds &&
  a.readyAfterSeconds === b.readyAfterSeconds &&
  a.readyText === b.readyText;

/**
 * Drafts of the saved steps. When they are exactly the submitted ones, each keeps the key of the
 * draft it was saved from, so the form keeps its elements (and keyboard focus); otherwise every
 * step gets a new key.
 */
export function savedDrafts(
  stored: readonly PreCommitStep[],
  sent: readonly PreCommitStep[],
  submitted: readonly StepDraft[],
): StepDraft[] {
  const unchanged =
    stored.length === sent.length &&
    sent.length === submitted.length &&
    stored.every((step, index) => sameStep(step, sent[index]!));
  return stored.map((step, index) =>
    unchanged ? { ...toDraft(step), key: submitted[index]!.key } : toDraft(step),
  );
}

/** Moves the step with `key` by `delta` positions; unchanged when it would leave the list. */
export function moveStep(steps: StepDraft[], key: string, delta: number): StepDraft[] {
  const from = steps.findIndex((step) => step.key === key);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= steps.length) return steps;
  const next = [...steps];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** Visible label of a step field, as shown in the form. */
export function stepFieldLabel(field: string, mode: PreCommitStep['mode']): string {
  switch (field) {
    case 'name':
      return 'Name';
    case 'command':
      return 'Command';
    case 'mode':
      return 'Mode';
    case 'timeoutSeconds':
      return mode === 'start' ? 'Ready text timeout (s)' : 'Timeout (s)';
    case 'readyAfterSeconds':
      return 'Must keep running (s)';
    case 'readyText':
      return 'Ready text';
    default:
      return field;
  }
}

/** A validation issue as shown to the user, naming the step and field by their visible labels. */
export function stepIssueMessage(
  issue: { path: readonly PropertyKey[]; message: string },
  steps: readonly Pick<StepDraft, 'mode'>[],
): string {
  const [, stepIndex, field] = issue.path;
  if (typeof stepIndex !== 'number') return issue.message;
  const step = steps[stepIndex];
  if (typeof field !== 'string' || step === undefined) {
    return `Step ${stepIndex + 1}: ${issue.message}`;
  }
  return `Step ${stepIndex + 1} — ${stepFieldLabel(field, step.mode)}: ${issue.message}`;
}
