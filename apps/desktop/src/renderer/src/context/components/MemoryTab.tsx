import {
  CONTEXT_CATEGORIES,
  type ContextCategory,
  type ContextEntry,
  type ContextTarget,
} from '@atlas/contracts';
import { Archive, History, Pencil, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
  CATEGORY_LABELS,
  VERIFICATION_LABELS,
  VERIFICATION_TONES,
  formatDateTime,
  toLines,
} from '../format';
import { useKeyedLoad } from '../hooks/useContextData';

const ALL = '__all__';
const NO_TASK = '__none__';

export function EntryBadges({ entry }: { entry: ContextEntry }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-1">
      <span
        className={cn(
          'rounded px-1.5 py-0.5 text-[10px] font-medium',
          VERIFICATION_TONES[entry.verification],
        )}
        title={
          entry.verification === 'verified'
            ? 'Collected by ATLAS from the repository'
            : entry.verification === 'user'
              ? 'Written or approved by you'
              : 'Reported by an AI agent; not verified'
        }
      >
        {VERIFICATION_LABELS[entry.verification]}
      </span>
      <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]">
        {CATEGORY_LABELS[entry.category]}
      </span>
      {entry.required && (
        <span
          className="bg-sidebar-primary/15 text-sidebar-primary rounded px-1.5 py-0.5 text-[10px] font-medium"
          title="Always sent in context bundles"
        >
          Required
        </span>
      )}
      {entry.scope === 'global' && (
        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]">
          Global
        </span>
      )}
      {entry.status === 'obsolete' && (
        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]">
          Obsolete
        </span>
      )}
    </span>
  );
}

interface MemoryTabProps {
  target: ContextTarget;
  targetKey: string;
  onChanged: () => void;
}

type EntryDialogState = { mode: 'create' } | { mode: 'edit'; entry: ContextEntry } | null;

