import { TERMINAL_TITLE_MAX_LENGTH, type TerminalSession } from '@atlas/contracts';
import { X } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { STATUS_LABELS } from '../format';
import { TerminalStatusDot } from './TerminalStatusDot';

interface TerminalTabsProps {
  sessions: TerminalSession[];
  /** Session shown in the active pane. */
  activeSessionId: string | undefined;
  /** Sessions currently shown in some pane. */
  visibleSessionIds: Set<string>;
  renamingId: string | null;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onStartRename: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onCancelRename: () => void;
}

/** One tab per terminal session of the project. */
export function TerminalTabs({
  sessions,
  activeSessionId,
  visibleSessionIds,
  renamingId,
  onSelect,
  onClose,
  onStartRename,
  onRename,
  onCancelRename,
}: TerminalTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (offset === 0) return;
    event.preventDefault();
    const tabs = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    if (!tabs || tabs.length === 0) return;
    tabs[(index + offset + tabs.length) % tabs.length]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Terminals"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
    >
      {sessions.map((session, index) => {
        const active = session.id === activeSessionId;
        const visible = visibleSessionIds.has(session.id);
        if (session.id === renamingId) {
          return (
            <RenameField
              key={session.id}
              session={session}
              onSubmit={(title) => onRename(session.id, title)}
              onCancel={onCancelRename}
            />
          );
        }
        return (
          <div
            key={session.id}
            className={cn(
              'group flex h-8 max-w-56 shrink-0 items-center rounded-md border border-transparent',
              active ? 'bg-accent border-border' : 'hover:bg-accent/50',
            )}
            data-testid="terminal-tab"
            data-session-id={session.id}
            data-visible={visible ? 'true' : 'false'}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className="focus-visible:ring-ring/50 flex h-full min-w-0 items-center gap-2 rounded-md pr-1 pl-2.5 text-xs outline-none focus-visible:ring-[3px]"
              title={`${session.title} — ${STATUS_LABELS[session.status]}. Double-click to rename.`}
              onClick={() => onSelect(session.id)}
              onDoubleClick={() => onStartRename(session.id)}
              onKeyDown={(event) => {
                if (event.key === 'F2') onStartRename(session.id);
                moveFocus(event, index);
              }}
            >
              <TerminalStatusDot status={session.status} />
              <span className={cn('truncate', !visible && 'text-muted-foreground')}>
                {session.title}
              </span>
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground hover:bg-background/60 focus-visible:ring-ring/50 mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-[3px]"
              aria-label={`Close ${session.title}`}
              title="Close terminal"
              onClick={() => onClose(session.id)}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function RenameField({
  session,
  onSubmit,
  onCancel,
}: {
  session: TerminalSession;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(session.title);
  const submit = () => {
    const title = value.trim();
    if (title === '' || title === session.title) onCancel();
    else onSubmit(title);
  };
  return (
    <Input
      autoFocus
      className="h-8 w-44 shrink-0 text-xs"
      aria-label="Terminal name"
      maxLength={TERMINAL_TITLE_MAX_LENGTH}
      value={value}
      onFocus={(event) => event.target.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={submit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') submit();
        if (event.key === 'Escape') onCancel();
      }}
    />
  );
}
