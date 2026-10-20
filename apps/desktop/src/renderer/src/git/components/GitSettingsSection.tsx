import type { GitPreferences, UpdateGitPreferences } from '@atlas/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const parseTypes = (value: string) =>
  value
    .split(',')
    .map((type) => type.trim())
    .filter((type) => type !== '');

/**
 * Commit conventions on top of Conventional Commits. They can only restrict the
 * format, never relax it.
 */
export function GitSettingsSection() {
  const [preferences, setPreferences] = useState<GitPreferences | null>(null);
  const [types, setTypes] = useState('');
  const [maxLength, setMaxLength] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    unwrap(api().git.getPreferences()).then(
      (value) => {
        setPreferences(value);
        setTypes(value.commitTypes.join(', '));
        setMaxLength(value.headerMaxLength === null ? '' : String(value.headerMaxLength));
      },
      (caught: unknown) => setError(errorMessage(caught)),
    );
  }, []);

  async function update(input: UpdateGitPreferences) {
    setError(null);
    setSaved(false);
    try {
      setPreferences(await unwrap(api().git.setPreferences(input)));
      setSaved(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues[0]
          ? caught.issues[0].message
          : errorMessage(caught),
      );
    }
  }

  const saveConventions = (event: FormEvent) => {
    event.preventDefault();
    const length = maxLength.trim();
    if (length !== '' && !/^\d+$/.test(length)) {
      setError('The header length must be a whole number.');
      return;
    }
    void update({
      commitTypes: parseTypes(types),
      headerMaxLength: length === '' ? null : Number(length),
    });
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
          Commits made in ATLAS always follow Conventional Commits 1.0.0. These options add project
          conventions on top of it.
        </p>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid="git-settings-error">{error}</AlertDescription>
        </Alert>
      )}
      {preferences === null ? (
        !error && <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={saveConventions}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="git-commit-types">Allowed commit types</Label>
              <Input
                id="git-commit-types"
                placeholder="Any valid type"
                value={types}
                onChange={(event) => setTypes(event.target.value)}
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
                onChange={(event) => setMaxLength(event.target.value)}
              />
            </div>
            <div className="flex items-end sm:col-span-2">
              <Button type="submit" variant="secondary">
                Save conventions
              </Button>
              {saved && (
                <span className="text-muted-foreground ml-3 self-center text-xs" role="status">
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
                onCheckedChange={(checked) => void update({ requireScope: checked === true })}
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
                  void update({ suggestions: checked === true ? 'deterministic' : 'off' })
                }
              />
              <Label htmlFor="git-suggestions" className="font-normal">
                Offer commit message suggestions (from file names and change types; no AI)
              </Label>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
