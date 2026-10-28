import type { HostingAccount, HostingRemote, HostingRepositoryScan } from '@atlas/contracts';
import { FolderGit2, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { ACCESS_LABELS, ASSIGNMENT_LABELS, PROVIDER_LABELS, REMOTE_KIND_LABELS } from '../format';

const AUTOMATIC = '__automatic__';

/** The account choice of one remote; automatic unless the user picked one (FR-002). */
function AccountSelect({
  remote,
  accounts,
  onChange,
}: {
  remote: HostingRemote;
  accounts: HostingAccount[];
  onChange: (accountId: string | null) => void;
}) {
  // An unknown alias can be any provider: choosing an account tells which one.
  const options =
    remote.kind === 'UNRESOLVED_ALIAS'
      ? accounts
      : accounts.filter((account) => account.provider === remote.provider);
  const manual = remote.assignment === 'MANUAL';
  const automaticLabel =
    !manual && remote.accountId !== null
      ? `Automatic: ${accounts.find((account) => account.id === remote.accountId)?.label ?? '—'}`
      : remote.ambiguous
        ? 'Choose an account'
        : 'Automatic';
  return (
    <Select
      value={manual && remote.accountId !== null ? remote.accountId : AUTOMATIC}
      onValueChange={(value) => onChange(value === AUTOMATIC ? null : value)}
      disabled={options.length === 0 || remote.removed}
    >
      <SelectTrigger
        className="h-8 w-full sm:w-56"
        aria-label={`Account for ${remote.projectName} ${remote.remoteName}`}
        data-testid="hosting-remote-account"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTOMATIC}>{automaticLabel}</SelectItem>
        {options.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.label} ({PROVIDER_LABELS[account.provider]})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The remotes of every registered project and the account each one uses (SDD-024 Task 04,
 * FR-001, FR-004). Reading them needs no network; "Check access" asks the providers.
 */
export function RepositoriesPanel({
  scan,
  accounts,
  loading,
  onScan,
}: {
  scan: HostingRepositoryScan | null;
  accounts: HostingAccount[];
  loading: boolean;
  onScan: (next: HostingRepositoryScan | null) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<HostingRepositoryScan | null>) => {
    setError(null);
    try {
      onScan(await action());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const checkAccess = async () => {
    setChecking(true);
    await run(() => unwrap(api().hosting.checkAccess({})));
    setChecking(false);
  };

  const remotes = scan?.remotes ?? [];
  const supported = remotes.filter((remote) => remote.kind === 'SUPPORTED' && !remote.removed);
  const connected = accounts.some((account) => account.hasCredential);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="hosting-repositories-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="hosting-repositories-title" className="min-w-0 flex-1 text-sm font-semibold">
          Repositories
        </h2>
        <Button
          variant="outline"
          size="sm"
          disabled={checking || loading || supported.length === 0 || !connected}
          onClick={() => void checkAccess()}
          title={
            connected
              ? 'Ask the providers which accounts can read each repository'
              : 'Add an account with a token first'
          }
          data-testid="hosting-check-access"
        >
          <ShieldCheck className={cn(checking && 'animate-pulse')} />
          {checking ? 'Checking…' : 'Check access'}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {scan === null ? (
        <p className="text-muted-foreground text-sm">{loading ? 'Reading remotes…' : ''}</p>
      ) : remotes.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center">
          <FolderGit2 className="text-muted-foreground size-6" aria-hidden="true" />
          <p className="text-sm font-medium">No Git remotes found</p>
          <p className="text-muted-foreground max-w-md text-xs">
            Registered projects with a GitHub or Bitbucket Cloud remote are listed here.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Project remotes">
          {remotes.map((remote) => (
            <li
              key={`${remote.projectId}:${remote.remoteName}`}
              className={cn(
                'flex flex-col gap-2 rounded-lg border p-3 lg:flex-row lg:items-center',
                remote.removed && 'opacity-70',
              )}
              data-testid="hosting-remote"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="truncate font-medium">{remote.projectName}</span>
                  <span className="text-muted-foreground">{remote.remoteName}</span>
                  {remote.provider && (
                    <Badge variant="outline">{PROVIDER_LABELS[remote.provider]}</Badge>
                  )}
                  {remote.kind !== 'SUPPORTED' && (
                    <Badge variant="outline" data-testid="hosting-remote-kind">
                      {REMOTE_KIND_LABELS[remote.kind]}
                    </Badge>
                  )}
                  {remote.removed && <Badge variant="outline">Removed from the project</Badge>}
                </div>
                <p
                  className="text-muted-foreground truncate font-mono text-xs"
                  title={remote.remoteUrl}
                >
                  {remote.owner && remote.name
                    ? `${remote.owner}/${remote.name}`
                    : remote.remoteUrl}
                  {remote.sshAlias && ` · via ${remote.sshAlias}`}
                  {remote.sshAlias && remote.host && ` → ${remote.host}`}
                </p>
                {remote.kind === 'SUPPORTED' && (
                  <p className="text-muted-foreground text-xs" data-testid="hosting-remote-status">
                    {remote.assignment
                      ? ASSIGNMENT_LABELS[remote.assignment]
                      : remote.ambiguous
                        ? 'Several accounts could be used: check access or choose one.'
                        : 'No account for this provider yet.'}
                    {remote.accountId !== null && ` · ${ACCESS_LABELS[remote.access]}`}
                  </p>
                )}
                {remote.kind === 'UNRESOLVED_ALIAS' && (
                  <p className="text-muted-foreground text-xs">
                    ATLAS could not find this alias in ~/.ssh/config. Add it to an account, or
                    choose the account here.
                  </p>
                )}
              </div>
              {(remote.kind === 'SUPPORTED' || remote.kind === 'UNRESOLVED_ALIAS') &&
                !remote.removed && (
                  <AccountSelect
                    remote={remote}
                    accounts={accounts}
                    onChange={(accountId) =>
                      void run(async () => {
                        await unwrap(
                          api().hosting.setRemoteAccount({
                            projectId: remote.projectId,
                            remoteName: remote.remoteName,
                            accountId,
                          }),
                        );
                        return unwrap(api().hosting.repositories());
                      })
                    }
                  />
                )}
              {remote.removed && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    void run(async () => {
                      await unwrap(
                        api().hosting.dismissRemote({
                          projectId: remote.projectId,
                          remoteName: remote.remoteName,
                        }),
                      );
                      return unwrap(api().hosting.repositories());
                    })
                  }
                >
                  <X />
                  Dismiss
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {scan !== null && scan.skipped.length > 0 && (
        <ul
          className="text-muted-foreground flex flex-col gap-0.5 text-xs"
          aria-label="Skipped projects"
        >
          {scan.skipped.map((item) => (
            <li key={item.projectId}>
              {item.projectName}: {item.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
