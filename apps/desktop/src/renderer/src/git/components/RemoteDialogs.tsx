import type {
  BackgroundJob,
  GitPullInfo,
  GitPullInput,
  GitRemote,
  GitWorkingTree,
} from '@atlas/contracts';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { plural } from '../format';

interface RemoteDialogProps {
  tree: GitWorkingTree;
  onClose: () => void;
  /**
   * The Engine accepted the operation as a background job (SDD-025): the dialog is done and
   * the job keeps running whatever happens to it. Refusals stay in the dialog.
   */
  onSubmitted: (job: BackgroundJob) => void;
}

/** Submits a confirmed action as a background job; the dialog stays open on refusal. */
function useRemoteAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    action: () => Promise<BackgroundJob>,
    onSubmitted: (job: BackgroundJob) => void,
  ) => {
    // A second click while the first submission is pending submits nothing.
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSubmitted(await action());
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues.length > 0
          ? caught.issues.map((issue) => issue.message).join(' ')
          : errorMessage(caught),
      );
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Outcome({ error }: { error: string | null }) {
  return error ? (
    <Alert variant="destructive" role="alert">
      <AlertDescription data-testid="git-dialog-error">{error}</AlertDescription>
    </Alert>
  ) : null;
}

function Route({ from, to, icon }: { from: string; to: string; icon: ReactNode }) {
  return (
    <p
      className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-sm"
      data-testid="git-route"
    >
      <span className="truncate">{from}</span>
      {icon}
      <span className="truncate">{to}</span>
    </p>
  );
}

