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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { copyText } from '@/lib/clipboard';
import { plural } from '../format';

interface MergeDialogProps {
  tree: GitWorkingTree;
  onClose: () => void;
  /** Opens the commit dialog to conclude a merge that succeeded. */
  onCommit: () => void;
}

/**
 * Merges a chosen branch into the current one without committing. A clean merge
 * ends with a positive message and "Commit merge"; conflicts list the files with
 * Git's output, which can be copied.
 */
export function MergeDialog({ tree, onClose, onCommit }: MergeDialogProps) {
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

  const conflict = result?.status === 'failed' ? result.error : null;
  const conflictText = conflict
    ? [conflict.message, conflict.output]
        .filter((part) => part !== null && part !== '')
        .join('\n\n')
    : '';
  const merged = result?.status === 'succeeded';
  const nothingToMerge = merged && result.summary?.includes('nothing to merge') === true;

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
            Brings the chosen branch into {current ?? 'this branch'} without committing; you review
            and commit with Git’s merge message. Remote branches are as of the last fetch
            {tree.lastFetchAt ? ` (${relativeTime(tree.lastFetchAt)})` : ' (never fetched)'}.
          </DialogDescription>
        </DialogHeader>

        {result === null && (
          <div className="flex flex-col gap-2">
            <Select value={branch ?? undefined} onValueChange={setBranch} disabled={busy}>
              <SelectTrigger aria-label="Branch to merge" className="w-full">
                <SelectValue placeholder="Choose a branch to merge" />
              </SelectTrigger>
              <SelectContent>
                {local.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Local</SelectLabel>
                    {local.map((candidate) => (
                      <SelectItem key={candidate.name} value={candidate.name}>
                        {candidate.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {remote.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Remote-tracking</SelectLabel>
                    {remote.map((candidate) => (
                      <SelectItem key={candidate.name} value={candidate.name}>
                        {candidate.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
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

        {merged && (
          <Alert className="border-success/40" role="status" data-testid="merge-success">
            <CircleCheck className="text-success" />
            <AlertDescription className="flex flex-col gap-1">
              <strong className="text-foreground">
                {nothingToMerge ? 'Already up to date' : 'Merge ready — no conflicts'}
              </strong>
              <span>{result.summary}</span>
            </AlertDescription>
          </Alert>
        )}

        {conflict && (
          <div className="flex flex-col gap-2" data-testid="merge-conflict">
            <Alert variant="destructive" role="alert">
              <TriangleAlert />
              <AlertDescription>{conflict.message}</AlertDescription>
            </Alert>
            {conflict.output && (
              <pre
                className="bg-muted/50 max-h-56 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap"
                data-testid="merge-conflict-output"
              >
                {conflict.output}
              </pre>
            )}
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() =>
                void copyText(conflictText).then(
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
            <Button onClick={() => void merge()} disabled={branch === null || busy || dirty}>
              {busy ? 'Merging…' : 'Merge'}
            </Button>
          )}
          {merged && !nothingToMerge && <Button onClick={onCommit}>Commit merge</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
