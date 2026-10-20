import {
  TERMINAL_FONT_FAMILIES,
  type ShellCatalog,
  type TerminalFontFamily,
  type TerminalPreferences,
  type UpdateTerminalPreferencesInput,
} from '@atlas/contracts';
import {
  ChevronDown,
  Columns2,
  Maximize2,
  Plus,
  Rows2,
  Settings2,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ProjectDetails } from '@/types';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FONT_FAMILIES } from '../state/terminal-view';

const SYSTEM_DEFAULT = '__system__';

/** How a new terminal starts: default directory unless a project or folder is chosen. */
export interface NewTerminalOptions {
  shellId?: string;
  projectId?: string;
  /** Ask for a folder in the native picker first. */
  chooseFolder?: boolean;
}

interface TerminalToolbarProps {
  shells: ShellCatalog | null;
  projects: ProjectDetails[];
  preferences: TerminalPreferences;
  canSplit: boolean;
  hasSplit: boolean;
  disabled: boolean;
  onNewTerminal: (options?: NewTerminalOptions) => void;
  onSplit: (direction: 'row' | 'column') => void;
  onSinglePane: () => void;
  onFontSize: (delta: number | 'reset') => void;
  onPreferences: (changes: UpdateTerminalPreferencesInput) => void;
}

function IconAction({
  label,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <span className="text-muted-foreground ml-1">{shortcut}</span>
      </TooltipContent>
    </Tooltip>
  );
}

const isMac = navigator.userAgent.includes('Mac');
const keys = (mac: string, other: string) => (isMac ? mac : other);

export function TerminalToolbar({
  shells,
  projects,
  preferences,
  canSplit,
  hasSplit,
  disabled,
  onNewTerminal,
  onSplit,
  onSinglePane,
  onFontSize,
  onPreferences,
}: TerminalToolbarProps) {
  const availableShells = shells?.shells ?? [];
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <div className="flex items-center">
        <Button
          size="sm"
          className="rounded-r-none"
          disabled={disabled}
          onClick={() => onNewTerminal()}
          title={`New terminal (${keys('⌘T', 'Ctrl+Shift+T')})`}
        >
          <Plus />
          <span className="hidden sm:inline">New terminal</span>
          <span className="sr-only sm:hidden">New terminal</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              className="border-primary-foreground/20 rounded-l-none border-l px-1.5"
              disabled={disabled}
              aria-label="More ways to open a terminal"
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64" data-testid="shell-menu">
            <DropdownMenuItem onSelect={() => onNewTerminal({ chooseFolder: true })}>
              Open in folder…
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={projects.length === 0}>
                Open in project
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                {projects.map((item) => (
                  <DropdownMenuItem
                    key={item.project.id}
                    disabled={item.availability.status !== 'available'}
                    onSelect={() => onNewTerminal({ projectId: item.project.id })}
                  >
                    {item.project.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>New terminal with</DropdownMenuLabel>
            {availableShells.map((shell) => (
              <DropdownMenuItem
                key={shell.id}
                onSelect={() => onNewTerminal({ shellId: shell.id })}
              >
                <span className="truncate">{shell.name}</span>
                <span className="text-muted-foreground ml-auto truncate pl-3 font-mono text-[10px]">
                  {shell.source === 'custom' ? 'custom' : shell.path}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <IconAction
        label="Split right"
        shortcut={keys('⌘D', 'Ctrl+Shift+D')}
        disabled={disabled || !canSplit}
        onClick={() => onSplit('row')}
      >
        <Columns2 />
      </IconAction>
      <IconAction
        label="Split down"
        shortcut={keys('⇧⌘D', 'Ctrl+Shift+E')}
        disabled={disabled || !canSplit}
        onClick={() => onSplit('column')}
      >
        <Rows2 />
      </IconAction>
      <IconAction label="Single pane" shortcut="" disabled={!hasSplit} onClick={onSinglePane}>
        <Maximize2 />
      </IconAction>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Terminal settings">
            <Settings2 />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64" data-testid="terminal-settings">
          <DropdownMenuLabel>Font size: {preferences.fontSize}px</DropdownMenuLabel>
          <DropdownMenuItem onSelect={(event) => (event.preventDefault(), onFontSize(1))}>
            Increase font size
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={(event) => (event.preventDefault(), onFontSize(-1))}>
            Decrease font size
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onFontSize('reset')}>Reset font size</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Font</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={preferences.fontFamily}
            onValueChange={(value) => onPreferences({ fontFamily: value as TerminalFontFamily })}
          >
            {TERMINAL_FONT_FAMILIES.map((family) => (
              <DropdownMenuRadioItem key={family} value={family}>
                {FONT_FAMILIES[family].label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Default shell</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={preferences.defaultShellId ?? SYSTEM_DEFAULT}
            onValueChange={(value) =>
              onPreferences({ defaultShellId: value === SYSTEM_DEFAULT ? null : value })
            }
          >
            <DropdownMenuRadioItem value={SYSTEM_DEFAULT}>System default</DropdownMenuRadioItem>
            {availableShells.map((shell) => (
              <DropdownMenuRadioItem key={shell.id} value={shell.id}>
                {shell.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {shells !== null && shells.configurationIssues.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <div className="text-warning flex gap-2 px-2 py-1.5 text-xs" role="note">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <ul className="flex flex-col gap-1">
                  {shells.configurationIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
