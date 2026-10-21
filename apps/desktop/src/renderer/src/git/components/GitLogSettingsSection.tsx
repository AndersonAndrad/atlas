import {
  GIT_LOG_MAX_OPERATIONS,
  GIT_LOG_RETENTION_DAYS,
  type GitOperationLogSettings,
  type UpdateGitOperationLogSettings,
} from '@atlas/contracts';
import { useEffect, useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Keeps the stored value selectable even when it is not one of the presets. */
const choices = (presets: readonly number[], current: number) =>
  [...new Set([...presets, current])].sort((a, b) => a - b);

/** Retention of the Git operation log (PLAN-016). */
export function GitLogSettingsSection() {
  const [settings, setSettings] = useState<GitOperationLogSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    unwrap(api().git.logSettings()).then(setSettings, (caught: unknown) =>
      setError(errorMessage(caught)),
    );
  }, []);

  async function update(changes: UpdateGitOperationLogSettings) {
    setError(null);
    try {
      setSettings(await unwrap(api().git.setLogSettings(changes)));
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues[0]
          ? caught.issues[0].message
          : errorMessage(caught),
      );
    }
  }

  return (
    <section
      className="bg-card flex flex-col gap-4 rounded-lg border p-4"
      aria-labelledby="git-log-settings-title"
      data-testid="git-log-settings"
    >
      <div className="flex flex-col gap-1">
        <h2 id="git-log-settings-title" className="font-semibold">
          Git operation log
        </h2>
        <p className="text-muted-foreground text-xs">
          ATLAS keeps every Git operation it runs, with the commands and their output (credentials
          removed), in its local database. Older or excess operations are removed automatically.
        </p>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {settings === null ? (
        !error && <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium" id="git-log-retention">
              Keep operations for
            </span>
            <Select
              value={String(settings.retentionDays)}
              onValueChange={(value) => void update({ retentionDays: Number(value) })}
            >
              <SelectTrigger className="w-full sm:w-40" aria-labelledby="git-log-retention">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices(GIT_LOG_RETENTION_DAYS, settings.retentionDays).map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {days} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium" id="git-log-max">
              Keep at most
            </span>
            <Select
              value={String(settings.maxOperations)}
              onValueChange={(value) => void update({ maxOperations: Number(value) })}
            >
              <SelectTrigger className="w-full sm:w-40" aria-labelledby="git-log-max">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices(GIT_LOG_MAX_OPERATIONS, settings.maxOperations).map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {count.toLocaleString('en-US')} operations
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </section>
  );
}
