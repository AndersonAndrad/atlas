import {
  parseNoteLink,
  type NoteScope,
  type NoteSummary,
  type ProjectNote,
} from '@atlas/contracts';
import { ListChecks, NotebookPen, Pin, Plug, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { useProjects } from '@/hooks/useProjects';
import { cn } from '@/lib/utils';
import { scopeFromKey, scopeKey, useNoteList } from '../hooks/useNotes';
import { NotesPanel } from './NotesPanel';

type HubTab = 'overview' | 'notes' | 'tasks' | 'jira';
const TABS: { id: HubTab; label: string; available: boolean; hint?: string }[] = [
  { id: 'overview', label: 'Overview', available: true },
  { id: 'notes', label: 'Notes', available: true },
  { id: 'tasks', label: 'Tasks', available: false, hint: 'Local tasks arrive in a later release.' },
  {
    id: 'jira',
    label: 'Jira',
    available: false,
    hint: 'Jira connections arrive in a later release.',
  },
];

interface ProjectHubViewProps {
  projects: ReturnType<typeof useProjects>;
  onOpenSession: (sessionId: string) => void;
  onOpenGit: (projectId: string) => void;
}

/**
 * Project Hub (SDD-010): local, offline organization of a project's knowledge. Milestone A
 * brings notes; tasks and Jira are shown as upcoming and hold no data.
 */
export function ProjectHubView({ projects, onOpenSession, onOpenGit }: ProjectHubViewProps) {
  const items = projects.items ?? [];
  const [chosenScope, setChosenScope] = useState<string | null>(null);
  // Until the user chooses, follow the selected project (or global notes without one).
  const key =
    chosenScope ?? (projects.selectedId === null ? 'global' : `project:${projects.selectedId}`);
  const known =
    !key.startsWith('project:') || items.some((item) => `project:${item.project.id}` === key);
  const scope: NoteScope = known ? scopeFromKey(key) : { kind: 'global' };
  const [tab, setTab] = useState<HubTab>('overview');
  const [openRequest, setOpenRequest] = useState<{ noteId: string; nonce: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clearOpenRequest = useCallback(() => setOpenRequest(null), []);

  const projectName = (id: string) =>
    items.find((item) => item.project.id === id)?.project.name ?? null;
  const ownerLabel = (note: NoteSummary) => {
    if (note.projectId !== null) return projectName(note.projectId) ?? 'Project';
    if (note.workspacePath !== null) {
      return note.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? note.workspacePath;
    }
    return 'Global';
  };

  const openNote = (noteId: string) => {
    setTab('notes');
    setOpenRequest({ noteId, nonce: Date.now() });
  };

  /** Follows an `atlas:` link of a note; files are only revealed, never opened (Q4). */
  async function openLink(note: ProjectNote, href: string, openInPanel: (id: string) => void) {
    setNotice(null);
    const link = parseNoteLink(href);
    if (link === null) {
      setNotice('This link is not valid.');
      return;
    }
    switch (link.kind) {
      case 'note':
        openInPanel(link.id);
        return;
      case 'session':
        onOpenSession(link.id);
        return;
      case 'branch':
        if (note.projectId === null) setNotice('Branch links work in notes of a project.');
        else onOpenGit(note.projectId);
        return;
      case 'file':
        if (note.projectId === null) {
          setNotice('File links work in notes of a project.');
          return;
        }
        try {
          await unwrap(api().notes.revealFile({ projectId: note.projectId, href }));
        } catch (caught) {
          setNotice(errorMessage(caught));
        }
    }
  }

  const selectedProject =
    scope.kind === 'project' ? items.find((item) => item.project.id === scope.projectId) : null;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="hub-view">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">Project Hub</h1>
        <Select value={scopeKey(scope)} onValueChange={setChosenScope}>
          <SelectTrigger size="sm" className="w-56 max-w-full" aria-label="Project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.project.id} value={`project:${item.project.id}`}>
                {item.project.name}
              </SelectItem>
            ))}
            <SelectItem value="global">Global notes</SelectItem>
            <SelectItem value="all">All notes</SelectItem>
          </SelectContent>
        </Select>
      </header>

      <nav
        className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2"
        aria-label="Project Hub sections"
      >
        {TABS.map((option) => (
          <Button
            key={option.id}
            size="xs"
            className="rounded-full"
            variant={tab === option.id ? 'secondary' : 'ghost'}
            aria-current={tab === option.id ? 'page' : undefined}
            disabled={!option.available}
            title={option.hint}
            onClick={() => setTab(option.id)}
          >
            {option.label}
            {!option.available && <span className="text-muted-foreground">· soon</span>}
          </Button>
        ))}
      </nav>

      {notice && (
        <Alert className="mx-4 mt-2 w-auto" role="alert" data-testid="hub-notice">
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{notice}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss message"
              onClick={() => setNotice(null)}
            >
              <X />
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {tab === 'overview' && (
        <HubOverview
          scope={scope}
          title={
            selectedProject?.project.name ?? (scope.kind === 'all' ? 'All notes' : 'Global notes')
          }
          description={
            selectedProject
              ? (selectedProject.project.description ?? selectedProject.project.workspacePath)
              : 'Notes that belong to no project.'
          }
          onOpenNote={openNote}
          onShowNotes={() => setTab('notes')}
        />
      )}
      {tab === 'notes' && (
        <NotesPanel
          key={scopeKey(scope)}
          scope={scope}
          ownerLabel={ownerLabel}
          openRequest={openRequest}
          onOpenRequestHandled={clearOpenRequest}
          onOpenLink={(note, href, openInPanel) => void openLink(note, href, openInPanel)}
        />
      )}
    </main>
  );
}

