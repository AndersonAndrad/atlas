import {
  NOTE_CATEGORY_MAX,
  NOTE_CONTENT_MAX,
  NOTE_TITLE_MAX,
  noteLinkHref,
  type NoteLinkStatus,
  type ProjectNote,
  type UpdateNoteInput,
} from '@atlas/contracts';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bold,
  CheckSquare,
  Code,
  Heading,
  Link as LinkIcon,
  List,
  MoreHorizontal,
  Pin,
  PinOff,
  Save,
  Table,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { applyMarkdownAction, atlasLinks, type MarkdownAction } from '../markdown';
import { MarkdownPreview } from './MarkdownPreview';

export interface NoteDraft {
  title: string;
  content: string;
  category: string;
}

export const draftOf = (note: ProjectNote): NoteDraft => ({
  title: note.title,
  content: note.content,
  category: note.category ?? '',
});

export const isDirty = (note: ProjectNote, draft: NoteDraft) =>
  draft.title !== note.title ||
  draft.content !== note.content ||
  draft.category.trim() !== (note.category ?? '');

type Mode = 'edit' | 'preview' | 'split';
const MODES: { id: Mode; label: string }[] = [
  { id: 'edit', label: 'Edit' },
  { id: 'split', label: 'Split' },
  { id: 'preview', label: 'Preview' },
];

const TOOLBAR: { action: MarkdownAction; label: string; icon: LucideIcon }[] = [
  { action: 'heading', label: 'Heading', icon: Heading },
  { action: 'bold', label: 'Bold', icon: Bold },
  { action: 'list', label: 'List', icon: List },
  { action: 'checklist', label: 'Checklist', icon: CheckSquare },
  { action: 'code', label: 'Code', icon: Code },
  { action: 'link', label: 'Link', icon: LinkIcon },
  { action: 'table', label: 'Table', icon: Table },
];

/** Waits this long after typing before checking the note's links again. */
const LINK_CHECK_DELAY_MS = 400;

interface NoteEditorProps {
  note: ProjectNote;
  draft: NoteDraft;
  onDraftChange: (draft: NoteDraft) => void;
  /** The stored note changed (saved here, or reloaded). */
  onNoteChange: (note: ProjectNote) => void;
  /** Re-reads the stored note, discarding the draft. */
  onReload: () => void;
  onDeleted: () => void;
  /** Shown on narrow windows, where the list and the editor do not fit side by side. */
  onBack: () => void;
  categories: string[];
  /** Another client changed the note while the draft has unsaved edits. */
  changedElsewhere: boolean;
  onOpenLink: (note: ProjectNote, href: string) => void;
}

