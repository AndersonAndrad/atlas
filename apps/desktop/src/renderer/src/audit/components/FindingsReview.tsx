import {
  AUDIT_DECISION_NOTE_MAX,
  AUDIT_SEVERITIES,
  type AuditDecisionView,
  type AuditFinding,
  type AuditSeverity,
} from '@atlas/contracts';
import { ListPlus } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { FindingItem } from './FindingItem';
import { STATE_LABELS, findingState, type FindingState } from './review-state';

const FILTERS = [
  { value: 'to-review', label: 'To review' },
  { value: 'decided', label: 'With a task or deferred' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All findings' },
] as const;
type Filter = (typeof FILTERS)[number]['value'];

const ALL_SEVERITIES = 'all';

const matches = (filter: Filter, state: FindingState) => {
  switch (filter) {
    case 'to-review':
      return state === 'to-review' || state === 'resolved';
    case 'decided':
      return state === 'has-task' || state === 'deferred';
    case 'rejected':
      return state === 'rejected';
    case 'all':
      return true;
  }
};

interface FindingsReviewProps {
  auditId: string;
  findings: AuditFinding[];
  decisions: AuditDecisionView[];
  onChanged: () => void;
  onOpenTask: (taskId: string, options: { execute: boolean }) => void;
}

/**
 * Review of an audit's findings (SDD-026 Task 01 Milestone B): each one becomes a task,
 * is rejected or deferred, alone or in bulk. Decisions are remembered by fingerprint, so a
 * later audit shows them; rejected findings are hidden unless asked for (PLAN-056 Q2).
 */
export function FindingsReview(props: FindingsReviewProps) {
  const [filter, setFilter] = useState<Filter>('to-review');
  const [severity, setSeverity] = useState<AuditSeverity | typeof ALL_SEVERITIES>(ALL_SEVERITIES);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [noteFor, setNoteFor] = useState<{
    ids: string[];
    decision: 'REJECTED' | 'DEFERRED';
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ taskIds: string[]; existing: number } | null>(null);

  const views = new Map(props.decisions.map((view) => [view.fingerprint, view]));
  const stateOf = (finding: AuditFinding) => findingState(views.get(finding.fingerprint));
  const counts = { to: 0, rejected: 0 };
  for (const finding of props.findings) {
    const state = stateOf(finding);
    if (state === 'to-review' || state === 'resolved') counts.to += 1;
    if (state === 'rejected') counts.rejected += 1;
  }
  const shown = props.findings.filter(
    (finding) =>
      matches(filter, stateOf(finding)) &&
      (severity === ALL_SEVERITIES || finding.severity === severity),
  );
  const chosen = shown.filter((finding) => selected.has(finding.id)).map((finding) => finding.id);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setSelected(new Set());
      props.onChanged();
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

  const createTasks = (findingIds: string[]) =>
    void run(async () => {
      const result = await unwrap(api().audit.createTasks({ auditId: props.auditId, findingIds }));
      setCreated({
        taskIds: result.results.map((item) => item.taskId),
        existing: result.results.filter((item) => !item.created).length,
      });
    });
  const decide = (
    findingIds: string[],
    decision: 'REJECTED' | 'DEFERRED' | 'NEEDS_REVIEW',
    note?: string,
  ) =>
    void run(async () => {
      await unwrap(
        api().audit.decide({
          auditId: props.auditId,
          findingIds,
          decision,
          ...(note ? { note } : {}),
        }),
      );
      setNoteFor(null);
    });

  return (
    <section className="flex flex-col gap-2" aria-label="Findings" data-testid="findings-review">
      <p className="text-muted-foreground text-sm">
        Turn the findings worth fixing into tasks; reject or defer the others. ATLAS remembers your
        decisions in the next audits.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <SelectTrigger size="sm" className="w-56" aria-label="Show findings">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
                {option.value === 'to-review' ? ` (${counts.to})` : ''}
                {option.value === 'rejected' ? ` (${counts.rejected})` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={severity}
          onValueChange={(value) => setSeverity(value as AuditSeverity | typeof ALL_SEVERITIES)}
        >
          <SelectTrigger size="sm" className="w-44" aria-label="Severity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SEVERITIES}>All severities</SelectItem>
            {AUDIT_SEVERITIES.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {shown.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs">
            <Checkbox
              checked={chosen.length > 0 && chosen.length === shown.length}
              onCheckedChange={(checked) =>
                setSelected(checked === true ? new Set(shown.map((item) => item.id)) : new Set())
              }
              aria-label="Select all shown findings"
            />
            Select all
          </label>
        )}
        {chosen.length > 0 && (
          <span className="flex flex-wrap gap-1.5" data-testid="findings-bulk">
            <Button size="xs" disabled={busy} onClick={() => createTasks(chosen)}>
              <ListPlus />
              Create {chosen.length} task(s)
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => setNoteFor({ ids: chosen, decision: 'DEFERRED' })}
            >
              Defer
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => setNoteFor({ ids: chosen, decision: 'REJECTED' })}
            >
              Reject
            </Button>
          </span>
        )}
      </div>

      {created !== null && (
        <Alert role="status" data-testid="findings-created">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>
              {created.taskIds.length - created.existing} task(s) created
              {created.existing > 0 ? `, ${created.existing} already existed` : ''}. Next: execute
              with ATLAS.
            </span>
            {created.taskIds.length === 1 ? (
              <Button
                size="xs"
                onClick={() => props.onOpenTask(created.taskIds[0]!, { execute: true })}
                data-testid="findings-execute"
              >
                Execute with ATLAS
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              onClick={() => props.onOpenTask(created.taskIds[0]!, { execute: false })}
            >
              Go to Tasks
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid="findings-error">{error}</AlertDescription>
        </Alert>
      )}
      {shown.length === 0 && (
        <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
          {filter === 'to-review'
            ? 'Nothing left to review here. Go to Tasks to execute what you created.'
            : 'No findings match.'}
        </p>
      )}

      <ul className="flex flex-col gap-2" data-testid="audit-findings">
        {shown.map((finding) => {
          const state = stateOf(finding);
          const view = views.get(finding.fingerprint);
          return (
            <FindingItem
              key={finding.id}
              finding={finding}
              leading={
                <Checkbox
                  className="mt-1"
                  checked={selected.has(finding.id)}
                  onCheckedChange={(checked) => {
                    const next = new Set(selected);
                    if (checked === true) next.add(finding.id);
                    else next.delete(finding.id);
                    setSelected(next);
                  }}
                  aria-label={`Select ${finding.title}`}
                />
              }
              footer={
                <div className="flex flex-wrap items-center gap-1.5" data-testid="finding-actions">
                  <Badge variant="outline" data-testid="finding-state">
                    {STATE_LABELS[state]}
                  </Badge>
                  {view?.note && (
                    <span className="text-muted-foreground text-xs break-words">“{view.note}”</span>
                  )}
                  {state === 'has-task' && view?.task ? (
                    <>
                      <Button
                        size="xs"
                        onClick={() => props.onOpenTask(view.task!.id, { execute: true })}
                      >
                        Execute with ATLAS
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => props.onOpenTask(view.task!.id, { execute: false })}
                      >
                        Open task
                      </Button>
                    </>
                  ) : state === 'rejected' || state === 'deferred' ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => decide([finding.id], 'NEEDS_REVIEW')}
                    >
                      Review again
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="xs"
                        disabled={busy}
                        onClick={() => createTasks([finding.id])}
                        data-testid="finding-create-task"
                      >
                        <ListPlus />
                        Create task
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setNoteFor({ ids: [finding.id], decision: 'DEFERRED' })}
                      >
                        Defer
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setNoteFor({ ids: [finding.id], decision: 'REJECTED' })}
                        data-testid="finding-reject"
                      >
                        Reject
                      </Button>
                    </>
                  )}
                </div>
              }
            />
          );
        })}
      </ul>

      {noteFor && (
        <DecisionNoteDialog
          count={noteFor.ids.length}
          decision={noteFor.decision}
          busy={busy}
          onCancel={() => setNoteFor(null)}
          onConfirm={(note) => decide(noteFor.ids, noteFor.decision, note)}
        />
      )}
    </section>
  );
}

function DecisionNoteDialog(props: {
  count: number;
  decision: 'REJECTED' | 'DEFERRED';
  busy: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  const verb = props.decision === 'REJECTED' ? 'Reject' : 'Defer';
  return (
    <Dialog open onOpenChange={(open) => !open && !props.busy && props.onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="decision-note-dialog">
        <DialogHeader>
          <DialogTitle>
            {verb} {props.count === 1 ? 'finding' : `${props.count} findings`}
          </DialogTitle>
          <DialogDescription>
            {props.decision === 'REJECTED'
              ? 'Rejected findings are hidden in the next audits. You can show them again.'
              : 'Deferred findings stay visible as deferred in the next audits.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="decision-note">Note (optional)</Label>
          <Textarea
            id="decision-note"
            rows={3}
            maxLength={AUDIT_DECISION_NOTE_MAX}
            value={note}
            placeholder={
              props.decision === 'REJECTED' ? 'e.g. false positive' : 'e.g. after the release'
            }
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
          <Button onClick={() => props.onConfirm(note.trim())} disabled={props.busy}>
            {verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
