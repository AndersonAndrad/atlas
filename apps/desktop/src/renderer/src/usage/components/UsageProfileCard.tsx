import type { UsageProfile, UsageProfileReport } from '@atlas/contracts';
import { EllipsisVertical, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { STATUS_LABELS, primaryWindows, relativeTime } from '../format';
import { LimitMeter } from './LimitMeter';

export interface ProfileActions {
  refresh: (profile: UsageProfile) => void;
  rename: (profile: UsageProfile) => void;
  update: (
    profile: UsageProfile,
    changes: { hidden?: boolean; statusLineEnabled?: boolean },
  ) => void;
  remove: (profile: UsageProfile) => void;
}

/** Why a profile shows no limit bar; never a made-up percentage. */
function missingLimitsReason(report: UsageProfileReport): string {
  const { profile } = report;
  if (profile.lastError !== null) return profile.lastError.message;
  if (profile.status === 'AUTH_REQUIRED') return 'Sign in to this profile to see its limits.';
  if (profile.providerId === 'claude') {
    return profile.statusLineEnabled
      ? 'Limits appear after a Claude Code session started in an ATLAS terminal gets its first answer (Pro and Max plans).'
      : 'The ATLAS status line is off for this profile, so its limits are not read.';
  }
  return 'Codex did not report limits for this account.';
}

/**
 * One account profile: the current session window and the weekly window side by side,
 * or only the window the provider reports.
 */
export function UsageProfileCard({
  report,
  now,
  actions,
}: {
  report: UsageProfileReport;
  now: Date;
  actions: ProfileActions;
}) {
  const { profile } = report;
  const { session, weekly, others } = primaryWindows(report);
  const hasLimits = session !== null || weekly !== null || others.length > 0;
  return (
    <article
      className="flex min-w-0 flex-col gap-3 rounded-lg border p-3"
      aria-label={`${profile.displayName} usage`}
      data-testid="usage-profile"
      data-profile-id={profile.id}
    >
      <header className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <h3 className="truncate font-medium" data-testid="usage-profile-name">
            {profile.displayName}
          </h3>
          <p className="text-muted-foreground truncate text-xs" title={profile.profileDirectory}>
            {[profile.plan, STATUS_LABELS[profile.status]].filter(Boolean).join(' · ')}
            {profile.lastSyncAt && ` · updated ${relativeTime(profile.lastSyncAt, now)}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Refresh ${profile.displayName}`}
            title="Refresh"
            onClick={() => actions.refresh(profile)}
          >
            <RefreshCw />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Actions for ${profile.displayName}`}
              >
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => actions.rename(profile)}>Rename…</DropdownMenuItem>
              {profile.providerId === 'claude' && (
                <DropdownMenuCheckboxItem
                  checked={profile.statusLineEnabled}
                  onCheckedChange={(checked) =>
                    actions.update(profile, { statusLineEnabled: checked === true })
                  }
                >
                  Read limits with the ATLAS status line
                </DropdownMenuCheckboxItem>
              )}
              <DropdownMenuSeparator />
              {profile.hidden ? (
                <DropdownMenuItem onSelect={() => actions.update(profile, { hidden: false })}>
                  Show
                </DropdownMenuItem>
              ) : profile.origin === 'added' ? (
                <DropdownMenuItem variant="destructive" onSelect={() => actions.remove(profile)}>
                  Remove from ATLAS
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => actions.update(profile, { hidden: true })}>
                  Hide
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {hasLimits ? (
        <div className="flex flex-col gap-3">
          {session && <LimitMeter window={session} now={now} />}
          {weekly && <LimitMeter window={weekly} now={now} />}
          {others.map((window) => (
            <LimitMeter key={window.key} window={window} now={now} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-1" data-testid="usage-no-limits">
          <div className="flex items-baseline justify-between text-sm">
            <span>Limits</span>
            <span className="font-medium">N/A</span>
          </div>
          <div className="bg-muted h-2 rounded-full" aria-hidden="true" />
          <p className="text-muted-foreground text-xs">{missingLimitsReason(report)}</p>
        </div>
      )}
      {hasLimits && profile.lastError && (
        <p className="text-destructive text-xs" role="status">
          Last refresh failed: {profile.lastError.message}
        </p>
      )}
      {report.coverage === 'atlas-sessions' && (
        <p className="text-muted-foreground text-xs">
          Limits are the provider&apos;s; activity counts only sessions started in ATLAS.
        </p>
      )}
    </article>
  );
}