/** Project, task and global memory: search, correct, mark obsolete or remove records. */
export function MemoryTab({ target, targetKey, onChanged }: MemoryTabProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>(ALL);
  const [includeObsolete, setIncludeObsolete] = useState(false);
  const [includeGlobal, setIncludeGlobal] = useState(true);
  const [dialog, setDialog] = useState<EntryDialogState>(null);
  const [history, setHistory] = useState<ContextEntry | null>(null);
  const [removing, setRemoving] = useState<ContextEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = `${targetKey}:entries:${search}:${category}:${includeObsolete}:${includeGlobal}`;
  const entries = useKeyedLoad(query, () =>
    api().context.list({
      target,
      ...(search.trim() ? { search } : {}),
      ...(category !== ALL ? { category: category as ContextCategory } : {}),
      includeObsolete,
      includeGlobal,
    }),
  );
  const tasks = useKeyedLoad(`${targetKey}:tasks`, () => api().context.tasks(target));
  const taskTitle = (id: string | null) => tasks.value?.find((task) => task.id === id)?.title;

  const ownTarget = (entry: ContextEntry) => (entry.scope === 'global' ? null : target);
  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await entries.reload();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="context-memory">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search memory"
            placeholder="Search memory"
            className="pl-8"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-44" aria-label="Category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {CONTEXT_CATEGORIES.map((value) => (
              <SelectItem key={value} value={value}>
                {CATEGORY_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={() => setDialog({ mode: 'create' })}>
          <Plus />
          Add entry
        </Button>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <Checkbox
            checked={includeGlobal}
            onCheckedChange={(value) => setIncludeGlobal(value === true)}
          />
          Include global conventions
        </label>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={includeObsolete}
            onCheckedChange={(value) => setIncludeObsolete(value === true)}
          />
          Show obsolete
        </label>
      </div>

      {(error ?? entries.error) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error ?? entries.error}</AlertDescription>
        </Alert>
      )}
      {entries.value?.length === 0 && (
        <p
          className="text-muted-foreground rounded-md border border-dashed p-4 text-sm"
          role="status"
        >
          {search.trim() ? `Nothing matches “${search.trim()}”.` : 'Nothing recorded yet.'}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {entries.value?.map((entry) => (
          <li
            key={entry.id}
            className={cn(
              'flex min-w-0 flex-col gap-1 rounded-md border p-3',
              entry.status === 'obsolete' && 'opacity-60',
            )}
            data-testid="context-entry"
            data-category={entry.category}
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <span className="min-w-0 font-medium break-words">{entry.title}</span>
              <EntryBadges entry={entry} />
            </div>
            {entry.body && (
              <p className="text-muted-foreground line-clamp-4 text-sm whitespace-pre-wrap break-words">
                {entry.body}
              </p>
            )}
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span>Updated {formatDateTime(entry.updatedAt)}</span>
              {entry.revision > 1 && <span>Revision {entry.revision}</span>}
              {taskTitle(entry.taskId) && <span>Task: {taskTitle(entry.taskId)}</span>}
              {entry.refs.files.length > 0 && (
                <span>{entry.refs.files.length} file reference(s)</span>
              )}
              <span className="ml-auto flex gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Edit ${entry.title}`}
                  title="Edit"
                  onClick={() => setDialog({ mode: 'edit', entry })}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`History of ${entry.title}`}
                  title="Revision history"
                  onClick={() => setHistory(entry)}
                >
                  <History />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={
                    entry.status === 'obsolete'
                      ? `Restore ${entry.title}`
                      : `Mark ${entry.title} obsolete`
                  }
                  title={entry.status === 'obsolete' ? 'Restore' : 'Mark obsolete'}
                  onClick={() =>
                    void act(() =>
                      unwrap(
                        api().context.update(ownTarget(entry), entry.id, {
                          status: entry.status === 'obsolete' ? 'active' : 'obsolete',
                        }),
                      ),
                    )
                  }
                >
                  {entry.status === 'obsolete' ? <RotateCcw /> : <Archive />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${entry.title}`}
                  title="Remove"
                  onClick={() => setRemoving(entry)}
                >
                  <Trash2 />
                </Button>
              </span>
            </div>
          </li>
        ))}
      </ul>

      {dialog && (
        <EntryDialog
          target={target}
          tasks={tasks.value ?? []}
          state={dialog}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void entries.reload();
            onChanged();
          }}
        />
      )}
      {history && (
        <HistoryDialog
          target={history.scope === 'global' ? null : target}
          entry={history}
          onClose={() => setHistory(null)}
        />
      )}
      {removing && (
        <AlertDialog open onOpenChange={(open) => !open && setRemoving(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this entry?</AlertDialogTitle>
              <AlertDialogDescription className="wrap-anywhere">
                “{removing.title}” and its revision history are deleted permanently. To keep the
                history, mark it obsolete instead.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  const entry = removing;
                  setRemoving(null);
                  void act(() => unwrap(api().context.remove(ownTarget(entry), entry.id)));
                }}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

interface EntryDialogProps {
  target: ContextTarget;
  tasks: { id: string; title: string }[];
  state: Exclude<EntryDialogState, null>;
  onClose: () => void;
  onSaved: () => void;
}

function EntryDialog({ target, tasks, state, onClose, onSaved }: EntryDialogProps) {
  const editing = state.mode === 'edit' ? state.entry : null;
  const [scope, setScope] = useState<'project' | 'task' | 'global'>(
    editing?.scope === 'global' ? 'global' : editing?.taskId ? 'task' : 'project',
  );
  const [taskId, setTaskId] = useState<string>(editing?.taskId ?? NO_TASK);
  const [category, setCategory] = useState<ContextCategory>(editing?.category ?? 'note');
  const [title, setTitle] = useState(editing?.title ?? '');
  const [body, setBody] = useState(editing?.body ?? '');
  const [files, setFiles] = useState('');
  const [required, setRequired] = useState(editing?.required ?? false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await unwrap(
          api().context.update(editing.scope === 'global' ? null : target, editing.id, {
            title,
            body,
            category,
            required,
            ...(reason.trim() ? { reason } : {}),
          }),
        );
      } else {
        await unwrap(
          api().context.record({
            target: scope === 'global' ? null : target,
            scope: scope === 'project' && 'workspacePath' in target ? 'workspace' : scope,
            ...(scope === 'task' && taskId !== NO_TASK ? { taskId } : {}),
            category,
            title,
            body,
            required,
            ...(toLines(files).length ? { files: toLines(files) } : {}),
          }),
        );
      }
      onSaved();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues.length > 0
          ? caught.issues.map((issue) => issue.message).join(' ')
          : errorMessage(caught),
      );
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        data-testid="context-entry-dialog"
      >
        <DialogHeader>
          <DialogTitle>{editing ? 'Correct entry' : 'Add to memory'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'The previous version stays in the revision history.'
              : 'Credentials are removed automatically. Keep secrets out of shared context.'}
          </DialogDescription>
        </DialogHeader>
        <form id="context-entry-form" className="flex flex-col gap-3" onSubmit={save}>
          {!editing && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="entry-scope">Scope</Label>
                <Select value={scope} onValueChange={(value) => setScope(value as typeof scope)}>
                  <SelectTrigger id="entry-scope" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="project">This project / repository</SelectItem>
                    <SelectItem value="task" disabled={tasks.length === 0}>
                      A task
                    </SelectItem>
                    <SelectItem value="global">Global (shared with every project)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {scope === 'task' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="entry-task">Task</Label>
                  <Select value={taskId} onValueChange={setTaskId}>
                    <SelectTrigger id="entry-task" className="w-full">
                      <SelectValue placeholder="Choose a task" />
                    </SelectTrigger>
                    <SelectContent>
                      {tasks.map((task) => (
                        <SelectItem key={task.id} value={task.id}>
                          {task.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}
          {scope === 'global' && !editing && (
            <p className="text-warning text-xs">
              Global entries are included in the context of every project. Never put project secrets
              here.
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-category">Category</Label>
            <Select
              value={category}
              onValueChange={(value) => setCategory(value as ContextCategory)}
            >
              <SelectTrigger id="entry-category" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTEXT_CATEGORIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {CATEGORY_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-title">Title</Label>
            <Input
              id="entry-title"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-body">Details</Label>
            <Textarea
              id="entry-body"
              rows={5}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          {!editing && scope !== 'global' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="entry-files">Related files (optional, one per line)</Label>
              <Textarea
                id="entry-files"
                rows={2}
                className="font-mono text-xs"
                placeholder="src/auth/jwt.ts"
                value={files}
                onChange={(event) => setFiles(event.target.value)}
              />
              <span className="text-muted-foreground text-xs">
                ATLAS fingerprints them and marks the entry STALE when they change.
              </span>
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={required}
              onCheckedChange={(value) => setRequired(value === true)}
              data-testid="entry-required"
            />
            <span className="flex flex-col">
              <span>Always include in context</span>
              <span className="text-muted-foreground text-xs">
                Required entries are never left out for the budget nor excluded in a preview. Keep
                them short: rules the AI must respect.
              </span>
            </span>
          </label>
          {editing && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="entry-reason">Reason for the change (optional)</Label>
              <Input
                id="entry-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          )}
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
          <Button
            type="submit"
            form="context-entry-form"
            disabled={
              busy || title.trim() === '' || (scope === 'task' && taskId === NO_TASK && !editing)
            }
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({
  target,
  entry,
  onClose,
}: {
  target: ContextTarget | null;
  entry: ContextEntry;
  onClose: () => void;
}) {
  const history = useKeyedLoad(`history:${entry.id}`, () =>
    api().context.history(target, entry.id),
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        data-testid="context-history-dialog"
      >
        <DialogHeader>
          <DialogTitle>Revision history</DialogTitle>
          <DialogDescription className="wrap-anywhere">{entry.title}</DialogDescription>
        </DialogHeader>
        {history.error && <p className="text-destructive text-sm">{history.error}</p>}
        <ol className="flex flex-col gap-2">
          {history.value?.map((revision) => (
            <li
              key={revision.revision}
              className="rounded-md border p-2 text-sm"
              data-testid="context-revision"
            >
              <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                <span>Revision {revision.revision}</span>
                <span>{formatDateTime(revision.changedAt)}</span>
                <span>by {revision.changedBy}</span>
                <span>{revision.status}</span>
              </div>
              <div className="font-medium">{revision.title}</div>
              {revision.body && (
                <p className="text-muted-foreground whitespace-pre-wrap">{revision.body}</p>
              )}
              {revision.reason && <p className="text-xs italic">Reason: {revision.reason}</p>}
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}
