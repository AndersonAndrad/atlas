import type { StoredGitPreferences, UpdateGitPreferences } from '@atlas/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { INVALID_PREFERENCES_MESSAGE } from '../format';
import { createSaveQueue } from '../save-queue';
import { GlobalGitIdentitySection } from './GitIdentitySection';

const parseTypes = (value: string) =>
  value
    .split(',')
    .map((type) => type.trim())
    .filter((type) => type !== '');

const saveErrorMessage = (caught: unknown) =>
  caught instanceof ApiError && caught.issues[0] ? caught.issues[0].message : errorMessage(caught);

/** Outcome of one kind of save, shown next to the control that started it. */
type Feedback = { state: 'idle' | 'saving' | 'saved' } | { state: 'error'; message: string };

const IDLE: Feedback = { state: 'idle' };

/**
 * Commit conventions on top of Conventional Commits. They can only restrict the
 * format, never relax it.
 */
export function GitSettingsSection() {
  const [preferences, setPreferences] = useState<StoredGitPreferences | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [types, setTypes] = useState('');
  const [maxLength, setMaxLength] = useState('');
  const [conventions, setConventions] = useState<Feedback>(IDLE);
  const [toggles, setToggles] = useState<Feedback>(IDLE);
  /** Saves run one at a time; only the latest one's outcome may replace the shown preferences. */
  const saves = useRef(createSaveQueue());
  /** Number of the latest checkbox change; only its outcome reports "Saved.". */
  const latestToggle = useRef(0);
  /** Incremented on every edit of the conventions, so an older save never reports "Saved.". */
  const conventionsEdits = useRef(0);

  useEffect(() => {
    let cancelled = false;
    unwrap(api().git.getPreferences()).then(
      (value) => {
        if (cancelled) return;
        setPreferences(value);
        setTypes(value.commitTypes.join(', '));
        setMaxLength(value.headerMaxLength === null ? '' : String(value.headerMaxLength));
      },
      (caught: unknown) => !cancelled && setLoadError(errorMessage(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Saves after every earlier save finished. The stored preferences of the latest save are
   * shown; when the latest save fails, the stored preferences are read again so the controls
   * never show a value that was not saved.
   */
  function save(input: UpdateGitPreferences): Promise<void> {
    const queue = saves.current;
    const { ticket, result } = queue.enqueue(() => unwrap(api().git.setPreferences(input)));
    return result.then(
      (stored) => {
        if (queue.isLatest(ticket)) setPreferences(stored);
      },
      async (caught: unknown) => {
        if (queue.isLatest(ticket)) {
          const stored = await unwrap(api().git.getPreferences()).catch(() => null);
          if (stored !== null && queue.isLatest(ticket)) setPreferences(stored);
        }
        throw caught;
      },
    );
  }

  function toggle(
    input: Pick<UpdateGitPreferences, 'requireScope' | 'suggestions' | 'monitorNewProjects'>,
  ) {
    // Shown right away; the latest choice wins once every queued save finished.
    setPreferences((current) => (current === null ? current : { ...current, ...input }));
    setToggles({ state: 'saving' });
    const ticket = (latestToggle.current += 1);
    save(input).then(
      () =>
        ticket === latestToggle.current &&
        // An earlier toggle that failed keeps its message until the next toggle.
        setToggles((current) => (current.state === 'error' ? current : { state: 'saved' })),
      (caught: unknown) => setToggles({ state: 'error', message: saveErrorMessage(caught) }),
    );
  }

  const editConventions = (apply: () => void) => {
    conventionsEdits.current += 1;
    apply();
    setConventions(IDLE);
  };

  const saveConventions = (event: FormEvent) => {
    event.preventDefault();
    if (conventions.state === 'saving') return;
    const length = maxLength.trim();
    if (length !== '' && !/^\d+$/.test(length)) {
      setConventions({ state: 'error', message: 'The header length must be a whole number.' });
      return;
    }
    const edits = conventionsEdits.current;
    setConventions({ state: 'saving' });
    save({
      commitTypes: parseTypes(types),
      headerMaxLength: length === '' ? null : Number(length),
    }).then(
      // An edit made while saving already reset the outcome (and may have started a newer
      // save); an outdated success or failure never overwrites that newer state.
      () => edits === conventionsEdits.current && setConventions({ state: 'saved' }),
      (caught: unknown) =>
        edits === conventionsEdits.current &&
        setConventions({ state: 'error', message: saveErrorMessage(caught) }),
    );
  };

  return (
    <section
      className="bg-card flex flex-col gap-4 rounded-lg border p-4"
      aria-labelledby="git-settings-title"
      data-testid="git-settings"
    >
      <div className="flex flex-col gap-1">
        <h2 id="git-settings-title" className="font-semibold">
          Git
        </h2>
        <p className="text-muted-foreground text-xs">
          These conventions apply when a project enforces Conventional Commits 1.0.0. Enforcement
          and pre-commit steps are configured in the project's commit checks.
        </p>
      </div>
      {loadError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid="git-settings-error">{loadError}</AlertDescription>
        </Alert>
      )}
      {preferences?.invalid === true && (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid="git-preferences-invalid">
            {INVALID_PREFERENCES_MESSAGE}
          </AlertDescription>
        </Alert>
      )}
      {preferences === null ? (
        !loadError && <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={saveConventions}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="git-commit-types">Allowed commit types</Label>
              <Input
                id="git-commit-types"
                placeholder="Any valid type"
                value={types}
                onChange={(event) => editConventions(() => setTypes(event.target.value))}
                aria-describedby="git-commit-types-help"
              />
              <p id="git-commit-types-help" className="text-muted-foreground text-xs">
                Comma-separated, e.g. feat, fix, docs. Leave empty to allow any type.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="git-header-length">Maximum header length</Label>
              <Input
                id="git-header-length"
                inputMode="numeric"
                placeholder="No limit"
                value={maxLength}
                onChange={(event) => editConventions(() => setMaxLength(event.target.value))}
              />
            </div>
            {conventions.state === 'error' && (
              <Alert variant="destructive" role="alert" className="sm:col-span-2">
                <AlertDescription data-testid="git-settings-error">
                  {conventions.message}
                </AlertDescription>
              </Alert>
            )}
            <div className="flex items-end sm:col-span-2">
              <Button type="submit" variant="secondary" disabled={conventions.state === 'saving'}>
                {conventions.state === 'saving' ? 'Saving…' : 'Save conventions'}
              </Button>
              {conventions.state === 'saved' && (
                <span
                  className="text-muted-foreground ml-3 self-center text-xs"
                  role="status"
                  data-testid="git-conventions-saved"
                >
                  Saved.
                </span>
              )}
            </div>
          </form>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="git-require-scope"
                checked={preferences.requireScope}
                onCheckedChange={(checked) => toggle({ requireScope: checked === true })}
              />
              <Label htmlFor="git-require-scope" className="font-normal">
                Require a scope, e.g. <code>feat(api): …</code>
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="git-suggestions"
                checked={preferences.suggestions !== 'off'}
                onCheckedChange={(checked) =>
                  toggle({ suggestions: checked === true ? 'deterministic' : 'off' })
                }
              />
              <Label htmlFor="git-suggestions" className="font-normal">
                Offer commit message suggestions (from file names and change types; no AI)
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="git-monitor-new-projects"
                className="mt-0.5"
                checked={preferences.monitorNewProjects}
                onCheckedChange={(checked) => toggle({ monitorNewProjects: checked === true })}
                aria-describedby="git-monitor-new-projects-help"
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="git-monitor-new-projects" className="font-normal">
                  Monitor the Git status of new projects automatically
                </Label>
                <p id="git-monitor-new-projects-help" className="text-muted-foreground text-xs">
                  Applies to projects registered from now on. Each project can be paused or resumed
                  in its details.
                </p>
              </div>
            </div>
            {toggles.state === 'error' ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription data-testid="git-preferences-error">
                  {toggles.message}
                </AlertDescription>
              </Alert>
            ) : (
              <span
                className="text-muted-foreground min-h-4 text-xs"
                role="status"
                data-testid="git-preferences-status"
              >
                {toggles.state === 'saving' ? 'Saving…' : toggles.state === 'saved' ? 'Saved.' : ''}
              </span>
            )}
          </div>
          <GlobalGitIdentitySection />
        </>
      )}
    </section>
  );
}
