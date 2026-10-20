import type {
  AiProvider,
  ContextHandoff,
  ContextHandoffDraft,
  ContextTarget,
} from '@atlas/contracts';
import { Check, Copy, Plus } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { copyText } from '@/lib/clipboard';
import { formatDateTime, toLines } from '../format';
import { useKeyedLoad } from '../hooks/useContextData';

const NO_PROVIDER = '__none__';

interface HandoffsTabProps {
  target: ContextTarget;
  targetKey: string;
  onCreate: () => void;
  onContinue: (provider: AiProvider, handoff: ContextHandoff) => void;
}

/** Structured continuation packets between providers and sessions (FR-511/512). */
export function HandoffsTab({ target, targetKey, onCreate, onContinue }: HandoffsTabProps) {
  const handoffs = useKeyedLoad(`${targetKey}:handoffs`, () => api().context.handoffs(target));
  const [viewing, setViewing] = useState<ContextHandoff | null>(null);
  return (
    <div className="flex flex-col gap-3" data-testid="context-handoffs">
      <div className="flex justify-end">
        <Button onClick={onCreate}>
          <Plus />
          Prepare handoff
        </Button>
      </div>
      {handoffs.error && <p className="text-destructive text-sm">{handoffs.error}</p>}
      {handoffs.value?.length === 0 && (
        <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
          No handoffs yet. A handoff lets another provider continue the work without the original
          conversation.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {handoffs.value?.map((handoff) => (
          <li
            key={handoff.id}
            className="flex min-w-0 flex-col gap-1 rounded-md border p-3 text-sm"
            data-testid="context-handoff"
          >
            <span className="font-medium break-words">{handoff.objective}</span>
            <span className="text-muted-foreground text-xs">
              {formatDateTime(handoff.createdAt)}
              {handoff.targetProvider
                ? ` · for ${handoff.targetProvider === 'claude' ? 'Claude Code' : 'Codex'}`
                : ''}{' '}
              · {handoff.pendingWork.length} pending · {handoff.commits.length} commit(s) ·{' '}
              {handoff.changedFiles.length} changed file(s)
            </span>
            <span className="flex flex-wrap gap-1.5">
              <Button size="xs" variant="outline" onClick={() => setViewing(handoff)}>
                View
              </Button>
              <Button size="xs" variant="outline" onClick={() => onContinue('claude', handoff)}>
                Continue with Claude
              </Button>
              <Button size="xs" variant="outline" onClick={() => onContinue('codex', handoff)}>
                Continue with Codex
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {viewing && (
        <HandoffViewDialog
          target={target}
          targetKey={targetKey}
          handoff={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

function HandoffViewDialog({
  target,
  targetKey,
  handoff,
  onClose,
}: {
  target: ContextTarget;
  targetKey: string;
  handoff: ContextHandoff;
  onClose: () => void;
}) {
  const rendered = useKeyedLoad(`${targetKey}:handoff:${handoff.id}`, () =>
    api().context.handoff(target, handoff.id),
  );
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="handoff-view-dialog"
      >
        <DialogHeader>
          <DialogTitle>Handoff</DialogTitle>
          <DialogDescription>
            Paste it into any AI tool, or continue with Claude or Codex from the list.
          </DialogDescription>
        </DialogHeader>
        <pre
          className="bg-muted/50 max-h-[55vh] overflow-auto rounded border p-3 font-mono text-xs whitespace-pre-wrap"
          data-testid="handoff-markdown"
        >
          {rendered.value?.markdown ?? rendered.error ?? 'Loading…'}
        </pre>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={rendered.value === null}
            onClick={() =>
              void copyText(rendered.value!.markdown).then(
                () => setCopied(true),
                () => undefined,
              )
            }
          >
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy markdown'}
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface HandoffDialogProps {
  target: ContextTarget;
  targetKey: string;
  taskId?: string;
  sourceSessionId?: string;
  onClose: () => void;
  onCreated: (handoff: ContextHandoff) => void;
}

/** Creates a handoff from a draft built from stored context and Git, edited by the user. */
export function HandoffDialog(props: HandoffDialogProps) {
  const draftKey = `${props.targetKey}:draft:${props.taskId ?? ''}:${props.sourceSessionId ?? ''}`;
  const draft = useKeyedLoad(draftKey, () =>
    api().context.prepareHandoff(props.target, {
      ...(props.taskId ? { taskId: props.taskId } : {}),
      ...(props.sourceSessionId ? { sourceSessionId: props.sourceSessionId } : {}),
    }),
  );
  return draft.value === null ? (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Prepare handoff</DialogTitle>
          <DialogDescription>
            {draft.error ?? 'Collecting context and Git evidence…'}
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  ) : (
    <HandoffForm {...props} draft={draft.value} />
  );
}

function HandoffForm({
  target,
  taskId,
  sourceSessionId,
  onClose,
  onCreated,
  draft,
}: HandoffDialogProps & { draft: ContextHandoffDraft }) {
  const [objective, setObjective] = useState(draft.objective);
  const [completed, setCompleted] = useState(draft.completedWork.join('\n'));
  const [pending, setPending] = useState(draft.pendingWork.join('\n'));
  const [blockers, setBlockers] = useState(draft.blockers.join('\n'));
  const [nextActions, setNextActions] = useState(draft.nextActions.join('\n'));
  const [provider, setProvider] = useState<string>(NO_PROVIDER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const handoff = await unwrap(
        api().context.createHandoff({
          target,
          ...(taskId ? { taskId } : {}),
          ...(sourceSessionId ? { sourceSessionId } : {}),
          targetProvider: provider === NO_PROVIDER ? null : (provider as AiProvider),
          objective,
          completedWork: toLines(completed),
          pendingWork: toLines(pending),
          blockers: toLines(blockers),
          nextActions: toLines(nextActions),
        }),
      );
      onCreated(handoff);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues[0]
          ? caught.issues[0].message
          : errorMessage(caught),
      );
      setBusy(false);
    }
  }

  const lists: [string, string, string, (value: string) => void][] = [
    ['Completed work', 'handoff-completed', completed, setCompleted],
    ['Pending work', 'handoff-pending', pending, setPending],
    ['Blockers', 'handoff-blockers', blockers, setBlockers],
    ['Next actions', 'handoff-next', nextActions, setNextActions],
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="handoff-dialog"
      >
        <DialogHeader>
          <DialogTitle>Prepare handoff</DialogTitle>
          <DialogDescription>
            Prefilled from this project’s memory. Commits, changed files and decisions are added by
            ATLAS from Git and the decision records when you create it.
          </DialogDescription>
        </DialogHeader>
        <section
          className="text-muted-foreground rounded-md border p-2 text-xs"
          data-testid="handoff-evidence"
        >
          Git evidence now: {draft.commits.length} commit(s), {draft.changedFiles.length} changed
          file(s) · {draft.decisions.length} active decision(s)
        </section>
        <form id="handoff-form" className="flex flex-col gap-3" onSubmit={create}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="handoff-objective">Objective</Label>
            <Textarea
              id="handoff-objective"
              rows={2}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {lists.map(([label, id, value, set]) => (
              <div key={id} className="flex flex-col gap-1.5">
                <Label htmlFor={id}>{label} (one per line)</Label>
                <Textarea
                  id={id}
                  rows={4}
                  value={value}
                  onChange={(event) => set(event.target.value)}
                />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="handoff-provider">For</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger id="handoff-provider" className="w-full sm:w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROVIDER}>Any provider</SelectItem>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
              </SelectContent>
            </Select>
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
          <Button type="submit" form="handoff-form" disabled={busy || !objective.trim()}>
            {busy ? 'Creating…' : 'Create handoff'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
