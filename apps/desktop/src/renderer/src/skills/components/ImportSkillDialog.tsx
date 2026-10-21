import { TriangleAlert } from 'lucide-react';
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
import { useKeyedLoad } from '@/context/hooks/useContextData';
import { CompatibilityBadges, IssueList, formatBytes } from '../format';

const issuesMessage = (caught: unknown) =>
  caught instanceof ApiError && caught.issues.length > 0
    ? caught.issues.map((issue) => issue.message).join(' ')
    : errorMessage(caught);

/**
 * Shows what importing a folder would do — scripts, requested permissions,
 * compatibility and problems — and copies it only after the user confirms (FR-623).
 */
export function ImportSkillDialog({
  path,
  onClose,
  onImported,
}: {
  path: string;
  onClose: () => void;
  onImported: (skillId: string) => void;
}) {
  const preview = useKeyedLoad(`skill-import:${path}`, () => api().skills.inspect(path));
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = preview.value;
  const needsReview =
    value !== null &&
    (value.validation.scripts.length > 0 || value.validation.permissions.length > 0);
  const canImport =
    value !== null && value.validation.valid && !value.sameContent && (!needsReview || reviewed);

  async function importSkill() {
    if (value === null) return;
    setBusy(true);
    setError(null);
    try {
      const skill = await unwrap(
        api().skills.import({ path: value.path, confirm: true, contentHash: value.contentHash }),
      );
      onImported(skill.id);
    } catch (caught) {
      setError(issuesMessage(caught));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
        data-testid="skill-import-dialog"
      >
        <DialogHeader>
          <DialogTitle>Import skill</DialogTitle>
          <DialogDescription className="break-all">{path}</DialogDescription>
        </DialogHeader>
        {preview.error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{preview.error}</AlertDescription>
          </Alert>
        )}
        {value === null ? (
          !preview.error && <p className="text-muted-foreground text-sm">Reading the folder…</p>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <div>
              <p className="font-medium" data-testid="skill-import-name">
                {value.name}{' '}
                <span className="text-muted-foreground text-xs">({value.version})</span>
              </p>
              <p className="text-muted-foreground">{value.description || 'No description.'}</p>
              <p className="text-muted-foreground text-xs">
                {value.files.length} file(s), {formatBytes(value.totalSize)}. ATLAS copies them into
                its data folder; the original folder is not changed.
              </p>
            </div>
            <CompatibilityBadges items={value.validation.compatibility} />
            <IssueList
              issues={[
                ...value.validation.issues,
                ...value.validation.compatibility.flatMap((item) =>
                  item.issues.filter((issue) => issue.level !== 'info'),
                ),
              ]}
              testId="skill-import-issues"
            />
            {value.validation.scripts.length > 0 && (
              <section data-testid="skill-import-scripts">
                <h3 className="flex items-center gap-1 font-medium">
                  <TriangleAlert className="text-warning size-4" aria-hidden="true" />
                  Executable files (never run by ATLAS)
                </h3>
                <ul className="list-disc pl-5 font-mono text-xs">
                  {value.validation.scripts.map((script) => (
                    <li key={script}>{script}</li>
                  ))}
                </ul>
              </section>
            )}
            {value.validation.permissions.length > 0 && (
              <section data-testid="skill-import-permissions">
                <h3 className="font-medium">Requested permissions</h3>
                <ul className="list-disc pl-5 text-xs">
                  {value.validation.permissions.map((permission) => (
                    <li key={permission}>{permission}</li>
                  ))}
                </ul>
              </section>
            )}
            {value.validation.dependencies.length > 0 && (
              <section>
                <h3 className="font-medium">Dependencies (checked, never installed)</h3>
                <ul className="text-xs">
                  {value.validation.dependencies.map((dependency) => (
                    <li key={`${dependency.kind}:${dependency.name}`}>
                      {dependency.kind} <code>{dependency.name}</code>: {dependency.status}
                      {dependency.detail ? ` — ${dependency.detail}` : ''}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {value.sameContent && (
              <p className="text-muted-foreground text-xs">This version is already imported.</p>
            )}
            {value.existingSkillId && !value.sameContent && (
              <p className="text-xs">
                A registered skill comes from this folder; this adds a new version.
              </p>
            )}
            {needsReview && (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={reviewed}
                  onCheckedChange={(checked) => setReviewed(checked === true)}
                  data-testid="skill-import-reviewed"
                />
                I reviewed the executable files and permissions. AI providers may run them when the
                skill tells them to.
              </label>
            )}
          </div>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="skill-import-error">{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void importSkill()} disabled={!canImport || busy}>
            {busy ? 'Importing…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
