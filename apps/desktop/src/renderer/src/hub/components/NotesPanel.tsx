import {
  NOTE_SEARCH_MAX,
  type NoteFilter,
  type NoteScope,
  type NoteSummary,
  type ProjectNote,
} from '@atlas/contracts';
import { Archive, FileText, Pin, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useNoteList, useNotesChanged } from '../hooks/useNotes';
import { NoteEditor, draftOf, isDirty, type NoteDraft } from './NoteEditor';

const FILTERS: { id: NoteFilter; label: string }[] = [
  { id: 'active', label: 'All notes' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'archived', label: 'Archived' },
];
const ALL_CATEGORIES = '__all__';
const SEARCH_DELAY_MS = 250;

interface NotesPanelProps {
  scope: NoteScope;
  /** Who owns a note, shown when the list covers several owners. */
  ownerLabel: (note: NoteSummary) => string;
  /** Opens a note from elsewhere in the Hub (e.g. the overview), once per nonce. */
  openRequest: { noteId: string; nonce: number } | null;
  /** Called once the request was taken, so it is not replayed when the panel mounts again. */
  onOpenRequestHandled: () => void;
  onOpenLink: (note: ProjectNote, href: string, openNote: (id: string) => void) => void;
}

/** Notes of the Project Hub (SDD-010 FR-1007): filters, search, list and editor. */
export function NotesPanel({
  scope,
  ownerLabel,
  openRequest,
  onOpenRequestHandled,
  onOpenLink,
}: NotesPanelProps) {
  const [filter, setFilter] = useState<NoteFilter>('active');
  const [category, setCategory] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<{ note: ProjectNote; draft: NoteDraft } | null>(null);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  /** The note to open after discarding unsaved edits; null closes the editor. */
  const [pendingOpen, setPendingOpen] = useState<{ id: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchText.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  const list = useNoteList({
    scope,
    filter,
    ...(search ? { search } : {}),
    ...(category ? { category } : {}),
  });
  const notes = list.value?.notes ?? null;

  const load = useCallback(async (id: string) => {
    setError(null);
    try {
      const note = await unwrap(api().notes.get(id));
      setOpen({ note, draft: draftOf(note) });
      setChangedElsewhere(false);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  /** Opens a note (null closes the editor), asking first when edits are unsaved. */
  const requestOpen = useCallback(
    (id: string | null) => {
      if (open !== null && isDirty(open.note, open.draft) && open.note.id !== id) {
        setPendingOpen({ id });
        return;
      }
      if (id === null) setOpen(null);
      else void load(id);
    },
    [open, load],
  );

  const [handledRequest, setHandledRequest] = useState<number | null>(null);
  useEffect(() => {
    if (openRequest === null || openRequest.nonce === handledRequest) return;
    void (async () => {
      setHandledRequest(openRequest.nonce);
      onOpenRequestHandled();
      await load(openRequest.noteId);
    })();
  }, [openRequest, handledRequest, load, onOpenRequestHandled]);

  // Events arrive asynchronously; the handler reads the note open at that moment.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  // Another client (or this one) changed notes: refresh the open note when it is safe.
  useNotesChanged(
    useCallback((noteId: string | null) => {
      const id = openRef.current?.note.id;
      if (id === undefined || (noteId !== null && noteId !== id)) return;
      void (async () => {
        try {
          const stored = await unwrap(api().notes.get(id));
          const current = openRef.current;
          if (current === null || current.note.id !== id) return;
          if (stored.revision <= current.note.revision) return;
          // This client's own save, reported before its response was applied.
          if (!isDirty(stored, current.draft)) {
            setOpen({ note: stored, draft: current.draft });
          } else if (isDirty(current.note, current.draft)) {
            setChangedElsewhere(true);
          } else {
            setOpen({ note: stored, draft: draftOf(stored) });
          }
        } catch (caught) {
          if (caught instanceof ApiError && caught.code === 'NOTE_NOT_FOUND') setOpen(null);
        }
      })();
    }, []),
  );

  async function createNote() {
    setError(null);
    try {
      const note = await unwrap(
        api().notes.create({
          projectId: scope.kind === 'project' ? scope.projectId : null,
          title: 'Untitled note',
          content: '',
          ...(category ? { category } : {}),
        }),
      );
      setFilter('active');
      setOpen({ note, draft: draftOf(note) });
      setChangedElsewhere(false);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const categories = list.value?.categories ?? [];
  const counts = list.value?.counts;

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="notes-panel">
      <aside
        className={cn(
          'flex min-h-0 w-full shrink-0 flex-col border-r lg:w-80',
          open !== null && 'hidden lg:flex',
        )}
        aria-label="Notes"
      >
        <div className="flex flex-col gap-2 border-b p-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="text-muted-foreground absolute top-2 left-2 size-4" />
              <Input
                type="search"
                aria-label="Search notes"
                placeholder="Search notes"
                className="h-8 pl-8"
                maxLength={NOTE_SEARCH_MAX}
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
            </div>
            <Button size="sm" onClick={() => void createNote()}>
              <Plus />
              New note
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Show">
            {FILTERS.map((option) => (
              <Button
                key={option.id}
                size="xs"
                variant={filter === option.id ? 'secondary' : 'ghost'}
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
                {counts && (
                  <span className="text-muted-foreground tabular-nums">
                    {option.id === 'active'
                      ? counts.active
                      : option.id === 'pinned'
                        ? counts.pinned
                        : counts.archived}
                  </span>
                )}
              </Button>
            ))}
          </div>
          {categories.length > 0 && (
            <Select
              value={category ?? ALL_CATEGORIES}
              onValueChange={(value) => setCategory(value === ALL_CATEGORIES ? null : value)}
            >
              <SelectTrigger size="sm" className="w-full" aria-label="Category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
                {categories.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        {(error ?? list.error) && (
          <Alert variant="destructive" className="m-2 w-auto" role="alert">
            <AlertDescription>{error ?? list.error}</AlertDescription>
          </Alert>
        )}
        <ul className="min-h-0 flex-1 overflow-y-auto p-1" data-testid="note-list">
          {notes?.length === 0 && (
            <li className="text-muted-foreground p-4 text-center text-sm">
              {search || category
                ? 'No notes match.'
                : filter === 'active'
                  ? 'No notes yet. Create one to record decisions and documentation.'
                  : `No ${filter} notes.`}
            </li>
          )}
          {notes?.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                className={cn(
                  'hover:bg-accent flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left',
                  open?.note.id === note.id && 'bg-accent',
                )}
                aria-current={open?.note.id === note.id ? 'true' : undefined}
                onClick={() => requestOpen(note.id)}
              >
                <span className="flex min-w-0 items-center gap-1.5 font-medium">
                  {note.pinned && <Pin className="size-3 shrink-0" aria-label="Pinned" />}
                  {note.archived && <Archive className="size-3 shrink-0" aria-label="Archived" />}
                  <span className="truncate">{note.title}</span>
                </span>
                {note.excerpt && (
                  <span className="text-muted-foreground line-clamp-2 text-xs">{note.excerpt}</span>
                )}
                <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                  {note.category && (
                    <Badge variant="outline" className="max-w-32 truncate">
                      {note.category}
                    </Badge>
                  )}
                  {scope.kind === 'all' && <span className="truncate">{ownerLabel(note)}</span>}
                  <span className="ml-auto shrink-0">
                    {new Date(note.updatedAt).toLocaleDateString()}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {open === null ? (
        <div className="text-muted-foreground hidden flex-1 flex-col items-center justify-center gap-2 lg:flex">
          <FileText className="size-8" aria-hidden />
          <p>Select a note or create one.</p>
        </div>
      ) : (
        <NoteEditor
          key={open.note.id}
          note={open.note}
          draft={open.draft}
          categories={categories}
          changedElsewhere={changedElsewhere}
          onDraftChange={(draft) =>
            setOpen((current) =>
              current?.note.id === open.note.id ? { note: current.note, draft } : current,
            )
          }
          onNoteChange={(note) => {
            // Keep the latest draft: typing may continue while a save is in flight, and
            // pin/archive keep unsaved edits. A matching draft simply stops being dirty.
            setOpen((current) =>
              current?.note.id === note.id ? { note, draft: current.draft } : current,
            );
            setChangedElsewhere(false);
          }}
          onReload={() => void load(open.note.id)}
          onDeleted={() => setOpen(null)}
          onBack={() => requestOpen(null)}
          onOpenLink={(note, href) => onOpenLink(note, href, requestOpen)}
        />
      )}

      <AlertDialog
        open={pendingOpen !== null}
        onOpenChange={(value) => !value && setPendingOpen(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved edits?</AlertDialogTitle>
            <AlertDialogDescription>
              “{open?.draft.title}” has edits that are not saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const id = pendingOpen?.id ?? null;
                setPendingOpen(null);
                if (id === null) setOpen(null);
                else void load(id);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
