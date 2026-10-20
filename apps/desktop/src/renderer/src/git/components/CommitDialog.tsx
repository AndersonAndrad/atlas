import type {
  GitCommitResult,
  GitCommitSuggestion,
  GitFileChange,
  GitOperation,
  GitPreferences,
  GitRemote,
  GitWorkingTree,
} from '@atlas/contracts';
import { validateCommitMessage, type CommitMessageRules } from '@atlas/conventional-commits';
import { Copy, GitBranch, GitCommitHorizontal, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { directoryName, fileName, isPartiallyStaged, plural, sumStats } from '../format';
import { ChangeCode, LineStats } from './ChangesList';
import { OperationResult } from './OperationsPanel';

interface CommitDialogProps {
  /** Live working tree; the dialog works on the snapshot taken when it opened. */
  tree: GitWorkingTree;
  preferences: GitPreferences | null;
  onClose: () => void;
  onDone: (result: GitCommitResult) => void;
}

interface FileChoice {
  /** The file is part of this commit. */
  included: boolean;
  /** Partially staged: also stage its working tree changes. */
  withUnstaged: boolean;
}

function rulesOf(preferences: GitPreferences | null): CommitMessageRules {
  if (preferences === null) return {};
  return {
    types: preferences.commitTypes,
    requireScope: preferences.requireScope,
    ...(preferences.headerMaxLength === null
      ? {}
      : { headerMaxLength: preferences.headerMaxLength }),
  };
}

const committable = (file: GitFileChange) => file.staged !== 'conflicted';

function initialChoices(files: GitFileChange[]): Map<string, FileChoice> {
  return new Map(
    files
      .filter(committable)
      .map((file) => [file.path, { included: file.staged !== null, withUnstaged: false }]),
  );
}

/** Commit dialog: staged content by default, unstaged changes only when explicitly chosen. */
export function CommitDialog({ tree, preferences, onClose, onDone }: CommitDialogProps) {
  const id = useId();
  const [snapshot, setSnapshot] = useState(tree);
  const [choices, setChoices] = useState(() => initialChoices(tree.files));
  const [showUnstaged, setShowUnstaged] = useState(
    () => !tree.files.some((file) => file.staged !== null),
  );
  const [message, setMessage] = useState('');
  const [suggestion, setSuggestion] = useState<GitCommitSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; indexChanged: boolean } | null>(null);
  /** The commit succeeded but its push did not; shown until the dialog closes. */
  const [result, setResult] = useState<GitCommitResult | null>(null);
  const [failure, setFailure] = useState<GitOperation | null>(null);
  const [remotes, setRemotes] = useState<GitRemote[] | null>(null);
  const [destination, setDestination] = useState({ remote: '', branch: tree.branch ?? '' });
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const needsDestination = snapshot.upstream === null || snapshot.upstreamGone;
  useEffect(() => {
    if (!needsDestination) return;
    let cancelled = false;
    unwrap(api().git.remotes(snapshot.repositoryRoot)).then(
      (list) => {
        if (cancelled) return;
        setRemotes(list);
        setDestination((current) => ({
          ...current,
          remote:
            current.remote ||
            (list.find((remote) => remote.name === 'origin') ?? list[0])?.name ||
            '',
        }));
      },
      () => !cancelled && setRemotes([]),
    );
    return () => {
      cancelled = true;
    };
  }, [needsDestination, snapshot.repositoryRoot]);

  const stale = tree.indexFingerprint !== snapshot.indexFingerprint;
  const files = snapshot.files.filter(committable);
  const visible = files.filter((file) => file.staged !== null || showUnstaged);
  const choice = (file: GitFileChange) =>
    choices.get(file.path) ?? { included: false, withUnstaged: false };
  const update = (path: string, change: Partial<FileChoice>) =>
    setChoices((current) => {
      const next = new Map(current);
      next.set(path, {
        ...(current.get(path) ?? { included: false, withUnstaged: false }),
        ...change,
      });
      return next;
    });

  const included = files.filter((file) => choice(file).included);
  const toStage = included.filter(
    (file) => file.staged === null || (isPartiallyStaged(file) && choice(file).withUnstaged),
  );
  const toUnstage = files.filter((file) => file.staged !== null && !choice(file).included);
  const stats = sumStats(
    ...included.flatMap((file) => [
      file.staged !== null ? file.stagedStats : null,
      file.staged === null || choice(file).withUnstaged ? file.unstagedStats : null,
    ]),
  );

  const rules = useMemo(() => rulesOf(preferences), [preferences]);
  const validation = useMemo(() => validateCommitMessage(message, rules), [message, rules]);
  const hasMessage = message.trim() !== '';
  const conflicts = snapshot.files.some((file) => file.staged === 'conflicted');
  const destinationReady =
    !needsDestination || (destination.remote !== '' && destination.branch.trim() !== '');
  const canCommit =
    !busy &&
    !stale &&
    !conflicts &&
    validation.valid &&
    (included.length > 0 || snapshot.inProgress === 'merge') &&
    result === null;

  const reviewAgain = () => {
    setSnapshot(tree);
    setChoices(initialChoices(tree.files));
    setError(null);
  };

  async function submit(push: boolean) {
    if (!canCommit || (push && !destinationReady)) return;
    setBusy(true);
    setError(null);
    setFailure(null);
    try {
      const outcome = await unwrap(
        api().git.commit({
          repositoryRoot: snapshot.repositoryRoot,
          message,
          stage: toStage.map((file) => file.path),
          unstage: toUnstage.map((file) => file.path),
          expectedFingerprint: snapshot.indexFingerprint,
          push,
          ...(push && needsDestination
            ? { setUpstream: { remote: destination.remote, branch: destination.branch.trim() } }
            : {}),
        }),
      );
      if (outcome.commit.status !== 'succeeded') {
        setFailure(outcome.commit);
        return;
      }
      setFailure(null);
      if (outcome.push === null || outcome.push.status === 'succeeded') onDone(outcome);
      else setResult(outcome);
    } catch (caught) {
      const indexChanged = caught instanceof ApiError && caught.code === 'GIT_INDEX_CHANGED';
      const detail =
        caught instanceof ApiError && caught.issues.length > 0
          ? caught.issues.map((issue) => issue.message).join(' ')
          : errorMessage(caught);
      setError({ message: detail, indexChanged });
    } finally {
      setBusy(false);
    }
  }

  async function suggest() {
    try {
      const value = await unwrap(
        api().git.suggestMessage({
          repositoryRoot: snapshot.repositoryRoot,
          paths: (included.length > 0 ? included : files).map((file) => file.path),
        }),
      );
      setSuggestion(value);
      if (value !== null && !hasMessage) setMessage(value.message);
    } catch (caught) {
      setError({ message: errorMessage(caught), indexChanged: false });
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit(false);
    }
  };

  const committed = result !== null;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="sm:max-w-2xl"
        data-testid="commit-dialog"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          messageRef.current?.focus();
        }}
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        <DialogHeader>
          <div className="flex min-w-0 items-center justify-between gap-3 pr-6">
            <DialogTitle className="flex items-center gap-2">
              <GitCommitHorizontal className="size-4" aria-hidden="true" />
              Commit your changes
            </DialogTitle>
            <span
              className="bg-muted text-muted-foreground inline-flex max-w-48 items-center gap-1 rounded-full px-2 py-0.5 text-xs"
              data-testid="commit-branch"
              title={snapshot.branch ?? 'detached HEAD'}
            >
              <GitBranch className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{snapshot.branch ?? 'detached HEAD'}</span>
            </span>
          </div>
          <DialogDescription className="truncate" title={snapshot.repositoryRoot}>
            {snapshot.repositoryName} · hooks run as usual; nothing is committed without your
            confirmation.
          </DialogDescription>
        </DialogHeader>

        {stale && !committed && (
          <Alert role="status" className="border-warning/40">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              The staged changes or the current commit changed since this dialog opened.
              <Button size="sm" variant="outline" onClick={reviewAgain}>
                <RefreshCw />
                Review again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {conflicts && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>Resolve the merge conflicts before committing.</AlertDescription>
          </Alert>
        )}

        <section className="flex min-w-0 flex-col gap-2" aria-labelledby={`${id}-changes`}>
          <div className="flex items-center justify-between gap-2">
            <h3 id={`${id}-changes`} className="text-sm font-medium">
              Changes
            </h3>
            <span className="flex items-center gap-2">
              <LineStats stats={included.length > 0 ? stats : null} />
              <span
                className="bg-warning/15 text-warning rounded-full px-2 py-0.5 text-xs font-medium tabular-nums"
                data-testid="commit-file-count"
              >
                {plural(included.length, 'file')}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-show-unstaged`}
              checked={showUnstaged}
              onCheckedChange={(checked) => setShowUnstaged(checked === true)}
              disabled={committed}
            />
            <Label htmlFor={`${id}-show-unstaged`} className="font-normal">
              Include unstaged changes
            </Label>
          </div>
          <ul
            className="max-h-56 min-w-0 overflow-y-auto rounded-md border p-1"
            aria-label="Files to commit"
            data-testid="commit-files"
          >
            {visible.length === 0 && (
              <li className="text-muted-foreground p-2 text-sm">
                Nothing is staged. Select “Include unstaged changes” to choose files.
              </li>
            )}
            {visible.map((file) => {
              const current = choice(file);
              const partial = isPartiallyStaged(file);
              const kind = file.staged ?? file.unstaged!;
              const checkboxId = `${id}-file-${file.path}`;
              return (
                <li
                  key={file.path}
                  className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1"
                  data-testid="commit-file"
                  data-path={file.path}
                >
                  <Checkbox
                    id={checkboxId}
                    checked={current.included}
                    disabled={committed}
                    onCheckedChange={(checked) => update(file.path, { included: checked === true })}
                    aria-label={`Include ${file.path}`}
                  />
                  <ChangeCode kind={kind} />
                  <label
                    htmlFor={checkboxId}
                    className="flex min-w-0 flex-1 items-baseline gap-2 text-sm"
                  >
                    <span className="truncate">{fileName(file.path)}</span>
                    <span className="text-muted-foreground min-w-0 truncate text-xs [direction:rtl]">
                      <span dir="ltr">{directoryName(file.path)}</span>
                    </span>
                  </label>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 text-[10px]',
                      file.staged === null || !current.included
                        ? 'bg-warning/15 text-warning'
                        : 'bg-success/15 text-success',
                    )}
                  >
                    {file.staged === null
                      ? current.included
                        ? 'will be staged'
                        : file.unstaged === 'untracked'
                          ? 'untracked'
                          : 'unstaged'
                      : !current.included
                        ? 'will be unstaged'
                        : partial
                          ? 'partially staged'
                          : 'staged'}
                  </span>
                  {partial && showUnstaged && (
                    <label className="text-muted-foreground flex shrink-0 items-center gap-1 text-[11px]">
                      <Checkbox
                        checked={current.withUnstaged}
                        disabled={committed || !current.included}
                        onCheckedChange={(checked) =>
                          update(file.path, { withUnstaged: checked === true })
                        }
                      />
                      + unstaged
                    </label>
                  )}
                  <LineStats
                    stats={sumStats(
                      file.staged !== null ? file.stagedStats : null,
                      file.staged === null || current.withUnstaged ? file.unstagedStats : null,
                    )}
                  />
                </li>
              );
            })}
          </ul>
          {toStage.length > 0 && (
            <p className="text-warning text-xs" data-testid="commit-will-stage">
              Will stage before committing: {toStage.map((file) => file.path).join(', ')}
            </p>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`${id}-message`}>Commit message</Label>
            {hasMessage && (
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-medium',
                  validation.valid
                    ? 'bg-success/15 text-success'
                    : 'bg-destructive/15 text-destructive',
                )}
                data-testid="commit-validation-badge"
              >
                {validation.valid ? 'Conventional' : 'Not conventional'}
              </span>
            )}
          </div>
          <Textarea
            id={`${id}-message`}
            ref={messageRef}
            value={message}
            rows={4}
            className="font-mono text-sm"
            placeholder="feat(scope): describe the change"
            disabled={committed}
            aria-invalid={hasMessage && !validation.valid ? true : undefined}
            aria-describedby={`${id}-message-help`}
            onChange={(event) => setMessage(event.target.value)}
          />
          <div id={`${id}-message-help`} aria-live="polite" className="text-xs">
            {hasMessage && !validation.valid ? (
              <ul
                className="text-destructive list-disc pl-4"
                data-testid="commit-validation-errors"
              >
                {validation.errors.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">
                Conventional Commits 1.0.0: <code>type(scope)!: description</code>, optional body
                and footers.{' '}
                {validation.breaking && hasMessage && <strong>Breaking change.</strong>}
              </p>
            )}
          </div>
          {suggestion && (
            <div
              className="bg-muted/40 rounded-md border p-2 text-xs"
              data-testid="commit-suggestion"
            >
              <div className="flex items-center justify-between gap-2">
                <code className="truncate">{suggestion.message}</code>
                {suggestion.message !== message && (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setMessage(suggestion.message)}
                  >
                    Use suggestion
                  </Button>
                )}
              </div>
              <ul className="text-muted-foreground mt-1 list-disc pl-4">
                {suggestion.rationale.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={committed || files.length === 0 || preferences?.suggestions === 'off'}
              onClick={() => void suggest()}
            >
              <Sparkles />
              Suggest message
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasMessage}
              onClick={() => void navigator.clipboard.writeText(message).catch(() => undefined)}
            >
              <Copy />
              Copy message
            </Button>
          </div>
        </section>

        {needsDestination && !committed && (
          <fieldset
            className="flex min-w-0 flex-col gap-2 rounded-md border p-3"
            data-testid="commit-destination"
          >
            <legend className="px-1 text-sm font-medium">Push destination</legend>
            <p className="text-muted-foreground text-xs">
              This branch has no upstream. Commit &amp; Push publishes it here and sets it as the
              upstream.
            </p>
            {remotes !== null && remotes.length === 0 ? (
              <p className="text-warning text-xs">No remote is configured; you can still commit.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
                <Select
                  value={destination.remote}
                  onValueChange={(remote) => setDestination((current) => ({ ...current, remote }))}
                >
                  <SelectTrigger aria-label="Remote">
                    <SelectValue placeholder="Remote" />
                  </SelectTrigger>
                  <SelectContent>
                    {(remotes ?? []).map((remote) => (
                      <SelectItem key={remote.name} value={remote.name}>
                        {remote.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  aria-label="Remote branch"
                  value={destination.branch}
                  onChange={(event) =>
                    setDestination((current) => ({ ...current, branch: event.target.value }))
                  }
                />
              </div>
            )}
          </fieldset>
        )}

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="flex flex-col gap-2" data-testid="commit-error">
              <span>{error.message}</span>
              {error.indexChanged && (
                <Button size="sm" variant="outline" className="self-start" onClick={reviewAgain}>
                  <RefreshCw />
                  Review again
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        {failure && !committed && (
          <div className="rounded-md border p-3" data-testid="commit-failure">
            <OperationResult operation={failure} />
          </div>
        )}
        {result && (
          <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="commit-result">
            <OperationResult operation={result.commit} />
            {result.push && <OperationResult operation={result.push} />}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {committed ? 'Close' : 'Cancel'}
          </Button>
          {!committed && (
            <>
              <Button
                variant="secondary"
                disabled={
                  !canCommit ||
                  !destinationReady ||
                  (remotes !== null && remotes.length === 0 && needsDestination)
                }
                onClick={() => void submit(true)}
              >
                Commit &amp; Push
              </Button>
              <Button disabled={!canCommit} onClick={() => void submit(false)}>
                {busy ? 'Committing…' : 'Commit'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