interface HubOverviewProps {
  scope: NoteScope;
  title: string;
  description: string;
  onOpenNote: (noteId: string) => void;
  onShowNotes: () => void;
}

/** Compact overview (FR-1019): note counts and the notes worth opening first. */
function HubOverview({ scope, title, description, onOpenNote, onShowNotes }: HubOverviewProps) {
  const recent = useNoteList({ scope, filter: 'active', limit: 5 });
  const pinned = useNoteList({ scope, filter: 'pinned', limit: 5 });
  const counts = recent.value?.counts;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="hub-overview">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          <p className="text-muted-foreground truncate text-sm">{description}</p>
        </div>
        {(recent.error ?? pinned.error) && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{recent.error ?? pinned.error}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Card className="gap-2 py-4">
            <CardHeader className="px-4">
              <CardTitle className="flex items-center gap-2 text-sm">
                <NotebookPen className="size-4" aria-hidden />
                Notes
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              <button
                type="button"
                className="text-left"
                onClick={onShowNotes}
                data-testid="hub-notes-count"
              >
                <span className="block text-2xl font-semibold tabular-nums">
                  {counts?.active ?? '–'}
                </span>
                <span className="text-muted-foreground text-sm">
                  Documentation and decisions
                  {counts && counts.archived > 0 ? ` · ${counts.archived} archived` : ''}
                </span>
              </button>
            </CardContent>
          </Card>
          <Card className="gap-2 py-4 opacity-70" aria-disabled>
            <CardHeader className="px-4">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ListChecks className="size-4" aria-hidden />
                Tasks
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              <span className="block text-2xl font-semibold">–</span>
              <span className="text-muted-foreground text-sm">
                Local TODO lists arrive in a later release.
              </span>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <NoteShortlist
            title="Pinned notes"
            empty="Pin important notes to keep them here."
            notes={pinned.value?.notes ?? null}
            onOpenNote={onOpenNote}
          />
          <NoteShortlist
            title="Recent notes"
            empty="No notes yet."
            notes={recent.value?.notes ?? null}
            onOpenNote={onOpenNote}
          />
        </div>

        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Plug className="size-4" aria-hidden />
          Jira connections arrive in a later release.
        </p>
      </div>
    </div>
  );
}

function NoteShortlist({
  title,
  empty,
  notes,
  onOpenNote,
}: {
  title: string;
  empty: string;
  notes: NoteSummary[] | null;
  onOpenNote: (noteId: string) => void;
}) {
  return (
    <section className="min-w-0 rounded-lg border p-3" aria-label={title}>
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      {notes?.length === 0 && <p className="text-muted-foreground text-sm">{empty}</p>}
      <ul className="flex flex-col">
        {notes?.map((note) => (
          <li key={note.id}>
            <button
              type="button"
              className={cn(
                'hover:bg-accent flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm',
              )}
              onClick={() => onOpenNote(note.id)}
            >
              {note.pinned && <Pin className="size-3 shrink-0" aria-label="Pinned" />}
              <span className="truncate">{note.title}</span>
              <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                {new Date(note.updatedAt).toLocaleDateString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
