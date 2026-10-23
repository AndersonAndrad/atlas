import type { AiProvider, UsageProfile, UsageProfileReport, UsageSource } from '@atlas/contracts';
import { ChartColumn, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useKeyedLoad } from '@/context/hooks/useContextData';
import {
  METRIC_LABELS,
  PROVIDER_LABELS,
  SOURCE_LABELS,
  chartMetric,
  dateRange,
  formatMetric,
} from '../format';
import { DailyUsageChart } from './DailyUsageChart';
import { UsageProfileCard, type ProfileActions } from './UsageProfileCard';

/** The view re-reads the overview this often: Claude Code data arrives during sessions. */
const RELOAD_MS = 60_000;
const PROVIDERS: AiProvider[] = ['claude', 'codex'];
type SourceFilter = 'all' | 'provider' | 'measured' | 'estimated';
const SOURCE_FILTERS: Record<SourceFilter, (source: UsageSource) => boolean> = {
  all: () => true,
  provider: (source) => source === 'PROVIDER_CLI' || source === 'PROVIDER_API',
  measured: (source) => source === 'ATLAS_EXECUTION',
  estimated: (source) => source === 'LOCAL_ESTIMATE',
};

/**
 * Usage (SDD-008 Milestone B): each account profile's provider-reported limit windows
 * (current session and weekly side by side) and its daily and weekly activity.
 */
