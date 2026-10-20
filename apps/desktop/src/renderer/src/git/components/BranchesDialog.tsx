import type { GitBranchList, GitOperation, GitWorkingTree } from '@atlas/contracts';
import { ArrowDown, ArrowUp, Check, Copy, Pencil } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { copyText } from '@/lib/clipboard';
import { OperationResult } from './OperationsPanel';

interface BranchesDialogProps {
  tree: GitWorkingTree;
  onClose: () => void;
}

const HEAD = '__head__';

type PendingSwitch = { name: string; kind: 'local' | 'remote' } | null;

/** Lightweight branch management: list, create, switch, rename and copy names. */
export function BranchesDialog({ tree, onClose }: BranchesDialogProps) {
  const id = useId();
  const [branches, setBranches] = useState<GitBranchList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<GitOperation | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [create, setCreate] = useState({ name: '', startPoint: HEAD, switchTo: true });
  const [copied, setCopied] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setBranches(await unwrap(api().git.branches(tree.repositoryRoot)));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [tree.repositoryRoot]);
  useEffect(() => {
    void (async () => {
      await reload();
    })();
  }, [reload]);

  const hasLocalChanges = tree.files.some((file) => file.unstaged !== 'untracked');

  async function run(action: () => Promise<GitOperation>): Promise<GitOperation | null> {
    setBusy(true);
    setError(null);
    try {
      const operation = await action();
      setLast(operation);
      await reload();
      return operation;
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues.length > 0
          ? caught.issues.map((issue) => issue.message).join(' ')
          : errorMessage(caught),
      );
      return null;
    } finally {
      setBusy(false);
    }
  }

  const switchTo = (name: string, kind: 'local' | 'remote', confirmed = false) => {
    if (hasLocalChanges && !confirmed) {
      setPendingSwitch({ name, kind });
      return;
    }
    setPendingSwitch(null);
    void run(() =>
      unwrap(api().git.switchBranch({ repositoryRoot: tree.repositoryRoot, name, kind })),
    );
  };

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    const name = create.name.trim();
    if (name === '') return;
    void run(() =>
      unwrap(
        api().git.createBranch({
          repositoryRoot: tree.repositoryRoot,
          name,
          switchTo: create.switchTo,
          ...(create.startPoint === HEAD ? {} : { startPoint: create.startPoint }),
        }),
      ),
    ).then((operation) => {
      if (operation?.status === 'succeeded') setCreate((current) => ({ ...current, name: '' }));
    });
  };

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    if (renaming === null || renaming.to.trim() === '') return;
    const { from, to } = renaming;
    setRenaming(null);
    void run(() =>
      unwrap(api().git.renameBranch({ repositoryRoot: tree.repositoryRoot, from, to: to.trim() })),
    );
  };

  const copy = (name: string) =>
    void copyText(name).then(
      () => setCopied(name),
      () => undefined,
    );

  const copyButton = (name: string) => (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={`Copy ${name}`}
      title="Copy branch name"
      onClick={() => copy(name)}
    >
      {copied === name ? <Check /> : <Copy />}
    </Button>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-xl" data-testid="branches-dialog">
        <DialogHeader>
          <DialogTitle>Branches</DialogTitle>
          <DialogDescription>
            Current: <strong>{branches?.current ?? tree.branch ?? 'detached HEAD'}</strong>
            {tree.upstream && <> · upstream {tree.upstream}</>}
          </DialogDescription>
        </DialogHeader>

        {pendingSwitch && (
          <Alert role="alertdialog" className="border-warning/40" data-testid="switch-warning">
            <AlertDescription className="flex flex-col gap-2">
              <span>
                You have uncommitted changes. Git carries them to{' '}
                <strong>{pendingSwitch.name}</strong> when it can and refuses otherwise; nothing is
                discarded.
              </span>
              <span className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => switchTo(pendingSwitch.name, pendingSwitch.kind, true)}
                >
                  Switch anyway
                </Button>
                <Button size="sm" variant="outline" onClick={() => setPendingSwitch(null)}>
                  Cancel
                </Button>
              </span>
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="git-dialog-error">{error}</AlertDescription>
          </Alert>
        )}
        {last && (
          <div className="rounded-md border p-3">
            <OperationResult operation={last} />
          </div>
        )}

        <div className="flex max-h-72 min-w-0 flex-col gap-3 overflow-y-auto">
          <section aria-labelledby={`${id}-local`}>
            <h3
              id={`${id}-local`}
              className="text-muted-foreground mb-1 text-[11px] font-semibold tracking-wider uppercase"
            >
              Local
            </h3>
            <ul className="flex flex-col">
              {branches?.local.map((branch) => (
                <li
                  key={branch.name}
                  className="hover:bg-accent/50 flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm"
                  data-testid="local-branch"
                  data-name={branch.name}
                >
                  {renaming?.from === branch.name ? (
                    <form className="flex min-w-0 flex-1 gap-2" onSubmit={submitRename}>
                      <Input
                        autoFocus
                        aria-label={`New name for ${branch.name}`}
                        className="h-7"
                        value={renaming.to}
                        onChange={(event) =>
                          setRenaming({ from: branch.name, to: event.target.value })
                        }
                      />
                      <Button type="submit" size="sm" disabled={busy}>
                        Rename
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setRenaming(null)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {branch.current && <span className="text-success mr-1">●</span>}
                        {branch.name}
                      </span>
                      {branch.upstream && (
                        <span className="text-muted-foreground hidden truncate text-xs sm:inline">
                          {branch.upstream}
                        </span>
                      )}
                      {branch.ahead !== null && (
                        <span className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums">
                          <ArrowUp className="size-3" aria-label="ahead" />
                          {branch.ahead}
                          <ArrowDown className="size-3" aria-label="behind" />
                          {branch.behind}
                        </span>
                      )}
                      {branch.upstreamGone && (
                        <span className="text-warning text-xs">upstream gone</span>
                      )}
                      {!branch.current && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => switchTo(branch.name, 'local')}
                        >
                          Switch
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Rename ${branch.name}`}
                        title="Rename"
                        disabled={busy}
                        onClick={() => setRenaming({ from: branch.name, to: branch.name })}
                      >
                        <Pencil />
                      </Button>
                      {copyButton(branch.name)}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
          {branches && branches.remote.length > 0 && (
            <section aria-labelledby={`${id}-remote`}>
              <h3
                id={`${id}-remote`}
                className="text-muted-foreground mb-1 text-[11px] font-semibold tracking-wider uppercase"
              >
                Remote-tracking
              </h3>
              <ul className="flex flex-col">
                {branches.remote.map((branch) => (
                  <li
                    key={branch.name}
                    className="hover:bg-accent/50 flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm"
                    data-testid="remote-branch"
                    data-name={branch.name}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{branch.name}</span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      title="Creates a local branch that tracks it"
                      onClick={() => switchTo(branch.name, 'remote')}
                    >
                      Check out
                    </Button>
                    {copyButton(branch.name)}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <form
          className="flex flex-col gap-2 border-t pt-3"
          onSubmit={submitCreate}
          aria-labelledby={`${id}-create`}
        >
          <h3 id={`${id}-create`} className="text-sm font-medium">
            New branch
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)]">
            <Input
              aria-label="Branch name"
              placeholder="feature/name"
              value={create.name}
              onChange={(event) =>
                setCreate((current) => ({ ...current, name: event.target.value }))
              }
            />
            <Select
              value={create.startPoint}
              onValueChange={(startPoint) => setCreate((current) => ({ ...current, startPoint }))}
            >
              <SelectTrigger aria-label="Start from">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={HEAD}>Current commit (HEAD)</SelectItem>
                {[...(branches?.local ?? []), ...(branches?.remote ?? [])].map((branch) => (
                  <SelectItem key={branch.name} value={branch.name}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-switch`}
                checked={create.switchTo}
                onCheckedChange={(checked) =>
                  setCreate((current) => ({ ...current, switchTo: checked === true }))
                }
              />
              <Label htmlFor={`${id}-switch`} className="font-normal">
                Switch to it
              </Label>
            </div>
            <Button type="submit" disabled={busy || create.name.trim() === ''}>
              Create branch
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
