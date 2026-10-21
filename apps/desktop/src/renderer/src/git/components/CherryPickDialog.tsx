import type {
  GitBranchList,
  GitCherryPickPreview,
  GitOperation,
  GitWorkingTree,
} from '@atlas/contracts';
import { Check, CircleCheck, Copy, GitCommitHorizontal, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { relativeTime } from '@/components/git/git-format';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { plural } from '../format';
import { BranchPicker } from './BranchPicker';

interface CherryPickDialogProps {
  tree: GitWorkingTree;
  onClose: () => void;
}

/**
 * Brings chosen commits of another branch into the current one, one new commit each
 * with the original message and author (a normal `git cherry-pick`). Commits whose
 * changes the current branch already has cannot be chosen.
 */
export function CherryPickDialog({ tree, onClose }: CherryPickDialogProps) {
  const [branches, setBranches] = useState<GitBranchList | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [preview, setPreview] = useState<GitCherryPickPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [recordOrigin, setRecordOrigin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GitOperation | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    unwrap(api().git.branches(tree.repositoryRoot)).then(
      (list) => !cancelled && setBranches(list),
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [tree.repositoryRoot]);

  useEffect(() => {
    if (branch === null) return;
    let cancelled = false;
    unwrap(api().git.cherryPickPreview({ repositoryRoot: tree.repositoryRoot, branch })).then(
      (value) => {
        if (cancelled) return;
        setPreview(value);
        setSelected([]);
      },
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    );
    return () => {
      cancelled = true;
    };
  }, [branch, tree.repositoryRoot]);

  const current = branches?.current ?? tree.branch;
  const local = branches?.local.filter((candidate) => candidate.name !== current) ?? [];
  const remote = branches?.remote ?? [];
  const dirty = tree.files.some(
    (file) => file.staged !== null || (file.unstaged !== null && file.unstaged !== 'untracked'),
  );
  const shown = preview?.branch === branch ? preview : null;
  const chosen = shown?.commits.filter((commit) => selected.includes(commit.hash)) ?? [];
  const unconventional = chosen.filter((commit) => !commit.conventional).length;

  async function cherryPick() {
    if (branch === null || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setResult(
        await unwrap(
          api().git.cherryPick({
            repositoryRoot: tree.repositoryRoot,
            branch,
            // Applied in the source branch's order, whatever the order of selection.
            commits: chosen.map((commit) => commit.hash),
            recordOrigin,
          }),
        ),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues.length > 0
          ? caught.issues.map((issue) => issue.message).join(' ')
          : errorMessage(caught),
      );
    } finally {
      setBusy(false);
    }
  }

  const stopped = result?.status === 'failed' ? result.error : null;
  const stoppedText = stopped
    ? [stopped.message, stopped.output].filter((part) => part !== null && part !== '').join('\n\n')
    : '';

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="cherry-pick-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCommitHorizontal className="size-4" aria-hidden="true" />
            Cherry-pick into {current ?? 'the current branch'}
          </DialogTitle>
          <DialogDescription>
            Copies chosen commits of another branch onto {current ?? 'this branch'}, one commit each
            with its original message and author. Remote branches are as of the last fetch
            {tree.lastFetchAt ? ` (${relativeTime(tree.lastFetchAt)})` : ' (never fetched)'}.
          </DialogDescription>
        </DialogHeader>

        {result === null && (
          <div className="flex min-w-0 flex-col gap-3">
            <BranchPicker
              label="Take commits from"
              value={branch}
              onChange={setBranch}
              disabled={busy}
              groups={[
                { label: 'Local', names: local.map((candidate) => candidate.name) },
                { label: 'Remote-tracking', names: remote.map((candidate) => candidate.name) },
              ]}
            />
            {shown && shown.commits.length === 0 && (
              <p className="text-muted-foreground text-sm" data-testid="cherry-pick-empty">
                {current} already has every commit of {shown.branch}.
              </p>
            )}
            {shown && shown.commits.length > 0 && (
              <fieldset className="flex min-w-0 flex-col gap-1">
                <legend className="mb-1 text-sm font-medium">
                  Commits of {shown.branch} not on {current} (oldest first)
                </legend>
                {shown.truncated && (
                  <p className="text-muted-foreground text-xs">Only the newest 200 are listed.</p>
                )}
                <ul className="flex max-h-72 min-w-0 flex-col divide-y overflow-y-auto rounded-md border">
                  {shown.commits.map((commit) => (
                    <li
                      key={commit.hash}
                      data-testid="cherry-pick-commit"
                      data-applied={commit.applied}
                    >
                      <label
                        className={cn(
                          'flex min-w-0 items-start gap-2 p-2 text-sm',
                          commit.applied ? 'opacity-60' : 'cursor-pointer',
                        )}
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={selected.includes(commit.hash)}
                          disabled={commit.applied || busy}
                          aria-label={`Pick ${commit.hash.slice(0, 7)} ${commit.subject}`}
                          onCheckedChange={(checked) =>
                            setSelected((value) =>
                              checked === true
                                ? [...value, commit.hash]
                                : value.filter((hash) => hash !== commit.hash),
                            )
                          }
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="min-w-0 break-words">
                            <code className="text-muted-foreground mr-1 font-mono text-xs">
                              {commit.hash.slice(0, 7)}
                            </code>
                            {commit.subject}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {commit.author} · {relativeTime(commit.date)}
                            {commit.applied ? ` · already on ${current}` : ''}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={recordOrigin}
                onCheckedChange={(checked) => setRecordOrigin(checked === true)}
                data-testid="cherry-pick-record-origin"
              />
              <span className="flex flex-col">
                <span>Record where each commit came from</span>
                <span className="text-muted-foreground text-xs">
                  Adds “(cherry picked from commit …)” to the message (git cherry-pick -x).
                </span>
              </span>
            </label>
            {chosen.length > 0 && (
              <p className="text-sm" data-testid="cherry-pick-summary">
                {plural(chosen.length, 'commit')} will be applied to <code>{current}</code> in the
                order of {branch}.
              </p>
            )}
            {unconventional > 0 && (
              <p className="text-warning flex items-center gap-1 text-xs" role="status">
                <TriangleAlert className="size-3.5" aria-hidden="true" />
                {plural(unconventional, 'chosen commit')} {unconventional === 1 ? 'does' : 'do'} not
                follow Conventional Commits; messages are kept as they are and the project’s commit
                checks do not run for picked commits.
              </p>
            )}
            {dirty && (
              <p className="text-warning flex items-center gap-1 text-xs" role="status">
                <TriangleAlert className="size-3.5" aria-hidden="true" />
                Commit or stash your changes first; cherry-picking needs a clean working tree.
              </p>
            )}
          </div>
        )}

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="cherry-pick-error">{error}</AlertDescription>
          </Alert>
        )}

        {result?.status === 'succeeded' && (
          <Alert className="border-success/40" role="status" data-testid="cherry-pick-success">
            <CircleCheck className="text-success" />
            <AlertDescription>{result.summary}</AlertDescription>
          </Alert>
        )}

        {stopped && (
          <div className="flex flex-col gap-2" data-testid="cherry-pick-stopped">
            <Alert variant="destructive" role="alert">
              <TriangleAlert />
              <AlertDescription>{stopped.message}</AlertDescription>
            </Alert>
            {stopped.output && (
              <pre className="bg-muted/50 max-h-56 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap">
                {stopped.output}
              </pre>
            )}
            <p className="text-muted-foreground text-xs">
              Continue, skip or abort from the banner in the Git view.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() =>
                void copyText(stoppedText).then(
                  () => setCopied(true),
                  () => undefined,
                )
              }
            >
              {copied ? <Check /> : <Copy />}
              {copied ? 'Copied' : 'Copy message'}
            </Button>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {result === null ? 'Cancel' : 'Close'}
          </Button>
          {result === null && (
            <Button
              onClick={() => void cherryPick()}
              disabled={chosen.length === 0 || busy || dirty}
            >
              {busy
                ? 'Applying…'
                : `Cherry-pick ${chosen.length > 0 ? plural(chosen.length, 'commit') : ''}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