export function NoteEditor({
  note,
  draft,
  onDraftChange,
  onNoteChange,
  onReload,
  onDeleted,
  onBack,
  categories,
  changedElsewhere,
  onOpenLink,
}: NoteEditorProps) {
  // Split needs the width of the `xl` breakpoint; narrower windows start in Edit.
  const [mode, setMode] = useState<Mode>(() =>
    window.matchMedia('(min-width: 80rem)').matches ? 'split' : 'edit',
  );
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // A newer stored revision (reloaded or saved) settles a previous conflict.
  const [shownRevision, setShownRevision] = useState(note.revision);
  if (note.revision !== shownRevision) {
    setShownRevision(note.revision);
    setConflict(false);
  }
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [links, setLinks] = useState<ReadonlyMap<string, NoteLinkStatus>>(new Map());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const dirty = isDirty(note, draft);

  // Link status follows the text being previewed, checked shortly after typing stops.
  const linkList = atlasLinks(draft.content).join('\n');
  useEffect(() => {
    const hrefs = linkList === '' ? [] : linkList.split('\n');
    if (hrefs.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const statuses = await unwrap(
            api().notes.checkLinks({ projectId: note.projectId, links: hrefs }),
          );
          if (!cancelled) setLinks(new Map(statuses.map((status) => [status.href, status])));
        } catch {
          // Unchecked links stay clickable; opening them reports what is wrong.
        }
      })();
    }, LINK_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [linkList, note.projectId]);

  async function update(changes: Omit<UpdateNoteInput, 'expectedRevision'>, revision: number) {
    setBusy(true);
    setError(null);
    try {
      const saved = await unwrap(
        api().notes.update(note.id, { ...changes, expectedRevision: revision }),
      );
      setConflict(false);
      onNoteChange(saved);
      return saved;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'NOTE_CONFLICT') setConflict(true);
      else setError(errorMessage(caught));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const save = (revision = note.revision) =>
    update({ title: draft.title, content: draft.content, category: draft.category }, revision);

  /** Saves the draft over whatever another client stored (after an explicit choice). */
  async function overwrite() {
    try {
      const latest = await unwrap(api().notes.get(note.id));
      await save(latest.revision);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function remove() {
    setDeleting(false);
    try {
      await unwrap(api().notes.remove(note.id));
      onDeleted();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  function applyAction(action: MarkdownAction) {
    const element = textarea.current;
    if (element === null) return;
    const result = applyMarkdownAction(action, {
      value: draft.content,
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd,
    });
    onDraftChange({ ...draft, content: result.value });
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  }

  const copyLink = () =>
    void api().app.copyText(
      `[${note.title.replace(/[[\]]/g, '')}](${noteLinkHref({ kind: 'note', id: note.id })})`,
    );

  const showEditor = mode !== 'preview';
  const showPreview = mode !== 'edit';

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="Note editor"
      data-testid="note-editor"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          if (dirty && !busy) void save();
        }
      }}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          aria-label="Back to notes"
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <Input
          aria-label="Note title"
          className="h-8 min-w-40 flex-1 font-medium"
          value={draft.title}
          maxLength={NOTE_TITLE_MAX}
          onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
        />
        <Input
          aria-label="Category"
          placeholder="Category"
          className="h-8 w-36"
          list="note-categories"
          value={draft.category}
          maxLength={NOTE_CATEGORY_MAX}
          onChange={(event) => onDraftChange({ ...draft, category: event.target.value })}
        />
        <datalist id="note-categories">
          {categories.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>
        <Button
          size="sm"
          disabled={!dirty || busy || draft.title.trim() === ''}
          onClick={() => void save()}
        >
          <Save />
          {dirty ? 'Save' : 'Saved'}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
          aria-pressed={note.pinned}
          disabled={busy}
          onClick={() => void update({ pinned: !note.pinned }, note.revision)}
        >
          {note.pinned ? <PinOff /> : <Pin />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More note actions">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={copyLink}>
              <LinkIcon />
              Copy link to this note
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => void update({ archived: !note.archived }, note.revision)}
            >
              {note.archived ? <ArchiveRestore /> : <Archive />}
              {note.archived ? 'Restore from archive' : 'Archive'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
              <Trash2 />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {(conflict || changedElsewhere) && (
        <Alert className="m-2 w-auto" role="alert" data-testid="note-conflict">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {conflict
                ? 'This note was changed elsewhere since you opened it. Your edits are not saved.'
                : 'This note was changed elsewhere. Saving will ask what to keep.'}
            </span>
            <span className="flex gap-2">
              <Button size="sm" variant="outline" onClick={onReload}>
                Reload (discard my edits)
              </Button>
              {conflict && (
                <Button size="sm" variant="destructive" onClick={() => void overwrite()}>
                  Save my version
                </Button>
              )}
            </span>
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="m-2 w-auto" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {note.archived && (
        <p className="text-muted-foreground border-b px-3 py-1 text-xs">
          This note is archived. It stays searchable in Archived.
        </p>
      )}

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-2 py-1">
        <div className="flex flex-wrap items-center" role="toolbar" aria-label="Formatting">
          {TOOLBAR.map(({ action, label, icon: Icon }) => (
            <Tooltip key={action}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label}
                  disabled={!showEditor}
                  onClick={() => applyAction(action)}
                >
                  <Icon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div className="bg-muted flex rounded-md p-0.5" role="group" aria-label="Editor mode">
          {MODES.map((option) => (
            <Button
              key={option.id}
              size="xs"
              variant={mode === option.id ? 'secondary' : 'ghost'}
              aria-pressed={mode === option.id}
              // Split needs width; narrow windows switch between Edit and Preview.
              className={cn(option.id === 'split' && 'hidden xl:inline-flex')}
              onClick={() => setMode(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {showEditor && (
          <div
            className={cn(
              'flex min-h-0 min-w-0 flex-1 flex-col p-2',
              mode === 'split' && 'xl:border-r',
            )}
          >
            <Textarea
              ref={textarea}
              aria-label="Note content (Markdown)"
              className="min-h-0 flex-1 resize-none font-mono text-sm [field-sizing:fixed]"
              value={draft.content}
              maxLength={NOTE_CONTENT_MAX}
              placeholder="Write Markdown: # headings, - lists, - [ ] checklists, ``` code, | tables |, [links](atlas:note/…)"
              onChange={(event) => onDraftChange({ ...draft, content: event.target.value })}
            />
          </div>
        )}
        {showPreview && (
          <div
            className={cn(
              'min-h-0 min-w-0 flex-1 overflow-y-auto p-4',
              // In split mode on narrow windows only the editor is shown.
              mode === 'split' && 'hidden xl:block',
            )}
          >
            {draft.content.trim() === '' ? (
              <p className="text-muted-foreground text-sm">Nothing to preview yet.</p>
            ) : (
              <MarkdownPreview
                markdown={draft.content}
                links={links}
                onOpenLink={(href) => onOpenLink(note, href)}
                onOpenExternal={(url) =>
                  void unwrap(api().notes.openExternal(url)).catch((caught: unknown) =>
                    setError(errorMessage(caught)),
                  )
                }
              />
            )}
          </div>
        )}
      </div>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this note?</AlertDialogTitle>
            <AlertDialogDescription>
              “{note.title}” will be deleted permanently. Archive it instead to keep it out of the
              way.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
