import {
  DEFAULT_PROJECT_GIT_SETTINGS,
  type GitCommitContext,
  type GitCommitResult,
  type GitCommitSuggestion,
  type GitFileChange,
  type GitOperation,
  type GitPreferences,
  type GitRemote,
  type GitWorkingTree,
  type StoredGitPreferences,
} from '@atlas/contracts';
import { validateCommitMessage, type CommitMessageRules } from '@atlas/conventional-commits';
import {
  Copy,
  GitBranch,
  GitCommitHorizontal,
  ListChecks,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
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
import {
  INVALID_PREFERENCES_MESSAGE,
  commitSubmission,
  directoryName,
  fileName,
  isActive,
  isPartiallyStaged,
  plural,
  submittedCommit,
  sumStats,
  type CommitSubmission,
} from '../format';
import { useGitOperations } from '../hooks/useGit';
import { ChangeCode, LineStats } from './ChangesList';
import { OperationResult } from './OperationsPanel';

interface CommitDialogProps {
  /** Live working tree; the dialog works on the snapshot taken when it opened. */
  tree: GitWorkingTree;
  preferences: StoredGitPreferences | null;
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
  const [context, setContext] = useState<GitCommitContext | null>(null);
  /** Loading the commit checks failed; committing stays blocked until a retry succeeds. */
  const [contextError, setContextError] = useState<string | null>(null);
  /** The commit checks are (re)loading; committing waits for them. */
  const [contextLoading, setContextLoading] = useState(true);
  /** Incremented to load the commit checks again. */
  const [contextAttempt, setContextAttempt] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [submission, setSubmission] = useState<CommitSubmission | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  // Commit checks of the repository's project(s); the Engine applies the same settings.
  useEffect(() => {
    let cancelled = false;
    unwrap(api().git.commitContext(tree.repositoryRoot)).then(
      (value) => {
        if (cancelled) return;
        setContext(value);
        setContextError(null);
        setContextLoading(false);
        // Keep the chosen project when it still applies.
        setProjectId((current) =>
          value.projects.some((candidate) => candidate.id === current)
            ? current
            : (value.projects[0]?.id ?? null),
        );
      },
      (caught: unknown) => {
        if (cancelled) return;
        setContextError(errorMessage(caught));
        setContextLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tree.repositoryRoot, contextAttempt]);
  const reloadContext = () => {
    setContextError(null);
    setContextLoading(true);
    setContextAttempt((current) => current + 1);
  };
  const project = context?.projects.find((candidate) => candidate.id === projectId);
  const settings = project?.settings ?? DEFAULT_PROJECT_GIT_SETTINGS;
  const enforce = settings.enforceConventionalCommits;
  const steps = settings.preCommitSteps;
  /** The stored settings of the chosen project are unreadable; the Engine refuses its commits. */
  const settingsInvalid = project?.settingsInvalid === true;
  /** The stored Git preferences are unreadable; the Engine refuses every commit. */
  const preferencesInvalid = preferences?.invalid === true;

  // The running commit, to show its steps live and offer cancelling while they run.
  const operations = useGitOperations(tree.repositoryRoot);
  const live = submittedCommit(operations, submission);

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

  const hasMessage = message.trim() !== '';
  const validation = enforce
    ? validateCommitMessage(message, rulesOf(preferences))
    : { valid: hasMessage, errors: [] as string[], breaking: false };
  // Changes left out of this commit that the steps will still see.
  const leftOut = snapshot.files.filter(
    (file) =>
      (file.unstaged !== null && !toStage.includes(file)) ||
      (file.staged !== null && !choice(file).included),
  ).length;
  const conflicts = snapshot.files.some((file) => file.staged === 'conflicted');
  const destinationReady =
    !needsDestination || (destination.remote !== '' && destination.branch.trim() !== '');
  const canCommit =
    context !== null &&
    !contextLoading &&
    contextError === null &&
    !settingsInvalid &&
    !preferencesInvalid &&
    !busy &&
    !stale &&
    !snapshot.stagedTruncated &&
    !conflicts &&
    validation.valid &&
    (included.length > 0 || snapshot.inProgress === 'merge') &&
    result === null;

  const reviewAgain = () => {
    setSnapshot(tree);
    setChoices(initialChoices(tree.files));
    setError(null);
    // The commit checks may have changed too, or failed to load.
    reloadContext();
  };

  async function submit(push: boolean) {
    if (!canCommit || (push && !destinationReady)) return;
    setBusy(true);
    setError(null);
    setFailure(null);
    setSubmission(commitSubmission(operations));
    try {
      const outcome = await unwrap(
        api().git.commit({
          repositoryRoot: snapshot.repositoryRoot,
          message,
          stage: toStage.map((file) => file.path),
          unstage: toUnstage.map((file) => file.path),
          expectedFingerprint: snapshot.indexFingerprint,
          push,
          ...(projectId === null ? {} : { projectId }),
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
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
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
        {contextError && !committed && (
          <Alert variant="destructive" role="alert">
            <AlertDescription
              className="flex flex-wrap items-center justify-between gap-2"
              data-testid="commit-context-error"
            >
              <span>The commit checks could not be loaded: {contextError}</span>
              <Button size="sm" variant="outline" onClick={reloadContext}>
                <RefreshCw />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {conflicts && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>Resolve the merge conflicts before committing.</AlertDescription>
          </Alert>
        )}
        {preferencesInvalid && !committed && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="commit-preferences-invalid">
              {INVALID_PREFERENCES_MESSAGE}
            </AlertDescription>
          </Alert>
        )}
        {settingsInvalid && !committed && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="commit-settings-invalid">
              This project's commit checks settings are invalid; open settings to fix.
            </AlertDescription>
          </Alert>
        )}
        {snapshot.stagedTruncated ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="commit-staged-truncated">
              Too many staged files to review safely. Commit from a terminal.
            </AlertDescription>
          </Alert>
        ) : (
          snapshot.truncated && (
            <Alert role="status">
              <AlertDescription data-testid="commit-truncated">
                Some unstaged or untracked files are not listed. They stay out of this commit.
              </AlertDescription>
            </Alert>
          )
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
            {!enforce ? (
              <span
                className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium"
                data-testid="commit-validation-badge"
                title="This project does not enforce Conventional Commits"
              >
                Conventional check off
              </span>
            ) : (
              hasMessage && (
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
              )
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
            ) : enforce ? (
              <p className="text-muted-foreground">
                Conventional Commits 1.0.0: <code>type(scope)!: description</code>, optional body
                and footers.{' '}
                {validation.breaking && hasMessage && <strong>Breaking change.</strong>}
              </p>
            ) : (
              <p className="text-muted-foreground">Any non-empty message is accepted.</p>
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

        {context !== null && context.projects.length > 1 && !committed && (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-project`}>Commit checks from project</Label>
            <Select value={projectId ?? undefined} onValueChange={setProjectId}>
              <SelectTrigger id={`${id}-project`} className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {context.projects.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {steps.length > 0 && !committed && !busy && (
          <section
            className="flex min-w-0 flex-col gap-2 rounded-md border p-3"
            aria-labelledby={`${id}-checks`}
            data-testid="commit-checks"
          >
            <h3 id={`${id}-checks`} className="flex items-center gap-2 text-sm font-medium">
              <ListChecks className="size-4" aria-hidden="true" />
              Before committing, ATLAS runs {plural(steps.length, 'step')}
            </h3>
            <ol className="flex flex-col gap-1 text-xs">
              {steps.map((step, index) => (
                <li key={index} className="flex min-w-0 items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
                  <span className="font-medium">{step.name}</span>
                  <code className="text-muted-foreground min-w-0 truncate" title={step.command}>
                    {step.command}
                  </code>
                  {step.mode === 'start' && (
                    <span className="text-muted-foreground shrink-0">(start and stop)</span>
                  )}
                </li>
              ))}
            </ol>
            {leftOut > 0 && (
              <p
                className="text-warning flex items-center gap-1 text-xs"
                data-testid="commit-checks-warning"
              >
                <TriangleAlert className="size-3.5" aria-hidden="true" />
                Steps run on the whole working tree, including {plural(leftOut, 'file')} left out of
                this commit.
              </p>
            )}
          </section>
        )}

        {busy && live && (
          <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="commit-progress">
            <OperationResult operation={live} />
            {isActive(live) && live.cancellable && (
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() =>
                  void unwrap(api().git.cancelOperation(live.id)).catch((caught: unknown) =>
                    setError({
                      message: `The checks could not be cancelled: ${errorMessage(caught)}`,
                      indexChanged: false,
                    }),
                  )
                }
              >
                Cancel checks
              </Button>
            )}
          </div>
        )}

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
                {busy
                  ? live?.steps?.some((step) => step.status === 'running')
                    ? 'Running checks…'
                    : 'Committing…'
                  : 'Commit'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
