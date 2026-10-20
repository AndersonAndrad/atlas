import {
  EXECUTION_PROFILE_DEFINITIONS,
  SESSION_MAX_CONCURRENT_MAX,
  SESSION_MAX_CONCURRENT_MIN,
  SESSION_MAX_PARALLEL_TASKS_MAX,
  SESSION_MAX_PARALLEL_TASKS_MIN,
  type ExecutionProfile,
  type SessionSettings,
  type UpdateSessionSettingsInput,
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

const range = (min: number, max: number) =>
  Array.from({ length: max - min + 1 }, (_, index) => String(min + index));

/** Planned execution limits. They are stored and validated; a future scheduler applies them. */
export function SessionSettingsSection() {
  const [settings, setSettings] = useState<SessionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    unwrap(api().sessions.getSettings()).then(setSettings, (caught: unknown) =>
      setError(errorMessage(caught)),
    );
  }, []);

  async function update(input: UpdateSessionSettingsInput) {
    setError(null);
    try {
      setSettings(await unwrap(api().sessions.setSettings(input)));
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues[0]
          ? caught.issues[0].message
          : errorMessage(caught),
      );
    }
  }

  const setProfileLimit = (profile: ExecutionProfile, value: number) => {
    if (settings === null) return;
    void update({
      profiles: { ...settings.profiles, [profile]: { maxParallelTasks: value } },
    });
  };

  return (
    <section
      className="bg-card flex flex-col gap-4 rounded-lg border p-4"
      aria-labelledby="session-settings-title"
      data-testid="session-settings"
    >
      <div className="flex flex-col gap-1">
        <h2 id="session-settings-title" className="font-semibold">
          Sessions
        </h2>
        <p className="text-muted-foreground text-xs">
          Planned limits, applied once session execution is available. Profiles never change
          security policies.
        </p>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid="session-settings-error">{error}</AlertDescription>
        </Alert>
      )}
      {settings === null ? (
        !error && <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium" id="max-concurrent-label">
              Sessions executing at the same time
            </span>
            <Select
              value={String(settings.maxConcurrentSessions)}
              onValueChange={(value) => void update({ maxConcurrentSessions: Number(value) })}
            >
              <SelectTrigger className="w-full sm:w-40" aria-labelledby="max-concurrent-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {range(SESSION_MAX_CONCURRENT_MIN, SESSION_MAX_CONCURRENT_MAX).map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {EXECUTION_PROFILE_DEFINITIONS.map((profile) => {
            const labelId = `profile-limit-${profile.id}`;
            return (
              <div key={profile.id} className="flex flex-col gap-2">
                <span className="text-sm font-medium" id={labelId}>
                  {profile.label}: parallel tasks
                </span>
                <Select
                  value={String(settings.profiles[profile.id].maxParallelTasks)}
                  onValueChange={(value) => setProfileLimit(profile.id, Number(value))}
                >
                  <SelectTrigger className="w-full sm:w-40" aria-labelledby={labelId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {range(SESSION_MAX_PARALLEL_TASKS_MIN, SESSION_MAX_PARALLEL_TASKS_MAX).map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
