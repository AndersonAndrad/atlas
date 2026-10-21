import type { DiscoveredSkill } from '@atlas/contracts';
import { FolderPlus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useKeyedLoad } from '@/context/hooks/useContextData';
import { Badge, IssueList, PROVIDER_NAMES } from '../format';

const STATUS_LABELS: Record<DiscoveredSkill['status'], [string, string]> = {
  new: ['New', 'bg-sky-500/15 text-sky-300'],
  imported: ['Imported', 'bg-success/15 text-success'],
  'update-available': ['Update available', 'bg-warning/15 text-warning'],
  invalid: ['Invalid', 'bg-destructive/15 text-destructive'],
};

/**
 * Folders the user authorized for discovery, suggestions for provider folders, and
 * the skills found in them (FR-616). Nothing outside these folders is read.
 */
export function SourcesPanel({
  version,
  onImport,
}: {
  version: number;
  onImport: (path: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const key = `${version}:${revision}`;
  const sources = useKeyedLoad(`skill-sources:${key}`, () => api().skills.sources());
  const suggestions = useKeyedLoad(`skill-suggestions:${key}`, () => api().skills.suggestions());
  const discovered = useKeyedLoad(`skill-discovered:${key}`, () => api().skills.discover());
  const [error, setError] = useState<string | null>(null);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      setRevision((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function choose(then: (path: string) => Promise<unknown> | void) {
    setError(null);
    try {
      const choice = await unwrap(api().dialog.chooseDirectory('skill'));
      if (choice.canceled || !choice.inspection) return;
      await then(choice.inspection.resolvedPath ?? choice.inspection.inputPath);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const added = new Set((sources.value ?? []).map((source) => source.path));
  return (
    <div className="flex flex-col gap-4" data-testid="skill-sources">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <section className="flex flex-col gap-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Sources</h2>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void choose((path) =>
                  act(() => unwrap(api().skills.addSource({ path, kind: 'path' }))),
                )
              }
            >
              <FolderPlus />
              Add folder…
            </Button>
            <Button size="sm" onClick={() => void choose((path) => onImport(path))}>
              Import a skill folder…
            </Button>
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          ATLAS only reads folders you add here or choose in the folder picker.
        </p>
        <ul className="flex flex-col gap-1">
          {(sources.value ?? []).map((source) => (
            <li
              key={source.id}
              className="flex min-w-0 items-center gap-2 text-sm"
              data-testid="skill-source"
            >
              <Checkbox
                checked={source.enabled}
                aria-label={`Scan ${source.path}`}
                onCheckedChange={(checked) =>
                  void act(() => unwrap(api().skills.setSourceEnabled(source.id, checked === true)))
                }
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={source.path}>
                {source.path}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove source ${source.path}`}
                onClick={() => void act(() => unwrap(api().skills.removeSource(source.id)))}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
        {(suggestions.value ?? []).filter((item) => !added.has(item.path)).length > 0 && (
          <div className="flex flex-col gap-1">
            <h3 className="text-muted-foreground text-xs font-medium">Suggested folders</h3>
            {(suggestions.value ?? [])
              .filter((item) => !added.has(item.path))
              .map((item) => (
                <div
                  key={item.path}
                  className="flex min-w-0 flex-wrap items-center gap-2 text-xs"
                  data-testid="skill-suggestion"
                >
                  <Badge className="bg-muted text-muted-foreground">
                    {item.kind === 'path' ? 'Folder' : PROVIDER_NAMES[item.kind]}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono" title={item.path}>
                    {item.path}
                  </span>
                  <span className="text-muted-foreground w-full sm:w-auto">
                    {item.exists ? item.note : 'Does not exist.'}
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!item.exists}
                    onClick={() =>
                      void act(() =>
                        unwrap(api().skills.addSource({ path: item.path, kind: item.kind })),
                      )
                    }
                  >
                    Add
                  </Button>
                </div>
              ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-label="Available skills">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">Available skills</h2>
          <Button size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>
            <RefreshCw />
            Scan again
          </Button>
        </div>
        {discovered.error && <p className="text-destructive text-sm">{discovered.error}</p>}
        {discovered.value?.length === 0 && (
          <p className="text-muted-foreground text-sm">No skills found in the enabled sources.</p>
        )}
        <ul className="flex flex-col gap-2">
          {discovered.value?.map((skill) => {
            const [label, tone] = STATUS_LABELS[skill.status];
            return (
              <li
                key={skill.path}
                className="flex min-w-0 flex-col gap-1 rounded-md border p-2"
                data-testid="skill-discovered"
                data-status={skill.status}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-medium">{skill.name}</span>
                  <Badge className={tone}>{label}</Badge>
                  <span
                    className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]"
                    title={skill.path}
                  >
                    {skill.path}
                  </span>
                  {(skill.status === 'new' ||
                    skill.status === 'update-available' ||
                    skill.status === 'invalid') && (
                    <Button size="xs" variant="outline" onClick={() => onImport(skill.path)}>
                      {skill.status === 'update-available' ? 'Review update' : 'Review'}
                    </Button>
                  )}
                </div>
                <p className="text-muted-foreground text-xs">
                  {skill.description || 'No description.'}
                </p>
                <IssueList issues={skill.issues} />
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