/** Push the current branch to its upstream, or to an explicitly chosen destination. */
export function PushDialog({ tree, onClose, onSubmitted }: RemoteDialogProps) {
  const id = useId();
  const needsDestination = tree.upstream === null || tree.upstreamGone;
  const [remotes, setRemotes] = useState<GitRemote[] | null>(null);
  const [remote, setRemote] = useState('');
  const [branch, setBranch] = useState(tree.branch ?? '');
  const { busy, error, run } = useRemoteAction();

  useEffect(() => {
    if (!needsDestination) return;
    let cancelled = false;
    unwrap(api().git.remotes(tree.repositoryRoot)).then(
      (list) => {
        if (cancelled) return;
        setRemotes(list);
        setRemote((list.find((item) => item.name === 'origin') ?? list[0])?.name ?? '');
      },
      () => !cancelled && setRemotes([]),
    );
    return () => {
      cancelled = true;
    };
  }, [needsDestination, tree.repositoryRoot]);

  const ready =
    tree.branch !== null && (!needsDestination || (remote !== '' && branch.trim() !== ''));
  const push = () =>
    run(
      () =>
        unwrap(
          api().jobs.create({
            type: 'GIT',
            action: 'push',
            repositoryRoot: tree.repositoryRoot,
            ...(needsDestination ? { setUpstream: { remote, branch: branch.trim() } } : {}),
          }),
        ),
      onSubmitted,
    );

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="push-dialog">
        <DialogHeader>
          <DialogTitle>Push</DialogTitle>
          <DialogDescription>
            Ordinary push only; ATLAS never force-pushes. It runs in the background once started.
          </DialogDescription>
        </DialogHeader>
        {tree.branch === null ? (
          <p className="text-sm">Switch to a branch before pushing (HEAD is detached).</p>
        ) : needsDestination ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm">
              <strong>{tree.branch}</strong> has no upstream. Choose where to publish it; it becomes
              the upstream.
            </legend>
            {remotes !== null && remotes.length === 0 ? (
              <p className="text-warning text-sm">No remote is configured in this repository.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]">
                <Select value={remote} onValueChange={setRemote}>
                  <SelectTrigger aria-label="Remote" id={`${id}-remote`}>
                    <SelectValue placeholder="Remote" />
                  </SelectTrigger>
                  <SelectContent>
                    {(remotes ?? []).map((item) => (
                      <SelectItem key={item.name} value={item.name}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  aria-label="Remote branch"
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                />
              </div>
            )}
            {remote !== '' && branch.trim() !== '' && (
              <Route
                from={tree.branch}
                to={`${remote}/${branch.trim()}`}
                icon={<ArrowUp className="size-4" aria-hidden="true" />}
              />
            )}
          </fieldset>
        ) : (
          <div className="flex flex-col gap-1">
            <Route
              from={tree.branch}
              to={tree.upstream!}
              icon={<ArrowUp className="size-4" aria-hidden="true" />}
            />
            <p className="text-muted-foreground text-sm" data-testid="push-ahead">
              {tree.ahead === null
                ? 'Commit count unknown.'
                : tree.ahead === 0
                  ? 'No local commits to push (as of the last fetch).'
                  : `${plural(tree.ahead, 'commit')} to push.`}
            </p>
          </div>
        )}
        <Outcome error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void push()} disabled={!ready || busy}>
            {busy ? 'Starting…' : 'Push'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const STRATEGY_TEXT: Record<GitPullInfo['configuredStrategy'], string> = {
  merge: 'Merge: creates a merge commit when the branches diverged.',
  rebase: 'Rebase: replays your local commits on top of the upstream.',
  'ff-only': 'Fast-forward only, as configured in Git.',
  unset:
    'Not configured: Git refuses to pull diverged branches until pull.rebase or pull.ff is set.',
};

/** Pull with an explanation of what will happen; fast-forward only by default. */
export function PullDialog({ tree, onClose, onSubmitted }: RemoteDialogProps) {
  const id = useId();
  const [info, setInfo] = useState<GitPullInfo | null>(null);
  const [mode, setMode] = useState<GitPullInput['mode']>('ff-only');
  const { busy, error, run } = useRemoteAction();

  useEffect(() => {
    let cancelled = false;
    unwrap(api().git.pullInfo(tree.repositoryRoot)).then(
      (value) => !cancelled && setInfo(value),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [tree.repositoryRoot]);

  const ready = tree.branch !== null && tree.upstream !== null && !tree.upstreamGone;
  const pull = () =>
    run(
      () =>
        unwrap(
          api().jobs.create({
            type: 'GIT',
            action: 'pull',
            repositoryRoot: tree.repositoryRoot,
            mode,
          }),
        ),
      onSubmitted,
    );
  const options: { value: GitPullInput['mode']; title: string; text: string }[] = [
    {
      value: 'ff-only',
      title: 'Fast-forward only (recommended)',
      text: 'Updates the branch only when it has no commits the upstream lacks. Never creates a merge commit.',
    },
    {
      value: 'configured',
      title: 'Use the repository configuration',
      text: info ? STRATEGY_TEXT[info.configuredStrategy] : 'Reading the configuration…',
    },
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="pull-dialog">
        <DialogHeader>
          <DialogTitle>Pull</DialogTitle>
          <DialogDescription>
            Conflicts stop the pull for you to resolve; ATLAS never discards local changes.
          </DialogDescription>
        </DialogHeader>
        {!ready ? (
          <p className="text-sm">
            {tree.branch === null
              ? 'Switch to a branch before pulling.'
              : 'This branch has no upstream branch to pull from.'}
          </p>
        ) : (
          <>
            <Route
              from={tree.upstream!}
              to={tree.branch!}
              icon={<ArrowDown className="size-4" aria-hidden="true" />}
            />
            <p className="text-muted-foreground text-sm" data-testid="pull-behind">
              {tree.behind === null || tree.behind === 0
                ? 'No upstream commits known yet. Fetch first to see new commits.'
                : `${plural(tree.behind, 'commit')} to pull (as of the last fetch).`}
            </p>
            {info?.hasLocalChanges && (
              <Alert role="status" className="border-warning/40">
                <AlertDescription>
                  You have uncommitted changes. Git refuses the pull if they would be overwritten;
                  nothing is discarded.
                </AlertDescription>
              </Alert>
            )}
            <fieldset className="flex flex-col gap-2" aria-label="Pull mode">
              {options.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    'flex cursor-pointer gap-3 rounded-md border p-3 text-sm',
                    mode === option.value && 'border-sidebar-primary bg-accent/40',
                  )}
                >
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    value={option.value}
                    checked={mode === option.value}
                    onChange={() => setMode(option.value)}
                    className="accent-sidebar-primary mt-0.5"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{option.title}</span>
                    <span className="text-muted-foreground text-xs">{option.text}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </>
        )}
        <Outcome error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void pull()} disabled={!ready || busy}>
            {busy ? 'Starting…' : 'Pull'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
