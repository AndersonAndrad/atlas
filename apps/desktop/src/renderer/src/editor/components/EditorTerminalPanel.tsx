import {
  isFinalTerminalStatus,
  type TerminalPreferences,
  type TerminalSession,
} from '@atlas/contracts';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TerminalPane, type TerminalContextAction } from '@/terminal/components/TerminalPane';
import type { useTerminalSessions } from '@/terminal/hooks/useTerminalSessions';

interface EditorTerminalPanelProps {
  projectId: string;
  projectName: string;
  terminals: ReturnType<typeof useTerminalSessions>;
  preferences: TerminalPreferences;
  onHide: () => void;
  onOpenGit: (terminalId: string) => void;
  onOpenPreflight: (terminalId: string) => void;
  onContextAction: (terminalId: string, action: TerminalContextAction) => void;
  onProjectInfo: () => void;
}

/**
 * A terminal of the project below the editor (FR-1109). It is one of the Engine's
 * terminals, shown with the same pane as the Terminals view; hiding it never stops it.
 */
export function EditorTerminalPanel(props: EditorTerminalPanelProps) {
  const { projectId, terminals } = props;
  const sessions = (terminals.sessions ?? []).filter((session) => session.projectId === projectId);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const session: TerminalSession | undefined =
    sessions.find((candidate) => candidate.id === chosen) ??
    sessions.find((candidate) => !isFinalTerminalStatus(candidate.status)) ??
    sessions[0];

  // A terminal chosen in another project is simply not among this project's sessions.
  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await unwrap(api().terminals.create({ projectId }));
      terminals.upsert(created);
      setChosen(created.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label="Editor terminal"
      data-testid="editor-terminal"
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs">
        <span className="text-muted-foreground font-semibold tracking-wide uppercase">
          Terminal
        </span>
        {sessions.length > 1 && session && (
          <Select value={session.id} onValueChange={setChosen}>
            <SelectTrigger
              size="sm"
              className="h-6 w-44 text-xs"
              aria-label="Terminal of the project"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sessions.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {error && (
          <span className="text-destructive truncate" role="alert">
            {error}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="xs" disabled={creating} onClick={() => void create()}>
            <Plus />
            New terminal
          </Button>
          <Button variant="ghost" size="xs" onClick={props.onHide}>
            Hide
          </Button>
        </span>
      </header>
      <div className="min-h-0 flex-1">
        {session ? (
          <TerminalPane
            paneId="editor-terminal"
            session={session}
            projectName={props.projectName}
            preferences={props.preferences}
            active={false}
            onlyPane
            onFocus={() => undefined}
            onHide={props.onHide}
            onRestart={() =>
              void unwrap(api().terminals.restart(session.id)).then(
                terminals.upsert,
                (caught: unknown) => setError(errorMessage(caught)),
              )
            }
            onCloseTab={() =>
              void unwrap(api().terminals.dismiss(session.id)).then(
                () => void terminals.reload(),
                (caught: unknown) => setError(errorMessage(caught)),
              )
            }
            onProjectInfo={props.onProjectInfo}
            onOpenGit={() => props.onOpenGit(session.id)}
            onOpenPreflight={() => props.onOpenPreflight(session.id)}
            onContextAction={(action) => props.onContextAction(session.id, action)}
            registerHandle={() => undefined}
          />
        ) : (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-sm">
            <p>No terminal is open in this project.</p>
            <Button size="sm" variant="secondary" disabled={creating} onClick={() => void create()}>
              <Plus />
              Open a terminal
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
