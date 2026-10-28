import type {
  AiProvider,
  ContextTarget,
  ContextTask,
  LlmWrapperStatus,
  TaskExecution,
  TaskExecutionMode,
  TaskTerminalBlocker,
  TaskTerminalOption,
} from '@atlas/contracts';
import { continuationPrompt } from '@atlas/context';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { cn } from '@/lib/utils';
import { useKeyedLoad } from '../hooks/useContextData';
import { DEFAULT_SELECTION, bundleSummary, selectionRequest } from './ContextPreview';

export const PROVIDER_NAMES: Record<AiProvider, string> = { claude: 'Claude Code', codex: 'Codex' };
const DEFAULT_PROFILE = '__default__';

const AVAILABILITY: Record<LlmWrapperStatus, string> = {
  wrapped: 'Available',
  shadowed: 'Available · status not tracked',
  unknown: 'Availability unknown · status not tracked',
  missing: 'Not installed',
};

const BLOCKERS: Record<TaskTerminalBlocker, string> = {
  disconnected: 'Disconnected',
  busy: 'Busy',
  'process-unknown': 'Cannot tell if idle',
  'unsupported-shell': 'Only zsh or bash',
  'ai-session-active': 'AI session active',
  'execution-active': 'Running a task',
};

interface ExecuteTaskDialogProps {
  target: ContextTarget;
  targetKey: string;
  /** Project or folder name. */
  label: string;
  task: ContextTask;
  onClose: () => void;
  /** The run was accepted; it continues if the dialog closes. */
  onStarted: (execution: TaskExecution) => void;
  /** "ATLAS team" continues in the Execute with ATLAS proposal (SDD-026 Task 02). */
  onExecuteWithAtlas: () => void;
}

type Mode = TaskExecutionMode | 'atlas';

/**
 * Runs a task with Claude Code or Codex in a new or an existing terminal (SDD-025 Task 02).
 * Everything that will happen is shown before the explicit confirmation; the Engine checks
 * the terminal and provider again when the run starts.
 */
