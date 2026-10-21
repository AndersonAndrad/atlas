import {
  AGENT_ROLES,
  EXECUTION_PROFILE_DEFINITIONS,
  TOKEN_ESTIMATE_METHOD,
  type ContextBudgetSettings,
  type UpdateContextBudgetSettings,
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
import { BUDGET_OPTIONS, ROLE_LABELS, formatTokens } from '../format';

const INHERIT = '__inherit__';

type Group = 'providers' | 'roles' | 'profiles';

/**
 * Context budgets (SDD-006 FR-603). A task's own budget wins, then the execution
 * profile, the role, the provider and finally the default.
 */
export function ContextBudgetSection() {
  const [settings, setSettings] = useState<ContextBudgetSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    unwrap(api().context.budgets()).then(setSettings, (caught: unknown) =>
      setError(errorMessage(caught)),
    );
  }, []);

  async function update(changes: UpdateContextBudgetSettings) {
    setError(null);
    try {
      setSettings(await unwrap(api().context.setBudgets(changes)));
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues[0]
          ? caught.issues[0].message
          : errorMessage(caught),
      );
    }
  }

  const setOverride = (group: Group, key: string, value: string) => {
    if (settings === null) return;
    const next: Record<string, number> = { ...settings[group] };
    if (value === INHERIT) delete next[key];
    else next[key] = Number(value);
    void update({ [group]: next });
  };

  const row = (group: Group, key: string, label: string) => {
    const labelId = `budget-${group}-${key}`;
    const current = (settings?.[group] as Record<string, number | undefined> | undefined)?.[key];
    return (
      <div key={labelId} className="flex flex-col gap-2">
        <span className="text-sm font-medium" id={labelId}>
          {label}
        </span>
        <Select
          value={current === undefined ? INHERIT : String(current)}
          onValueChange={(value) => setOverride(group, key, value)}
        >
          <SelectTrigger className="w-full sm:w-48" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>Use the next budget</SelectItem>
            {BUDGET_OPTIONS.map((tokens) => (
              <SelectItem key={tokens} value={String(tokens)}>
                {formatTokens(tokens)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  };

  return (
    <section
      className="bg-card flex flex-col gap-4 rounded-lg border p-4"
      aria-labelledby="context-budget-title"
      data-testid="context-budget-settings"
    >
      <div className="flex flex-col gap-1">
        <h2 id="context-budget-title" className="font-semibold">
          Context budgets
        </h2>
        <p className="text-muted-foreground text-xs">
          Maximum size of the context ATLAS sends to an AI session. A task’s own budget wins, then
          the execution profile, the role, the provider and the default. Sizes are estimates (
          {TOKEN_ESTIMATE_METHOD}), not measured provider usage.
        </p>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid="context-budget-error">{error}</AlertDescription>
        </Alert>
      )}
      {settings === null ? (
        !error && <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium" id="budget-default">
              Default
            </span>
            <Select
              value={String(settings.defaultTokens)}
              onValueChange={(value) => void update({ defaultTokens: Number(value) })}
            >
              <SelectTrigger className="w-full sm:w-48" aria-labelledby="budget-default">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUDGET_OPTIONS.map((tokens) => (
                  <SelectItem key={tokens} value={String(tokens)}>
                    {formatTokens(tokens)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <h3 className="text-sm font-semibold">Providers</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            {row('providers', 'claude', 'Claude Code')}
            {row('providers', 'codex', 'Codex')}
            {row('providers', 'generic', 'Generic (previews, CLI)')}
          </div>
          <h3 className="text-sm font-semibold">Roles</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            {AGENT_ROLES.map((role) => row('roles', role, ROLE_LABELS[role]))}
          </div>
          <h3 className="text-sm font-semibold">Execution profiles</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            {EXECUTION_PROFILE_DEFINITIONS.map((profile) =>
              row('profiles', profile.id, profile.label),
            )}
          </div>
        </>
      )}
    </section>
  );
}
