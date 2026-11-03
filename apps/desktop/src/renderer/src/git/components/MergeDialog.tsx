import type {
  GitBranchList,
  GitMergePreview,
  GitOperation,
  GitWorkingTree,
} from '@atlas/contracts';
import { Check, CircleCheck, Copy, GitMerge, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { relativeTime } from '@/components/git/git-format';
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
import { copyText } from '@/lib/clipboard';
import { plural } from '../format';
import { BranchPicker } from './BranchPicker';

interface MergeDialogProps {
  tree: GitWorkingTree;
  onClose: () => void;
}

/**
 * Merges a chosen branch into the current one with a plain `git merge`, which commits
 * a clean merge. Conflicts are a warning listing the files to resolve; real failures
 * show Git's output, which can be copied.
 */
export function MergeDialog({ tree, onClose }: MergeDialogProps) {
  const [branches, setBranches] = useState<GitBranchList | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [preview, setPreview] = useState<GitMergePreview | null>(null);
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
    unwrap(api().git.mergePreview({ repositoryRoot: tree.repositoryRoot, branch })).then(
      (value) => !cancelled && setPreview(value),
      () => undefined,
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
  const shownPreview = preview?.branch === branch ? preview : null;

  async function merge() {
    if (branch === null) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setResult(await unwrap(api().git.merge({ repositoryRoot: tree.repositoryRoot, branch })));
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

  const failure = result?.status === 'failed' ? result.error : null;
  const failureText = failure
    ? [failure.message, failure.output].filter((part) => part !== null && part !== '').join('\n\n')
    : '';
  const merged = result?.status === 'succeeded';
  const conflicts = merged ? (result.conflicts ?? []) : [];
  const nothingToMerge = merged && result.summary?.includes('nothing to merge') === true;
  const copyButton = (text: string) => (
    <Button
      variant="outline"
      size="sm"
      className="self-start"
      onClick={() =>
        void copyText(text).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    >
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied' : 'Copy message'}
    </Button>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        data-testid="merge-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-4" aria-hidden="true" />
            Merge into {current ?? 'the current branch'}
          </DialogTitle>
          <DialogDescription>
            Runs <code className="font-mono">git merge</code> of the chosen branch into{' '}
            {current ?? 'this branch'}; a clean merge is committed with Git’s message. Remote
            branches are as of the last fetch
            {tree.lastFetchAt ? ` (${relativeTime(tree.lastFetchAt)})` : ' (never fetched)'}.
          </DialogDescription>
        </DialogHeader>

        {result === null && (
          <div className="flex flex-col gap-2">
            <BranchPicker
              label="Branch to merge"
              value={branch}
              onChange={setBranch}
              disabled={busy}
              groups={[
                { label: 'Local', names: local.map((candidate) => candidate.name) },
                { label: 'Remote-tracking', names: remote.map((candidate) => candidate.name) },
              ]}
            />
            {branch !== null && (
              <p className="text-sm" data-testid="merge-selected">
                Merging <code className="font-mono">{branch}</code> into{' '}
                <code className="font-mono">{current}</code>
              </p>
            )}
            {shownPreview && (
              <p className="text-muted-foreground text-sm" data-testid="merge-preview">
                {shownPreview.commits === 0
                  ? `${current} already has every commit of ${shownPreview.branch}.`
                  : `${plural(shownPreview.commits, 'commit')} of ${shownPreview.branch} will be merged.`}
              </p>
            )}
            {dirty && (
              <p className="text-warning flex items-center gap-1 text-xs" role="status">
                <TriangleAlert className="size-3.5" aria-hidden="true" />
                Commit or stash your changes first; merging needs a clean working tree.
              </p>
            )}
          </div>
        )}

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="merge-error">{error}</AlertDescription>
          </Alert>
        )}

        {merged && conflicts.length === 0 && (
          <Alert className="border-success/40" role="status" data-testid="merge-success">
            <CircleCheck className="text-success" />
            <AlertDescription className="flex flex-col gap-1">
              <strong className="text-foreground">
                {nothingToMerge ? 'Already up to date' : 'Merge completed'}
              </strong>
              <span>{result.summary}</span>
            </AlertDescription>
          </Alert>
        )}

        {merged && conflicts.length > 0 && (
          <Alert className="border-warning/40" role="status" data-testid="merge-conflict">
            <TriangleAlert className="text-warning" />
            <AlertDescription className="flex flex-col gap-1">
              <strong className="text-foreground">
                Merge finished with conflicts in {plural(conflicts.length, 'file')}
              </strong>
              <span>Resolve them in your editor and commit, or abort the merge.</span>
              <ul
                className="max-h-40 overflow-auto font-mono text-xs"
                data-testid="merge-conflict-files"
              >
                {conflicts.map((path) => (
                  <li key={path} className="break-all">
                    {path}
                  </li>
                ))}
              </ul>
              {copyButton([result.summary ?? '', ...conflicts].join('\n'))}
            </AlertDescription>
          </Alert>
        )}

        {failure && (
          <div className="flex flex-col gap-2" data-testid="merge-failure">
            <Alert variant="destructive" role="alert">
              <TriangleAlert />
              <AlertDescription>{failure.message}</AlertDescription>
            </Alert>
            {failure.output && (
              <pre
                className="bg-muted/50 max-h-56 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap"
                data-testid="merge-failure-output"
              >
                {failure.output}
              </pre>
            )}
            {copyButton(failureText)}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {result === null ? 'Cancel' : 'Close'}
          </Button>
          {result === null && (
            <Button onClick={() => void merge()} disabled={branch === null || busy || dirty}>
              {busy ? 'Merging…' : 'Merge'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
