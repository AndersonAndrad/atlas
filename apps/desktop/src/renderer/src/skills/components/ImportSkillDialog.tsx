import type { SkillCollectionPreview, SkillCollectionResult } from '@atlas/contracts';
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
  // A folder without SKILL.md may hold one skill per sub-folder (e.g. a skills repository).
  const folderOfSkills =
    preview.value?.validation.issues.some((issue) => issue.code === 'missing-skill-file') === true;
  const collection = useKeyedLoad(folderOfSkills ? `skill-collection:${path}` : null, () =>
    api().skills.inspectCollection(path),
  );
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

  if (collection.value && collection.value.skills.length > 0) {
    return (
      <CollectionImportDialog
        preview={collection.value}
        onClose={onClose}
        onImported={(ids) => (ids[0] !== undefined ? onImported(ids[0]) : onClose())}
      />
    );
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

/**
 * Imports the skills of a folder such as a skills repository in one go: each is listed
 * with its checks; valid ones are chosen by default; the folder becomes a source.
 */
function CollectionImportDialog({
  preview,
  onClose,
  onImported,
}: {
  preview: SkillCollectionPreview;
  onClose: () => void;
  onImported: (skillIds: string[]) => void;
}) {
  const importable = preview.skills.filter((skill) => skill.validation.valid && !skill.sameContent);
  const [chosen, setChosen] = useState<string[]>(importable.map((skill) => skill.path));
  const [enable, setEnable] = useState(true);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SkillCollectionResult | null>(null);
  const selected = preview.skills.filter((skill) => chosen.includes(skill.path));
  const scripts = selected.flatMap((skill) =>
    skill.validation.scripts.map((script) => `${skill.dirName}/${script}`),
  );
  const permissions = selected.flatMap((skill) =>
    skill.validation.permissions.map((permission) => `${skill.name}: ${permission}`),
  );
  const needsReview = scripts.length > 0 || permissions.length > 0;

  async function importAll() {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await unwrap(
          api().skills.importCollection({
            path: preview.path,
            confirm: true,
            enable,
            items: selected.map((skill) => ({ path: skill.path, contentHash: skill.contentHash })),
          }),
        ),
      );
    } catch (caught) {
      setError(issuesMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="skill-collection-dialog"
      >
        <DialogHeader>
          <DialogTitle>Import a folder of skills</DialogTitle>
          <DialogDescription className="break-all">
            {preview.skills.length} skill(s) in {preview.path}. The folder becomes a source, so
            later changes show as updates; nothing in it is changed.
          </DialogDescription>
        </DialogHeader>
        {result === null ? (
          <div className="flex min-w-0 flex-col gap-3 text-sm">
            <ul className="flex max-h-80 flex-col divide-y overflow-y-auto rounded-md border">
              {preview.skills.map((skill) => {
                const blocked = !skill.validation.valid || skill.sameContent;
                return (
                  <li
                    key={skill.path}
                    className="flex min-w-0 flex-col gap-1 p-2"
                    data-testid="skill-collection-item"
                  >
                    <label className="flex min-w-0 items-start gap-2">
                      <Checkbox
                        className="mt-0.5"
                        checked={chosen.includes(skill.path)}
                        disabled={blocked || busy}
                        aria-label={`Import ${skill.name}`}
                        onCheckedChange={(checked) =>
                          setChosen((value) =>
                            checked === true
                              ? [...value, skill.path]
                              : value.filter((item) => item !== skill.path),
                          )
                        }
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium">
                          {skill.name}{' '}
                          <span className="text-muted-foreground text-xs">({skill.version})</span>
                          {skill.sameContent && (
                            <span className="text-muted-foreground text-xs">
                              {' '}
                              · already imported
                            </span>
                          )}
                        </span>
                        <span className="text-muted-foreground line-clamp-2 text-xs">
                          {skill.description || 'No description.'}
                        </span>
                      </span>
                    </label>
                    <span className="pl-6">
                      <CompatibilityBadges items={skill.validation.compatibility} />
                    </span>
                    <span className="pl-6">
                      <IssueList
                        issues={skill.validation.issues.filter((issue) => issue.level === 'error')}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
            {scripts.length > 0 && (
              <section>
                <h3 className="flex items-center gap-1 font-medium">
                  <TriangleAlert className="text-warning size-4" aria-hidden="true" />
                  Executable files (never run by ATLAS)
                </h3>
                <ul className="list-disc pl-5 font-mono text-xs">
                  {scripts.slice(0, 30).map((script) => (
                    <li key={script}>{script}</li>
                  ))}
                </ul>
              </section>
            )}
            {permissions.length > 0 && (
              <section>
                <h3 className="font-medium">Requested permissions</h3>
                <ul className="list-disc pl-5 text-xs">
                  {permissions.slice(0, 30).map((permission) => (
                    <li key={permission}>{permission}</li>
                  ))}
                </ul>
              </section>
            )}
            <label className="flex items-start gap-2">
              <Checkbox
                className="mt-0.5"
                checked={enable}
                onCheckedChange={(checked) => setEnable(checked === true)}
                data-testid="skill-collection-enable"
              />
              Enable the imported skills for every project
            </label>
            {needsReview && (
              <label className="flex items-start gap-2">
                <Checkbox
                  className="mt-0.5"
                  checked={reviewed}
                  onCheckedChange={(checked) => setReviewed(checked === true)}
                  data-testid="skill-collection-reviewed"
                />
                I reviewed the executable files and permissions. AI providers may run them when a
                skill tells them to.
              </label>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-sm" data-testid="skill-collection-result">
            <p>
              Imported {result.imported.length} skill(s)
              {enable ? ' and enabled them for every project' : ''}.
            </p>
            {result.failed.length > 0 && (
              <ul className="text-destructive list-disc pl-5 text-xs">
                {result.failed.map((item) => (
                  <li key={item.path}>
                    {item.name}: {item.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          {result === null ? (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={() => void importAll()}
                disabled={busy || selected.length === 0 || (needsReview && !reviewed)}
              >
                {busy ? 'Importing…' : `Import ${selected.length} skill(s)`}
              </Button>
            </>
          ) : (
            <Button onClick={() => onImported(result.imported.map((skill) => skill.id))}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
