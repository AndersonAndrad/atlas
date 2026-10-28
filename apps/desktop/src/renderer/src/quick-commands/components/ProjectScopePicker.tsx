import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { filterByName } from '@/terminal/state/project-navigation';
import type { ProjectDetails } from '@/types';
import { projectLabels } from '../scope';

/**
 * Where a quick command is available (SDD-025 Task 03): a searchable list of registered
 * projects with checkboxes. No project selected means every project.
 */
export function ProjectScopePicker({
  projects,
  selected,
  onChange,
  disabled,
}: {
  projects: ProjectDetails[];
  /** Project ids, in selection order. */
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const id = useId();
  const labels = projectLabels(projects);
  const matches = filterByName(projects, query, (item) => item.project.name);
  const chosen = new Set(selected);
  const toggle = (projectId: string, on: boolean) =>
    onChange(on ? [...selected, projectId] : selected.filter((item) => item !== projectId));

  return (
    <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled}>
      <div className="flex items-center gap-2">
        <legend className="min-w-0 flex-1 text-sm font-medium">Available in projects</legend>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={selected.length === 0 || disabled}
          onClick={() => onChange([])}
        >
          Clear selection
        </Button>
      </div>
      <p
        id={`${id}-summary`}
        className="text-muted-foreground text-xs"
        aria-live="polite"
        data-testid="quick-command-scope-summary"
      >
        {selected.length === 0
          ? 'No projects selected: this command is available in all projects.'
          : `Available in ${selected.length} project${selected.length === 1 ? '' : 's'}.`}
      </p>
      {projects.length === 0 ? (
        <p className="text-muted-foreground text-xs">No projects registered.</p>
      ) : (
        <>
          {projects.length > 6 && (
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects"
              aria-label="Search projects"
              className="h-8"
            />
          )}
          <ul
            className="flex max-h-48 flex-col overflow-y-auto rounded-md border"
            aria-label="Projects"
            aria-describedby={`${id}-summary`}
          >
            {matches.length === 0 && (
              <li className="text-muted-foreground px-2 py-1.5 text-xs">No matching project.</li>
            )}
            {matches.map((item) => (
              <li key={item.project.id}>
                <label className="hover:bg-accent/50 flex min-w-0 cursor-pointer items-center gap-2 px-2 py-1.5 text-sm">
                  <Checkbox
                    checked={chosen.has(item.project.id)}
                    onCheckedChange={(checked) => toggle(item.project.id, checked === true)}
                    data-testid="quick-command-project"
                  />
                  <span className="min-w-0 flex-1 truncate">{labels.get(item.project.id)}</span>
                  {item.availability.status !== 'available' && (
                    <span className="text-muted-foreground shrink-0 text-[11px]">
                      Folder missing
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </fieldset>
  );
}
