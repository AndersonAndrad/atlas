import type { ContextTarget, DecisionRecord, DecisionStatus } from '@atlas/contracts';
import { Plus } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatDateTime, toLines } from '../format';
import { useKeyedLoad } from '../hooks/useContextData';

const STATUS_TONES: Record<DecisionStatus, string> = {
  ACTIVE: 'bg-success/15 text-success',
  SUPERSEDED: 'bg-muted text-muted-foreground',
  REJECTED: 'bg-destructive/15 text-destructive',
};

interface DecisionsTabProps {
  target: ContextTarget;
  targetKey: string;
  onChanged: () => void;
}

/** Decision records: superseded and rejected decisions are kept as history (FR-537). */
export function DecisionsTab({ target, targetKey, onChanged }: DecisionsTabProps) {
  const decisions = useKeyedLoad(`${targetKey}:decisions`, () => api().context.decisions(target));
  const [dialog, setDialog] = useState<{ supersedes: DecisionRecord | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(decision: DecisionRecord, status: 'ACTIVE' | 'REJECTED') {
    setError(null);
    try {
      await unwrap(api().context.setDecisionStatus(target, decision.id, status));
      await decisions.reload();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="context-decisions">
      <div className="flex justify-end">
        <Button onClick={() => setDialog({ supersedes: null })}>
          <Plus />
          Record decision
        </Button>
      </div>
      {(error ?? decisions.error) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error ?? decisions.error}</AlertDescription>
        </Alert>
      )}
      {decisions.value?.length === 0 && (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          No decisions recorded yet.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {decisions.value?.map((decision) => (
          <li
            key={decision.id}
            className={cn(
              'flex min-w-0 flex-col gap-1 rounded-md border p-3',
              decision.status !== 'ACTIVE' && 'opacity-70',
            )}
            data-testid="context-decision"
            data-status={decision.status}
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <span className="min-w-0 font-medium break-words">{decision.question}</span>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium',
                  STATUS_TONES[decision.status],
                )}
              >
                {decision.status}
              </span>
            </div>
            <p className="text-sm break-words">→ {decision.decision}</p>
            {decision.reasoning && (
              <p className="text-muted-foreground text-sm break-words">Why: {decision.reasoning}</p>
            )}
            {decision.alternatives.length > 0 && (
              <p className="text-muted-foreground text-xs break-words">
                Alternatives: {decision.alternatives.join(' · ')}
              </p>
            )}
            <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
              <span>
                {formatDateTime(decision.createdAt)} · {decision.author}
              </span>
              {decision.status === 'ACTIVE' && (
                <span className="ml-auto flex gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setDialog({ supersedes: decision })}
                  >
                    Supersede
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void setStatus(decision, 'REJECTED')}
                  >
                    Reject
                  </Button>
                </span>
              )}
              {decision.status === 'REJECTED' && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => void setStatus(decision, 'ACTIVE')}
                >
                  Reactivate
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {dialog && (
        <DecisionDialog
          target={target}
          supersedes={dialog.supersedes}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void decisions.reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function DecisionDialog({
  target,
  supersedes,
  onClose,
  onSaved,
}: {
  target: ContextTarget;
  supersedes: DecisionRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [question, setQuestion] = useState(supersedes?.question ?? '');
  const [decision, setDecision] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [alternatives, setAlternatives] = useState(supersedes ? supersedes.decision : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await unwrap(
        api().context.createDecision({
          target,
          question,
          decision,
          reasoning,
          alternatives: toLines(alternatives),
          ...(supersedes ? { supersedes: supersedes.id } : {}),
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

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="context-decision-dialog">
        <DialogHeader>
          <DialogTitle>{supersedes ? 'Supersede decision' : 'Record decision'}</DialogTitle>
          <DialogDescription>
            {supersedes
              ? 'The previous decision stays in the history as superseded.'
              : 'Decisions are shared with every session that receives this project’s context.'}
          </DialogDescription>
        </DialogHeader>
        <form id="context-decision-form" className="flex flex-col gap-3" onSubmit={save}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision-question">Question</Label>
            <Input
              id="decision-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision-decision">Decision</Label>
            <Textarea
              id="decision-decision"
              rows={2}
              value={decision}
              onChange={(event) => setDecision(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision-reasoning">Reasoning</Label>
            <Textarea
              id="decision-reasoning"
              rows={2}
              value={reasoning}
              onChange={(event) => setReasoning(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision-alternatives">Alternatives considered (one per line)</Label>
            <Textarea
              id="decision-alternatives"
              rows={2}
              value={alternatives}
              onChange={(event) => setAlternatives(event.target.value)}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="context-decision-form"
            disabled={busy || !question.trim() || !decision.trim()}
          >
            Save decision
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