export function UsageView() {
  const [tick, setTick] = useState(0);
  const [days, setDays] = useState(30);
  const [provider, setProvider] = useState<'all' | AiProvider>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<UsageProfile | null>(null);
  const [removing, setRemoving] = useState<UsageProfile | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), RELOAD_MS);
    // Opening the view collects (or waits for the collection already running); the Engine
    // skips profiles collected in the last minute.
    void (async () => {
      await api().usage.refresh(null);
      setTick((value) => value + 1);
    })();
    return () => clearInterval(timer);
  }, []);
  const overview = useKeyedLoad(`usage:${days}:${tick}`, () => api().usage.overview({ days }));
  const now = overview.value ? new Date(overview.value.generatedAt) : new Date();

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      setTick((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function refresh(profileId: string | null) {
    setBusy(true);
    await act(() => unwrap(api().usage.refresh(profileId)));
    setBusy(false);
  }

  async function addProfile(providerId: AiProvider) {
    await act(async () => {
      const choice = await unwrap(api().dialog.chooseDirectory('usage-profile'));
      if (choice.canceled || !choice.inspection) return;
      const directory = choice.inspection.resolvedPath ?? choice.inspection.inputPath;
      const profile = await unwrap(api().usage.addProfile({ providerId, directory }));
      await unwrap(api().usage.refresh(profile.id));
    });
  }

  const actions: ProfileActions = {
    refresh: (profile) => void refresh(profile.id),
    rename: (profile) => {
      setRenaming(profile);
      setName(profile.displayName);
    },
    update: (profile, changes) =>
      void act(() => unwrap(api().usage.updateProfile(profile.id, changes))),
    remove: (profile) => setRemoving(profile),
  };

  const reports = (overview.value?.profiles ?? []).filter(
    (report) =>
      (showHidden || !report.profile.hidden) &&
      (provider === 'all' || report.profile.providerId === provider),
  );
  const hiddenCount = (overview.value?.profiles ?? []).filter(
    (report) => report.profile.hidden,
  ).length;
  const settings = overview.value?.settings;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="usage-view">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">Usage</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh(null)}>
            <RefreshCw className={busy ? 'animate-spin' : undefined} />
            Refresh
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus />
                Add profile
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {PROVIDERS.map((id) => (
                <DropdownMenuItem key={id} onSelect={() => void addProfile(id)}>
                  {PROVIDER_LABELS[id]} configuration folder…
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
          <Select value={provider} onValueChange={(value) => setProvider(value as typeof provider)}>
            <SelectTrigger size="sm" className="w-40" aria-label="Provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All providers</SelectItem>
              {PROVIDERS.map((id) => (
                <SelectItem key={id} value={id}>
                  {PROVIDER_LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
            <SelectTrigger size="sm" className="w-36" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={sourceFilter}
            onValueChange={(value) => setSourceFilter(value as SourceFilter)}
          >
            <SelectTrigger size="sm" className="w-44" aria-label="Source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="provider">Provider-reported</SelectItem>
              <SelectItem value="measured">Measured locally</SelectItem>
              <SelectItem value="estimated">Estimated</SelectItem>
            </SelectContent>
          </Select>
          {settings && (
            <Select
              value={String(settings.refreshMinutes)}
              onValueChange={(value) =>
                void act(() => unwrap(api().usage.setSettings({ refreshMinutes: Number(value) })))
              }
            >
              <SelectTrigger size="sm" className="w-48" aria-label="Automatic refresh">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Automatic refresh off</SelectItem>
                {[5, 10, 30, 60].map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    Refresh every {minutes} min
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {hiddenCount > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setShowHidden((value) => !value)}>
              {showHidden ? 'Hide hidden profiles' : `Show hidden (${hiddenCount})`}
            </Button>
          )}
        </div>

        {(error ?? overview.error) && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error ?? overview.error}</AlertDescription>
          </Alert>
        )}

        {overview.value && reports.length === 0 && (
          <div
            className="text-muted-foreground flex flex-col items-center gap-2 p-8 text-center text-sm"
            data-testid="usage-empty"
          >
            <ChartColumn className="size-8" aria-hidden="true" />
            <p className="text-foreground font-medium">No account profiles found</p>
            <p className="max-w-md">
              ATLAS finds ~/.claude, ~/.codex and folders named like ~/.claude-work or
              ~/.codex-personal. Add another configuration folder with Add profile.
            </p>
          </div>
        )}

        {PROVIDERS.filter((id) => reports.some((report) => report.profile.providerId === id)).map(
          (id) => (
            <section key={id} className="flex flex-col gap-2" aria-label={PROVIDER_LABELS[id]}>
              <h2 className="text-muted-foreground text-sm font-medium">{PROVIDER_LABELS[id]}</h2>
              <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {reports
                  .filter((report) => report.profile.providerId === id)
                  .map((report) => (
                    <UsageProfileCard
                      key={report.profile.id}
                      report={report}
                      now={now}
                      actions={actions}
                    />
                  ))}
              </div>
            </section>
          ),
        )}

        {reports.length > 0 && (
          <section className="flex flex-col gap-3" aria-label="Usage history">
            <h2 className="text-muted-foreground text-sm font-medium">History</h2>
            <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
              {reports.map((report) => (
                <UsageHistory
                  key={report.profile.id}
                  report={report}
                  days={days}
                  now={now}
                  accepts={SOURCE_FILTERS[sourceFilter]}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.displayName} from ATLAS?</AlertDialogTitle>
            <AlertDialogDescription>
              Its usage history in ATLAS is deleted. The provider&apos;s files and sign-in in{' '}
              {removing?.profileDirectory} are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const profile = removing;
                if (profile !== null) {
                  void act(() => unwrap(api().usage.removeProfile(profile.id)));
                }
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename profile</DialogTitle>
            <DialogDescription>Only ATLAS uses this name.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const profile = renaming;
              if (profile === null) return;
              setRenaming(null);
              void act(() => unwrap(api().usage.updateProfile(profile.id, { displayName: name })));
            }}
          >
            <Label htmlFor="usage-profile-name">Name</Label>
            <Input
              id="usage-profile-name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={name.trim() === ''}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function UsageHistory({
  report,
  days,
  now,
  accepts,
}: {
  report: UsageProfileReport;
  days: number;
  now: Date;
  accepts: (source: UsageSource) => boolean;
}) {
  const metric = chartMetric(report.profile.providerId);
  const daily = report.daily.filter((value) => accepts(value.source));
  const weekly = report.weekly.filter((value) => accepts(value.source)).reverse();
  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-lg border p-3"
      aria-label={`${report.profile.displayName} history`}
      data-testid="usage-history"
    >
      <h3 className="text-sm font-medium">
        {report.profile.displayName}{' '}
        <span className="text-muted-foreground font-normal">
          · {PROVIDER_LABELS[report.profile.providerId]}
          {report.coverage === 'atlas-sessions' ? ' · ATLAS sessions only' : ' · whole account'}
        </span>
      </h3>
      <DailyUsageChart metric={metric} dates={dateRange(days, now)} values={daily} />
      {weekly.length > 0 && (
        <table className="w-full text-xs" data-testid="usage-weekly">
          <caption className="text-muted-foreground mb-1 text-left">
            Weekly totals (calendar weeks, Monday to Sunday)
          </caption>
          <thead className="text-muted-foreground text-left">
            <tr>
              <th className="font-normal">Week of</th>
              <th className="font-normal">Metric</th>
              <th className="text-right font-normal">Total</th>
              <th className="pl-2 font-normal">Source</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {weekly.map((week) => (
              <tr key={`${week.weekStart}:${week.metric}:${week.source}`} className="border-t">
                <td className="py-1">{week.weekStart}</td>
                <td>{METRIC_LABELS[week.metric]}</td>
                <td className="text-right">{formatMetric(week.metric, week.value)}</td>
                <td className="text-muted-foreground pl-2">{SOURCE_LABELS[week.source]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