export function ExecuteTaskDialog(props: ExecuteTaskDialogProps) {
  const { target, targetKey, task } = props;
  // One id per confirmation: retries and double clicks return the same run.
  const [requestId] = useState(() => crypto.randomUUID());
  const [mode, setMode] = useState<Mode>('new-terminal');
  const [chosenProvider, setProvider] = useState<AiProvider | null>(null);
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useKeyedLoad(`${targetKey}:execute:${task.id}`, () =>
    api().ai.taskExecutionOptions(target, task.id),
  );
  const providers = options.value?.providers ?? [];
  // Never preselect an unavailable provider.
  const provider =
    chosenProvider ??
    providers.find((item) => item.availability === 'wrapped')?.provider ??
    providers.find((item) => item.availability !== 'missing')?.provider ??
    null;
  const availability = providers.find((item) => item.provider === provider)?.availability;
  const profiles = (options.value?.profiles ?? []).filter((item) => item.provider === provider);
  const profile = profiles.find((item) => item.id === profileId) ?? null;
  const terminals = options.value?.terminals ?? [];
  const terminal = terminals.find((item) => item.terminalId === terminalId) ?? null;
  const otherProject = mode === 'existing-terminal' && terminal !== null && !terminal.sameProject;

  const selection = selectionRequest(DEFAULT_SELECTION);
  const bundle = useKeyedLoad(
    provider === null ? null : `${targetKey}:execute-bundle:${task.id}:${provider}`,
    () => api().context.bundle({ target, provider: provider!, taskId: task.id, ...selection }),
  );
  const preview = bundle.value ? continuationPrompt(bundle.value.markdown) : null;

  const ready =
    mode !== 'atlas' &&
    provider !== null &&
    availability !== 'missing' &&
    preview !== null &&
    (mode === 'new-terminal' || (terminal !== null && terminal.blocker === null)) &&
    (!otherProject || acknowledged);

  async function execute() {
    if (!ready || provider === null) return;
    setBusy(true);
    setError(null);
    try {
      const execution = await unwrap(
        api().ai.executeTask({
          requestId,
          target,
          taskId: task.id,
          provider,
          ...(profile ? { profileId: profile.id } : {}),
          mode,
          ...(mode === 'existing-terminal' && terminal ? { terminalId: terminal.terminalId } : {}),
          acknowledgeOtherProject: otherProject && acknowledged,
          // The same selection as the preview, so the reviewed text is what is sent.
          ...selection,
        }),
      );
      props.onStarted(execution);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues.length > 0
          ? caught.issues.map((issue) => issue.message).join(' ')
          : errorMessage(caught),
      );
      setBusy(false);
      // A terminal may have become busy or closed meanwhile.
      void options.reload();
    }
  }

  const destination =
    mode === 'new-terminal'
      ? `A new terminal in ${options.value?.directory ?? props.label}`
      : terminal
        ? `${terminal.title} (${terminal.currentCwd})`
        : 'Choose a terminal';

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="execute-task-dialog"
      >
        <DialogHeader>
          <DialogTitle>Execute task</DialogTitle>
          <DialogDescription>
            Runs the task with an AI provider in a terminal of {props.label}. Nothing starts until
            you confirm. A finished run asks for your review; it never marks the task done.
          </DialogDescription>
        </DialogHeader>

        <section className="flex min-w-0 flex-col gap-1 rounded-md border p-3" aria-label="Task">
          <span className="font-medium break-words">{task.title}</span>
          <p className="text-muted-foreground line-clamp-4 text-sm break-words whitespace-pre-wrap">
            {task.objective}
          </p>
          <span className="text-muted-foreground text-xs">{props.label}</span>
        </section>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Run in</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(
              [
                ['new-terminal', 'New terminal', 'Opens a terminal in the project folder.'],
                [
                  'existing-terminal',
                  'Existing terminal',
                  'Types into an idle zsh or bash terminal.',
                ],
                [
                  'atlas',
                  'ATLAS team',
                  'ATLAS proposes a team of members that run one after another.',
                ],
              ] as const
            ).map(([value, title, text]) => {
              const disabled = value === 'atlas' && !options.value?.atlasTeamsAvailable;
              return (
                <label
                  key={value}
                  className={cn(
                    'flex gap-2 rounded-md border p-2.5 text-sm',
                    disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                    mode === value && 'border-sidebar-primary bg-accent/40',
                  )}
                >
                  <input
                    type="radio"
                    name="execute-task-mode"
                    className="accent-sidebar-primary mt-0.5"
                    checked={mode === value}
                    disabled={disabled}
                    onChange={() => setMode(value)}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{title}</span>
                    <span className="text-muted-foreground text-xs">{text}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">Provider</legend>
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Provider">
              {providers.map((item) => (
                <label
                  key={item.provider}
                  className={cn(
                    'flex items-center gap-2 text-sm',
                    item.availability === 'missing' && 'opacity-60',
                  )}
                >
                  <input
                    type="radio"
                    name="execute-task-provider"
                    className="accent-sidebar-primary"
                    checked={provider === item.provider}
                    disabled={item.availability === 'missing'}
                    onChange={() => {
                      setProvider(item.provider);
                      setProfileId(DEFAULT_PROFILE);
                    }}
                  />
                  <span>{PROVIDER_NAMES[item.provider]}</span>
                  <span className="text-muted-foreground text-xs">
                    {AVAILABILITY[item.availability]}
                  </span>
                </label>
              ))}
              {options.value === null && !options.error && (
                <span className="text-muted-foreground text-xs">Checking providers…</span>
              )}
            </div>
          </fieldset>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="execute-task-profile">Account</Label>
            <Select value={profileId} onValueChange={setProfileId} disabled={provider === null}>
              <SelectTrigger id="execute-task-profile" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_PROFILE}>The CLI’s default account</SelectItem>
                {profiles.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.displayName}
                    {item.plan ? ` · ${item.plan}` : ''} · {item.status.toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {mode === 'existing-terminal' && (
          <fieldset className="flex min-w-0 flex-col gap-1.5" data-testid="execute-task-terminals">
            <legend className="mb-1 text-sm font-medium">Terminal</legend>
            {terminals.length === 0 && (
              <p className="text-muted-foreground text-sm">No terminals are open.</p>
            )}
            <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
              {terminals.map((item) => (
                <TerminalChoice
                  key={item.terminalId}
                  option={item}
                  checked={terminalId === item.terminalId}
                  onChoose={() => {
                    setTerminalId(item.terminalId);
                    setAcknowledged(false);
                  }}
                />
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              ATLAS clears any text left at the terminal’s prompt, then types the command.
            </p>
          </fieldset>
        )}

        {otherProject && terminal && (
          <Alert role="alert" className="border-warning/40" data-testid="execute-task-other">
            <TriangleAlert className="text-warning" />
            <AlertDescription className="flex flex-col gap-2">
              <span>
                This terminal is not in {props.label}
                {terminal.projectName ? ` (it belongs to ${terminal.projectName})` : ''}. The task
                would run in {terminal.currentCwd}.
              </span>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={acknowledged}
                  onCheckedChange={(checked) => setAcknowledged(checked === true)}
                />
                Run the task in this terminal anyway
              </label>
            </AlertDescription>
          </Alert>
        )}
        {availability !== undefined && availability !== 'wrapped' && availability !== 'missing' && (
          <Alert role="status" className="border-warning/40">
            <TriangleAlert className="text-warning" />
            <AlertDescription>
              ATLAS cannot follow this run: it will be recorded as untracked, without completion or
              failure status.
            </AlertDescription>
          </Alert>
        )}

        {preview !== null && (
          <section className="flex flex-col gap-1" aria-label="First message preview">
            <span className="text-muted-foreground text-xs">
              First message preview{bundle.value ? ` · ${bundleSummary(bundle.value)}` : ''}
            </span>
            <pre
              className="bg-muted/50 max-h-48 overflow-auto rounded border p-2 font-mono text-xs whitespace-pre-wrap"
              data-testid="execute-task-preview"
            >
              {preview}
            </pre>
          </section>
        )}

        {mode !== 'atlas' && provider !== null && (
          <dl
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border p-3 text-sm"
            aria-label="Execution summary"
            data-testid="execute-task-summary"
          >
            <dt className="text-muted-foreground">Task</dt>
            <dd className="break-words">{task.title}</dd>
            <dt className="text-muted-foreground">Project</dt>
            <dd className="break-words">{props.label}</dd>
            <dt className="text-muted-foreground">Provider</dt>
            <dd>
              {PROVIDER_NAMES[provider]} · {profile?.displayName ?? 'default account'}
            </dd>
            <dt className="text-muted-foreground">Terminal</dt>
            <dd className="break-words">{destination}</dd>
          </dl>
        )}

        {(error ?? options.error ?? bundle.error) && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="execute-task-error">
              {error ?? options.error ?? bundle.error}
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          {mode === 'atlas' ? (
            <Button onClick={props.onExecuteWithAtlas} disabled={busy}>
              Propose a team…
            </Button>
          ) : (
            <Button onClick={() => void execute()} disabled={!ready || busy}>
              {busy ? 'Starting…' : 'Run task'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TerminalChoice({
  option,
  checked,
  onChoose,
}: {
  option: TaskTerminalOption;
  checked: boolean;
  onChoose: () => void;
}) {
  const disabled = option.blocker !== null;
  return (
    <li>
      <label
        className={cn(
          'flex min-w-0 gap-2 rounded-md border p-2 text-sm',
          disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
          checked && 'border-sidebar-primary bg-accent/40',
        )}
        data-testid="execute-task-terminal"
      >
        <input
          type="radio"
          name="execute-task-terminal"
          className="accent-sidebar-primary mt-0.5"
          checked={checked}
          disabled={disabled}
          onChange={onChoose}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2">
            <span className="truncate font-medium">{option.title}</span>
            <span className="text-muted-foreground text-xs">
              {option.projectName ?? 'No project'} · {option.shellName}
            </span>
          </span>
          <span className="text-muted-foreground truncate text-xs">{option.currentCwd}</span>
        </span>
        <span
          className={cn(
            'shrink-0 self-start rounded px-1.5 py-0.5 text-[10px] font-medium',
            option.blocker === null
              ? 'bg-success/15 text-success'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {option.blocker === null
            ? option.sameProject
              ? 'Ready'
              : 'Ready · other project'
            : option.blocker === 'busy' && option.processName
              ? `Busy · ${option.processName}`
              : BLOCKERS[option.blocker]}
        </span>
      </label>
    </li>
  );
}
