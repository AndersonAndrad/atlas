import type { ProjectQuickCommandSettings, QuickCommand } from '@atlas/contracts';
import { useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';

/** Whether the project offers a command: prioritized unless hidden, others when enabled. */
function shownIn(settings: ProjectQuickCommandSettings, command: QuickCommand): boolean {
  return command.prioritized
    ? !settings.hidden.includes(command.id)
    : settings.enabled.includes(command.id);
}

/**
 * Which quick commands this project's action menus offer (PLAN-023). Prioritized commands
 * appear in every project until hidden here; the others only where enabled here.
 */
export function ProjectQuickCommands({ projectId }: { projectId: string }) {
  const [commands, setCommands] = useState<QuickCommand[] | null>(null);
  const [settings, setSettings] = useState<ProjectQuickCommandSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      unwrap(api().quickCommands.list()),
      unwrap(api().quickCommands.projectSettings(projectId)),
    ]).then(
      ([list, stored]) => {
        if (cancelled) return;
        setCommands(list);
        setSettings(stored);
      },
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function setShown(command: QuickCommand, shown: boolean) {
    if (settings === null) return;
    const without = (ids: string[]) => ids.filter((id) => id !== command.id);
    const next: ProjectQuickCommandSettings = command.prioritized
      ? { ...settings, hidden: shown ? without(settings.hidden) : [...settings.hidden, command.id] }
      : {
          ...settings,
          enabled: shown ? [...settings.enabled, command.id] : without(settings.enabled),
        };
    setBusy(true);
    setError(null);
    try {
      setSettings(await unwrap(api().quickCommands.setProjectSettings(projectId, next)));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="project-quick-commands">
      <p className="text-muted-foreground text-xs">
        Checked commands appear in this project&apos;s Actions menu in Terminals. Commands marked
        “All projects” are prioritized: uncheck them where they do not apply, e.g.{' '}
        <code>npm run dev</code> in a Go project. Check any other command to offer it in this
        project only.
      </p>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {commands !== null && commands.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No quick commands yet. Add them in Quick commands.
        </p>
      )}
      {settings !== null && commands !== null && commands.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border" aria-label="Quick commands">
          {commands.map((command) => (
            <li key={command.id}>
              <label className="flex min-w-0 cursor-pointer items-start gap-2 p-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={shownIn(settings, command)}
                  disabled={busy}
                  aria-label={`Show ${command.name} in this project`}
                  onCheckedChange={(checked) => void setShown(command, checked === true)}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{command.name}</span>
                    {command.prioritized && (
                      <span className="bg-primary/15 text-primary shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium">
                        All projects
                      </span>
                    )}
                  </span>
                  <code className="text-muted-foreground font-mono text-xs break-all">
                    {command.command}
                  </code>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
