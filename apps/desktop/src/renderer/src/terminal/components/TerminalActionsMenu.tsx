import {
  Activity,
  Columns2,
  CopyPlus,
  Download,
  Eraser,
  GitBranch,
  GitCommitHorizontal,
  Info,
  ListChecks,
  ListTree,
  Pencil,
  RefreshCw,
  RotateCcw,
  Rows2,
  SquareCode,
  Upload,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useRef } from 'react';
import { ActionDot } from '@/components/git/ActionDot';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { TerminalActionId } from '../state/terminal-actions';

interface Entry {
  id: TerminalActionId;
  label: string;
  icon: LucideIcon;
}

const SECTIONS: { title: string; entries: Entry[] }[] = [
  {
    title: 'Git',
    entries: [
      { id: 'branch', label: 'Switch branch…', icon: GitBranch },
      { id: 'status', label: 'View Git status', icon: ListTree },
      { id: 'fetch', label: 'Fetch', icon: RefreshCw },
      { id: 'pull', label: 'Pull…', icon: Download },
      { id: 'push', label: 'Push…', icon: Upload },
      { id: 'commit', label: 'Commit…', icon: GitCommitHorizontal },
      { id: 'operations', label: 'Git operations', icon: Activity },
    ],
  },
  {
    title: 'Project',
    entries: [
      { id: 'project-details', label: 'Project details', icon: Info },
      { id: 'editor', label: 'Open in editor', icon: SquareCode },
      { id: 'tasks', label: 'Open tasks', icon: ListChecks },
      { id: 'refresh', label: 'Refresh project info', icon: Zap },
    ],
  },
  {
    title: 'Terminal',
    entries: [
      { id: 'rename', label: 'Rename…', icon: Pencil },
      { id: 'split-right', label: 'Split right', icon: Columns2 },
      { id: 'split-down', label: 'Split down', icon: Rows2 },
      { id: 'duplicate', label: 'Duplicate', icon: CopyPlus },
      { id: 'clear', label: 'Clear output', icon: Eraser },
      { id: 'restart', label: 'Restart', icon: RotateCcw },
      { id: 'close', label: 'Close…', icon: X },
    ],
  },
];

interface TerminalActionsMenuProps {
  /** Null: enabled; text: disabled, with the reason shown under the action. */
  availability: Record<TerminalActionId, string | null>;
  /** Pending Git work of the repository (e.g. commits to push), shown as a dot. */
  pending: string[];
  gitRunning: boolean;
  gitFailure: boolean;
  /** Labels that depend on the state, e.g. "Fetching…". */
  labels?: Partial<Record<TerminalActionId, string>>;
  onAction: (id: TerminalActionId) => void;
}

/**
 * The Actions menu of a terminal (SDD-023 Task A04): its Git, project and terminal
 * actions in one place, through the dialogs and services ATLAS already has. Opening it
 * runs nothing; each entry only opens its dialog or does what its label says.
 */
export function TerminalActionsMenu(props: TerminalActionsMenuProps) {
  // After an action, focus belongs to what it opened (a dialog, the tab being renamed, a
  // new pane); only a dismissed menu returns focus to its button.
  const acted = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="relative h-6 gap-1 px-1.5"
          aria-label="Actions"
          title={['Actions', ...props.pending].join(' · ')}
          data-testid="terminal-actions-button"
        >
          {props.gitRunning ? <Activity className="text-sky-400" /> : <GitBranch />}
          <span className="hidden lg:inline">Actions</span>
          <ActionDot reasons={props.pending} />
          {props.gitFailure && (
            <span
              className="bg-destructive ring-background pointer-events-none absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
              aria-hidden="true"
              data-testid="git-operations-failure-dot"
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64"
        data-testid="terminal-actions-menu"
        onCloseAutoFocus={(event) => {
          if (acted.current) event.preventDefault();
          acted.current = false;
        }}
      >
        {SECTIONS.map((section, index) => (
          <DropdownMenuGroup key={section.title}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              {section.title}
            </DropdownMenuLabel>
            {section.entries.map((entry) => {
              const reason = props.availability[entry.id];
              return (
                <DropdownMenuItem
                  key={entry.id}
                  disabled={reason !== null}
                  onSelect={() => {
                    acted.current = true;
                    props.onAction(entry.id);
                  }}
                  data-testid={`terminal-action-${entry.id}`}
                  className="items-start"
                >
                  <entry.icon className="mt-0.5" />
                  <span className="flex min-w-0 flex-col">
                    <span>{props.labels?.[entry.id] ?? entry.label}</span>
                    {reason !== null && (
                      <span className="text-muted-foreground text-[11px] leading-tight">
                        {reason}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
