import type { AiSession, ContextTarget } from '@atlas/contracts';
import { useState, type FormEvent } from 'react';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { PROVIDER_LABELS, formatDateTime, toLines } from '../format';
import { useKeyedLoad } from '../hooks/useContextData';

interface SessionsTabProps {
  target: ContextTarget;
  targetKey: string;
  onChanged: () => void;
  onSummarize: (session: AiSession) => void;
}

/** Individual AI sessions started or tracked by ATLAS, newest first. */
export function SessionsTab({ target, targetKey, onSummarize }: SessionsTabProps) {
  const sessions = useKeyedLoad(`${targetKey}:sessions`, () => api().context.sessions(target));
  return (
    <div className="flex flex-col gap-3" data-testid="context-sessions">
      <p className="text-muted-foreground text-sm">
        ATLAS records when a session starts and the commits and files that change during it. It
        never reads Claude’s or Codex’s conversation: what happened is saved with the summary you
        write or approve when it ends.
      </p>
      {sessions.error && <p className="text-destructive text-sm">{sessions.error}</p>}
      {sessions.value?.length === 0 && (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          No AI sessions yet. Start Claude or Codex from the overview, a task or a terminal.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {sessions.value?.map((session) => (
          <li
            key={session.id}
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border p-3 text-sm"
            data-testid="context-session"
            data-status={session.status}
          >
            <span className="font-medium">{PROVIDER_LABELS[session.provider]}</span>
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]">
              {session.captureMode === 'managed' ? 'started by ATLAS' : 'tracked terminal'}
            </span>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                session.status === 'active'
                  ? 'bg-sky-500/15 text-sky-300'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {session.status}
            </span>
            <span className="text-muted-foreground text-xs">
              {formatDateTime(session.startedAt)}
              {session.endedAt ? ` → ${formatDateTime(session.endedAt)}` : ''}
            </span>
            {session.status === 'active' && (
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                onClick={() => onSummarize(session)}
              >
                Save summary…
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SummaryDialogProps {
  target: ContextTarget;
  targetKey: string;
  session: AiSession;
  onClose: () => void;
  onSaved: () => void;
}

/** Ends a session: Git evidence is collected by ATLAS; the rest is the user's summary. */
export function SummaryDialog({
  target,
  targetKey,
  session,
  onClose,
  onSaved,
}: SummaryDialogProps) {
  const evidence = useKeyedLoad(`${targetKey}:evidence:${session.id}`, () =>
    api().context.sessionEvidence(target, session.id),
  );
  const [summary, setSummary] = useState('');
  const [completed, setCompleted] = useState('');
  const [pending, setPending] = useState('');
  const [decisions, setDecisions] = useState('');
  const [nextActions, setNextActions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api().context.endSession(target, session.id, {
          summary,
          completed: toLines(completed),
          pending: toLines(pending),
          decisions: toLines(decisions),
          nextActions: toLines(nextActions),
        }),
      );
      onSaved();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues[0]
          ? caught.issues[0].message
          : errorMessage(caught),
      );
      setBusy(false);
    }
  }

  const fields: [string, string, string, (value: string) => void][] = [
    ['Completed (one per line)', 'summary-completed', completed, setCompleted],
    ['Pending (one per line)', 'summary-pending', pending, setPending],
    ['Decisions (one per line)', 'summary-decisions', decisions, setDecisions],
    ['Next actions (one per line)', 'summary-next', nextActions, setNextActions],
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="session-summary-dialog"
      >
        <DialogHeader>
          <DialogTitle>Save session summary</DialogTitle>
          <DialogDescription>
            {PROVIDER_LABELS[session.provider]} session started {formatDateTime(session.startedAt)}.
            Commits and files come from Git; the rest is saved as your statement.
          </DialogDescription>
        </DialogHeader>
        <section
          className="flex flex-col gap-1 rounded-md border p-3 text-sm"
          data-testid="session-evidence"
        >
          <span className="font-medium">Verified by ATLAS (Git)</span>
          {evidence.value === null ? (
            <span className="text-muted-foreground">{evidence.error ?? 'Collecting…'}</span>
          ) : (
            <>
              <span className="text-muted-foreground">
                {evidence.value.commits.length} commit(s), {evidence.value.changedFiles.length}{' '}
                changed file(s) since the session started.
              </span>
              <ul className="max-h-32 overflow-auto font-mono text-xs">
                {evidence.value.commits.map((commit) => (
                  <li key={commit.hash}>
                    {commit.hash.slice(0, 8)} {commit.subject}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        <form id="session-summary-form" className="flex flex-col gap-3" onSubmit={save}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="summary-text">Summary</Label>
            <Textarea
              id="summary-text"
              rows={3}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fields.map(([label, id, value, set]) => (
              <div key={id} className="flex flex-col gap-1.5">
                <Label htmlFor={id}>{label}</Label>
                <Textarea
                  id={id}
                  rows={3}
                  value={value}
                  onChange={(event) => set(event.target.value)}
                />
              </div>
            ))}
          </div>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="session-summary-form" disabled={busy}>
            {busy ? 'Saving…' : 'Save and end session'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
