import {
  PRE_COMMIT_STEPS_MAX,
  ProjectGitSettingsSchema,
  type PreCommitStep,
} from '@atlas/contracts';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  NEW_STEP,
  fromDraft,
  moveStep,
  savedDrafts,
  stepFieldLabel,
  stepIssueMessage,
  toDraft,
  waitsForReadyText,
  type StepDraft,
} from '../commit-steps';

interface CommitSettingsFormProps {
  projectId: string;
  /**
   * The stored settings cannot be read (from the repository's commit context, when the caller
   * has it; the form also learns it when loading the settings): the form shows the defaults and
   * commits are refused until the settings are saved.
   */
  settingsInvalid?: boolean;
}

/**
 * Commit checks of a project: Conventional Commits enforcement and up to five
 * commands that must all pass before ATLAS creates a commit.
 */
export function CommitSettingsForm({
  projectId,
  settingsInvalid = false,
}: CommitSettingsFormProps) {
  const id = useId();
  /** Cleared once the settings were saved again. */
  const [invalid, setInvalid] = useState(settingsInvalid);
  const [enforce, setEnforce] = useState(true);
  const [steps, setSteps] = useState<StepDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Move buttons by step key, to keep keyboard focus on a step after moving it. */
  const moveButtons = useRef(
    new Map<string, { up: HTMLButtonElement | null; down: HTMLButtonElement | null }>(),
  );
  const focusAfterMove = useRef<{ key: string; delta: number } | null>(null);
  /** The control focused when saving started; the form is disabled while saving. */
  const focusAfterSave = useRef<HTMLElement | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let cancelled = false;
    unwrap(api().git.getProjectSettings(projectId)).then(
      (settings) => {
        if (cancelled) return;
        setEnforce(settings.enforceConventionalCommits);
        setSteps(settings.preCommitSteps.map(toDraft));
        if (settings.settingsInvalid === true) setInvalid(true);
      },
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // After a move, focus follows the moved step; at either end, where the button that was used
  // becomes disabled, focus goes to the step's other move button.
  useEffect(() => {
    const target = focusAfterMove.current;
    if (target === null || steps === null) return;
    focusAfterMove.current = null;
    const buttons = moveButtons.current.get(target.key);
    const same = target.delta < 0 ? buttons?.up : buttons?.down;
    const other = target.delta < 0 ? buttons?.down : buttons?.up;
    (same && !same.disabled ? same : other)?.focus();
  }, [steps]);

  // Saving disables the form, which drops keyboard focus; it returns once the form is enabled.
  useEffect(() => {
    const target = focusAfterSave.current;
    if (busy || target === null) return;
    focusAfterSave.current = null;
    if (target.isConnected && !target.matches(':disabled')) target.focus();
  }, [busy]);

  /** Any edit makes the previous outcome stale. */
  const edited = () => {
    setSaved(false);
    setError(null);
  };
  const change = (key: string, patch: Partial<Omit<StepDraft, 'key'>>) => {
    edited();
    setSteps(
      (current) =>
        current?.map((step) => (step.key === key ? { ...step, ...patch } : step)) ?? null,
    );
  };
  const move = (key: string, delta: number) => {
    edited();
    focusAfterMove.current = { key, delta };
    setSteps((current) => (current === null ? current : moveStep(current, key, delta)));
  };
  const remove = (key: string) => {
    edited();
    setSteps((current) => current?.filter((step) => step.key !== key) ?? null);
  };

  const registerMoveButton = (
    key: string,
    direction: 'up' | 'down',
    element: HTMLButtonElement | null,
  ) => {
    const buttons = moveButtons.current.get(key) ?? { up: null, down: null };
    buttons[direction] = element;
    if (buttons.up === null && buttons.down === null) moveButtons.current.delete(key);
    else moveButtons.current.set(key, buttons);
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (steps === null || busy) return;
    const candidate = { enforceConventionalCommits: enforce, preCommitSteps: steps.map(fromDraft) };
    const parsed = ProjectGitSettingsSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(stepIssueMessage(parsed.error.issues[0]!, steps));
      return;
    }
    const active = document.activeElement;
    focusAfterSave.current =
      active instanceof HTMLElement && formRef.current?.contains(active) ? active : null;
    setBusy(true);
    setError(null);
    try {
      const stored = await unwrap(api().git.setProjectSettings(projectId, parsed.data));
      setSteps(savedDrafts(stored.preCommitSteps, parsed.data.preCommitSteps, steps));
      setInvalid(false);
      setSaved(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues[0]
          ? caught.issues[0].message
          : errorMessage(caught),
      );
    } finally {
      setBusy(false);
    }
  }

  if (steps === null) {
    return error ? (
      <p className="text-destructive text-sm" role="alert">
        {error}
      </p>
    ) : (
      <p className="text-muted-foreground text-sm">Loading…</p>
    );
  }

  return (
    <form
      ref={formRef}
      className="flex min-w-0 flex-col"
      onSubmit={save}
      data-testid="commit-settings"
      aria-busy={busy}
    >
      <fieldset className="flex min-w-0 flex-col gap-4" disabled={busy}>
        {invalid && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="commit-settings-invalid">
              The stored commit checks settings are invalid; the defaults are shown. Commits from
              ATLAS are refused until you save these settings again.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex items-start gap-2">
          <Checkbox
            id={`${id}-enforce`}
            checked={enforce}
            onCheckedChange={(checked) => {
              edited();
              setEnforce(checked === true);
            }}
          />
          <div className="flex flex-col gap-0.5">
            <Label htmlFor={`${id}-enforce`}>Enforce Conventional Commits</Label>
            <span className="text-muted-foreground text-xs">
              When off, any non-empty commit message is accepted for this project.
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Steps before each commit</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {steps.length}/{PRE_COMMIT_STEPS_MAX}
            </span>
          </div>
          <p className="text-muted-foreground text-xs">
            Commands run in order in the project directory, with your shell. All must pass, or
            nothing is committed. They run on your working tree, including changes left out of the
            commit.
          </p>
          {steps.length === 0 && (
            <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
              No steps: commits are created right away.
            </p>
          )}
          <ol className="flex flex-col gap-2">
            {steps.map((step, index) => (
              <li
                key={step.key}
                className="flex min-w-0 flex-col gap-2 rounded-md border p-3"
                data-testid="commit-step-editor"
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-5 shrink-0 text-xs tabular-nums">
                    {index + 1}.
                  </span>
                  <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">Name</span>
                    <Input
                      aria-label={`Name, step ${index + 1}`}
                      placeholder="Tests"
                      className="h-8"
                      value={step.name}
                      onChange={(event) => change(step.key, { name: event.target.value })}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move step ${index + 1} up`}
                    disabled={index === 0}
                    ref={(element) => registerMoveButton(step.key, 'up', element)}
                    onClick={() => move(step.key, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move step ${index + 1} down`}
                    disabled={index === steps.length - 1}
                    ref={(element) => registerMoveButton(step.key, 'down', element)}
                    onClick={() => move(step.key, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove step ${index + 1}`}
                    onClick={() => remove(step.key)}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <label className="flex min-w-0 flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">Command</span>
                  <Input
                    aria-label={`Command, step ${index + 1}`}
                    placeholder="npm run test"
                    className="h-8 font-mono text-xs"
                    value={step.command}
                    onChange={(event) => change(step.key, { command: event.target.value })}
                  />
                </label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">Mode</span>
                    <Select
                      value={step.mode}
                      onValueChange={(mode) =>
                        change(step.key, { mode: mode as PreCommitStep['mode'] })
                      }
                    >
                      <SelectTrigger className="h-8 w-full" aria-label={`Mode, step ${index + 1}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="complete">Run to completion</SelectItem>
                        <SelectItem value="start">Start and stop</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  {step.mode === 'start' && (
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-muted-foreground">Must keep running (s)</span>
                      <Input
                        aria-label={`Must keep running (s), step ${index + 1}`}
                        aria-describedby={`${id}-${step.key}-start-help`}
                        inputMode="numeric"
                        className="h-8"
                        value={step.readyAfterSeconds}
                        disabled={waitsForReadyText(step)}
                        onChange={(event) =>
                          change(step.key, { readyAfterSeconds: event.target.value })
                        }
                      />
                    </label>
                  )}
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">
                      {stepFieldLabel('timeoutSeconds', step.mode)}
                    </span>
                    <Input
                      aria-label={`${stepFieldLabel('timeoutSeconds', step.mode)}, step ${index + 1}`}
                      inputMode="numeric"
                      className="h-8"
                      value={step.timeoutSeconds}
                      onChange={(event) => change(step.key, { timeoutSeconds: event.target.value })}
                    />
                  </label>
                </div>
                {step.mode === 'start' ? (
                  <>
                    <label className="flex min-w-0 flex-col gap-1 text-xs">
                      <span className="text-muted-foreground">Ready text (optional)</span>
                      <Input
                        aria-label={`Ready text (optional), step ${index + 1}`}
                        placeholder="e.g. listening on"
                        className="h-8 text-xs"
                        value={step.readyText}
                        onChange={(event) => change(step.key, { readyText: event.target.value })}
                      />
                    </label>
                    <p
                      id={`${id}-${step.key}-start-help`}
                      className="text-muted-foreground text-xs"
                      data-testid="commit-step-start-help"
                    >
                      {waitsForReadyText(step)
                        ? `Passes only once it prints the ready text; fails if it exits first or the ready text does not appear within ${step.timeoutSeconds || '…'} s. "Must keep running" applies only without a ready text.`
                        : `Must keep running for ${step.readyAfterSeconds || '…'} s; exiting earlier fails the step.`}{' '}
                      ATLAS then stops it and everything it started.
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    Must exit with code 0 within {step.timeoutSeconds || '…'} s.
                  </p>
                )}
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={steps.length >= PRE_COMMIT_STEPS_MAX}
            onClick={() => {
              edited();
              setSteps((current) => [...(current ?? []), toDraft(NEW_STEP)]);
            }}
          >
            <Plus />
            Add step
          </Button>
        </div>

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="commit-settings-error">{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save commit checks'}
          </Button>
          {saved && (
            <span className="text-muted-foreground text-xs" role="status">
              Saved.
            </span>
          )}
        </div>
      </fieldset>
    </form>
  );
}
