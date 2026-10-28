import type {
  HostingAccount,
  HostingCredentialStoreStatus,
  HostingRepositoryScan,
} from '@atlas/contracts';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { AccountsPanel } from './AccountsPanel';
import { RepositoriesPanel } from './RepositoriesPanel';

/**
 * Pull Request Center (SDD-024 Task 04). Milestone A: hosting accounts and the repositories
 * of registered projects; pull requests come with Milestone B.
 */
export function PullRequestsView() {
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [store, setStore] = useState<HostingCredentialStoreStatus | null>(null);
  const [scan, setScan] = useState<HostingRepositoryScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextStore, nextAccounts, nextScan] = await Promise.all([
        unwrap(api().hosting.credentialStatus()),
        unwrap(api().hosting.accounts()),
        unwrap(api().hosting.repositories()),
      ]);
      setStore(nextStore);
      setAccounts(nextAccounts);
      setScan(nextScan);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const accountsWithProblems = accounts.filter(
    (account) => account.state !== 'CONNECTED' && account.state !== 'UNVERIFIED',
  ).length;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="pull-requests-view">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">Pull requests</h1>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void load()}
          aria-label="Refresh accounts and repositories"
        >
          <RefreshCw className={cn(loading && 'animate-spin')} />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            Connect your GitHub and Bitbucket Cloud accounts and check which one each project uses.
            Pull request lists come next.
          </p>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Tabs defaultValue="repositories">
            <TabsList>
              <TabsTrigger value="repositories">Repositories</TabsTrigger>
              <TabsTrigger value="accounts">
                Accounts
                {accountsWithProblems > 0 && (
                  <span
                    className="bg-destructive ml-1 size-1.5 rounded-full"
                    aria-label={`${accountsWithProblems} need attention`}
                  />
                )}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="repositories" className="pt-3">
              <RepositoriesPanel
                scan={scan}
                accounts={accounts}
                loading={loading}
                onScan={(next) => {
                  if (next !== null) setScan(next);
                }}
              />
            </TabsContent>
            <TabsContent value="accounts" className="pt-3">
              <AccountsPanel accounts={accounts} store={store} onChanged={() => void load()} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </main>
  );
}
