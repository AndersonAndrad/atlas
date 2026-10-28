import { quickCommandAvailableIn, type QuickCommand } from '@atlas/contracts';
import { useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';

/**
 * The quick commands of this project (SDD-025 Task 03). Commands of all projects are always
 * offered and are edited in Quick commands; checking another command adds this project to
 * it, unchecking removes it. A command whose last project is removed is offered nowhere.
 */
export function ProjectQuickCommands({ projectId }: { projectId: string }) {
  const [commands, setCommands] = useState<QuickCommand[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    unwrap(api().quickCommands.list()).then(
      (list) => !cancelled && setCommands(list),
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function setAssigned(command: QuickCommand, assigned: boolean) {
    setBusy(true);
    setError(null);
    try {
      const updated = await unwrap(
        api().quickCommands.setAssignment({ commandId: command.id, projectId, assigned }),
      );
      setCommands(
        (current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? null,
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="project-quick-commands">
      <p className="text-muted-foreground text-xs">
        Checked commands appear in this project&apos;s menus. Commands for all projects are always
        offered; change that in Quick commands. Check any other command to add this project to it.
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
      {commands !== null && commands.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border" aria-label="Quick commands">
          {commands.map((command) => {
            const global = command.scope === 'ALL';
            const others = command.projectIds.filter((id) => id !== projectId).length;
            return (
              <li key={command.id}>
                <label className="flex min-w-0 cursor-pointer items-start gap-2 p-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={quickCommandAvailableIn(command, projectId)}
                    disabled={busy || global}
                    aria-label={`Offer ${command.name} in this project`}
                    onCheckedChange={(checked) => void setAssigned(command, checked === true)}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium">{command.name}</span>
                      {global ? (
                        <span className="bg-primary/15 text-primary shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium">
                          All projects
                        </span>
                      ) : (
                        others > 0 && (
                          <span className="text-muted-foreground shrink-0 text-[10px]">
                            also in {others} other project{others === 1 ? '' : 's'}
                          </span>
                        )
                      )}
                    </span>
                    <code className="text-muted-foreground font-mono text-xs break-all">
                      {command.command}
                    </code>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
