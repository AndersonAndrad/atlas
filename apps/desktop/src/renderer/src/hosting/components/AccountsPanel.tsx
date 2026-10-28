import type { HostingAccount, HostingCredentialStoreStatus } from '@atlas/contracts';
import { KeyRound, Pencil, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ACCOUNT_STATE_LABELS, PROVIDER_LABELS, accountStateTone } from '../format';
import { AccountDialog, type AccountDialogMode } from './AccountDialog';

/** Hosting accounts: add, test, edit, replace the token, remove (SDD-024 Task 04, FR-002). */
export function AccountsPanel({
  accounts,
  store,
  onChanged,
}: {
  accounts: HostingAccount[];
  store: HostingCredentialStoreStatus | null;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<AccountDialogMode | null>(null);
  const [removing, setRemoving] = useState<HostingAccount | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storeAvailable = store?.available ?? false;

  const test = async (account: HostingAccount) => {
    setTesting(account.id);
    setError(null);
    try {
      await unwrap(api().hosting.testAccount(account.id));
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setTesting(null);
    }
  };

  const remove = async (account: HostingAccount) => {
    setError(null);
    try {
      await unwrap(api().hosting.removeAccount(account.id));
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="hosting-accounts-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="hosting-accounts-title" className="min-w-0 flex-1 text-sm font-semibold">
          Accounts
        </h2>
        <Button
          size="sm"
          onClick={() => setDialog({ kind: 'add' })}
          disabled={!storeAvailable}
          data-testid="hosting-add-account"
        >
          <Plus />
          Add account
        </Button>
      </div>
      {store !== null && !store.available && (
        <Alert role="status" data-testid="hosting-store-unavailable">
          <AlertDescription>{store.reason}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {accounts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center">
          <UserRound className="text-muted-foreground size-6" aria-hidden="true" />
          <p className="text-sm font-medium">No accounts connected</p>
          <p className="text-muted-foreground max-w-md text-xs">
            Add a GitHub or Bitbucket Cloud account with a read-only token. Several accounts per
            provider are supported, for example personal and work.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Hosting accounts">
          {accounts.map((account) => {
            const tone = accountStateTone(account.state);
            return (
              <li
                key={account.id}
                className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start"
                data-testid="hosting-account"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{account.label}</span>
                    <Badge variant="outline">{PROVIDER_LABELS[account.provider]}</Badge>
                    <Badge
                      variant="outline"
                      className={cn(
                        tone === 'ok' &&
                          'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
                        tone === 'problem' && 'border-destructive/40 text-destructive',
                      )}
                      data-testid="hosting-account-state"
                    >
                      {ACCOUNT_STATE_LABELS[account.state]}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground truncate text-xs">
                    {[
                      account.login && `@${account.login}`,
                      account.displayName,
                      account.email,
                      account.sshAliases.length > 0 && `SSH: ${account.sshAliases.join(', ')}`,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Not tested yet'}
                  </p>
                  {account.stateMessage && (
                    <p className="text-destructive text-xs" data-testid="hosting-account-message">
                      {account.stateMessage}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap gap-1">
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={testing !== null}
                    onClick={() => void test(account)}
                  >
                    <RefreshCw className={cn(testing === account.id && 'animate-spin')} />
                    {testing === account.id ? 'Testing…' : 'Test'}
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={!storeAvailable}
                    onClick={() => setDialog({ kind: 'token', account })}
                  >
                    <KeyRound />
                    Token…
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Edit ${account.label}`}
                    onClick={() => setDialog({ kind: 'edit', account })}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${account.label}`}
                    onClick={() => setRemoving(account)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {dialog && (
        <AccountDialog
          mode={dialog}
          storeAvailable={storeAvailable}
          onClose={() => {
            setDialog(null);
            onChanged();
          }}
          onSaved={() => {
            setDialog(null);
            onChanged();
          }}
        />
      )}
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its token is deleted from this computer and repositories using it return to automatic
              assignment. The token itself stays valid at the provider; revoke it there if you no
              longer need it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removing) void remove(removing);
                setRemoving(null);
              }}
            >
              Remove account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
