import { AI_PROVIDERS, type AiProvider, type SkillSyncPlan } from '@atlas/contracts';
import { useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDateTime } from '@/context/format';
import { useKeyedLoad } from '@/context/hooks/useContextData';
import { cn } from '@/lib/utils';
import { Badge, PROVIDER_NAMES, SYNC_ACTION_LABELS } from '../format';

const NONE = '__none__';
const CHOOSE = '__choose__';
const message = (caught: unknown) =>
  caught instanceof ApiError && caught.issues.length > 0
    ? caught.issues.map((issue) => issue.message).join(' ')
    : errorMessage(caught);

/**
 * Explicit synchronization of globally enabled skills to a provider's user folder
 * (FR-624): preview, apply, rollback. Folders not created by ATLAS are never changed.
 */
export function SyncPanel({ version }: { version: number }) {
  const [revision, setRevision] = useState(0);
  const key = `${version}:${revision}`;
  const targets = useKeyedLoad(`skill-sync-targets:${key}`, () => api().skills.syncTargets());
  const suggestions = useKeyedLoad('skill-sync-suggestions', () => api().skills.suggestions());
  const history = useKeyedLoad(`skill-sync-history:${key}`, () => api().skills.syncHistory());
  const [plans, setPlans] = useState<Partial<Record<AiProvider, SkillSyncPlan>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setError(message(caught));
    }
    setRevision((value) => value + 1);
  }

  async function setTarget(provider: AiProvider, value: string) {
    if (value === CHOOSE) {
      const choice = await unwrap(api().dialog.chooseDirectory('skill'));
      if (choice.canceled || !choice.inspection) return;
      value = choice.inspection.resolvedPath ?? choice.inspection.inputPath;
    }
    await act(() =>
      unwrap(api().skills.setSyncTargets({ [provider]: value === NONE ? null : value })),
    );
    setPlans((current) => ({ ...current, [provider]: undefined }));
  }

  return (
    <div className="flex flex-col gap-4" data-testid="skill-sync">
      <p className="text-muted-foreground text-sm">
        Copies skills enabled for every project into a provider’s user folder. Project, role and
        session rules are applied by ATLAS when it prepares context, not by these folders.
      </p>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid="skill-sync-error">{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert role="status">
          <AlertDescription data-testid="skill-sync-notice">{notice}</AlertDescription>
        </Alert>
      )}
      {AI_PROVIDERS.map((provider) => {
        const target = targets.value?.[provider] ?? null;
        const options = (suggestions.value ?? []).filter((item) => item.kind === provider);
        const plan = plans[provider];
        const changes = plan?.items.filter((item) =>
          ['create', 'update', 'remove'].includes(item.action),
        ).length;
        const latest = history.value?.find(
          (batch) => batch.provider === provider && batch.rolledBackAt === null,
        );
        return (
          <section
            key={provider}
            className="flex flex-col gap-2 rounded-lg border p-3"
            data-testid={`skill-sync-${provider}`}
          >
            <h2 className="font-semibold">{PROVIDER_NAMES[provider]}</h2>
            <Select
              value={target ?? NONE}
              onValueChange={(value) => void setTarget(provider, value)}
            >
              <SelectTrigger
                className="w-full"
                aria-label={`${PROVIDER_NAMES[provider]} skills folder`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Do not synchronize</SelectItem>
                {target && !options.some((item) => item.path === target) && (
                  <SelectItem value={target}>{target}</SelectItem>
                )}
                {options.map((item) => (
                  <SelectItem key={item.path} value={item.path}>
                    {item.path} {item.exists ? '' : '(will be created)'}
                  </SelectItem>
                ))}
                <SelectItem value={CHOOSE}>Choose another folder…</SelectItem>
              </SelectContent>
            </Select>
            {target && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void act(async () => {
                      const next = await unwrap(api().skills.syncPreview(provider));
                      setPlans((current) => ({ ...current, [provider]: next }));
                    })
                  }
                >
                  Preview
                </Button>
                <Button
                  size="sm"
                  disabled={!plan || changes === 0}
                  onClick={() =>
                    void act(async () => {
                      const result = await unwrap(api().skills.syncApply(provider));
                      setPlans((current) => ({ ...current, [provider]: undefined }));
                      setNotice(
                        `${result.applied.length} change(s) written to ${PROVIDER_NAMES[provider]}` +
                          (result.skipped.length ? `; ${result.skipped.length} skipped.` : '.'),
                      );
                    })
                  }
                >
                  Apply {changes ? `${changes} change(s)` : ''}
                </Button>
                {latest && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act(async () => {
                        const result = await unwrap(api().skills.syncRollback(latest.batchId));
                        setNotice(
                          `Rolled back ${result.restored.length} folder(s)` +
                            (result.skipped.length
                              ? `; ${result.skipped.length} changed since and left alone.`
                              : '.'),
                        );
                      })
                    }
                  >
                    Roll back last sync ({formatDateTime(latest.appliedAt)})
                  </Button>
                )}
              </div>
            )}
            {plan && (
              <ul
                className="flex flex-col gap-1 text-xs"
                aria-label={`${PROVIDER_NAMES[provider]} sync preview`}
              >
                {plan.items.length === 0 && (
                  <li className="text-muted-foreground">Nothing to synchronize.</li>
                )}
                {plan.items.map((item) => (
                  <li
                    key={`${item.action}:${item.dirName}`}
                    className="flex min-w-0 flex-wrap items-center gap-2"
                    data-testid="skill-sync-item"
                    data-action={item.action}
                  >
                    <Badge
                      className={cn(
                        item.action === 'conflict'
                          ? 'bg-destructive/15 text-destructive'
                          : item.action === 'unchanged'
                            ? 'bg-muted text-muted-foreground'
                            : 'bg-sky-500/15 text-sky-300',
                      )}
                    >
                      {SYNC_ACTION_LABELS[item.action]}
                    </Badge>
                    <code>{item.dirName}</code>
                    <span className="text-muted-foreground">{item.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
