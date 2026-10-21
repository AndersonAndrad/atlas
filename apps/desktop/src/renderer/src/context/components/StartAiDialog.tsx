import type { AiProvider, ContextTarget } from '@atlas/contracts';
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
import {
  BundleRecords,
  DEFAULT_SELECTION,
  SelectionFields,
  bundleSummary,
  selectionRequest,
} from './ContextPreview';

type Source = 'context' | 'handoff' | 'none';
const NO_TASK = '__none__';

interface StartAiDialogProps {
  target: ContextTarget;
  targetKey: string;
  label: string;
  provider: AiProvider;
  taskId?: string;
  handoffId?: string;
  onClose: () => void;
  onStarted: (terminalId: string) => void;
}

const PROVIDER_NAMES: Record<AiProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * Starts Claude Code or Codex in a new ATLAS terminal. The exact first prompt is
 * shown for review before anything is sent to the provider.
 */
export function StartAiDialog(props: StartAiDialogProps) {
  const [provider, setProvider] = useState<AiProvider>(props.provider);
  const [taskId, setTaskId] = useState<string>(props.taskId ?? NO_TASK);
  const [source, setSource] = useState<Source>(props.handoffId ? 'handoff' : 'context');
  const [handoffId, setHandoffId] = useState<string | null>(props.handoffId ?? null);
  const [selection, setSelection] = useState(DEFAULT_SELECTION);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tasks = useKeyedLoad(`${props.targetKey}:tasks`, () => api().context.tasks(props.target));
  const handoffs = useKeyedLoad(`${props.targetKey}:handoffs`, () =>
    api().context.handoffs(props.target),
  );
  const skills = useKeyedLoad('start-ai-skills', () => api().skills.list());
  const task = taskId === NO_TASK ? undefined : taskId;
  const bundle = useKeyedLoad(
    source === 'context'
      ? `${props.targetKey}:bundle:${provider}:${taskId}:${JSON.stringify(selection)}`
      : null,
    () =>
      api().context.bundle({
        target: props.target,
        provider,
        ...(task ? { taskId: task } : {}),
        ...selectionRequest(selection),
      }),
  );
  const handoff = useKeyedLoad(
    source === 'handoff' && handoffId !== null ? `${props.targetKey}:handoff:${handoffId}` : null,
    () => api().context.handoff(props.target, handoffId!),
  );

  // Exactly what the Engine sends: the same wrapper around the same content.
  const content =
    source === 'context'
      ? (bundle.value?.markdown ?? null)
      : source === 'handoff'
        ? (handoff.value?.markdown ?? null)
        : null;
  const preview = content === null ? null : continuationPrompt(content);
  const ready = source === 'none' || preview !== null;

  async function start() {
    // The objective applies on blur: a click right after typing changes the selection,
    // and nothing is sent until its preview has been shown.
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const started = await unwrap(
        api().ai.start({
          provider,
          target: props.target,
          ...(task ? { taskId: task } : {}),
          ...(source === 'handoff' && handoffId ? { handoffId } : {}),
          includeContext: source === 'context',
          // Same selection as the preview, so the reviewed text is what is sent.
          ...(source === 'context' ? selectionRequest(selection) : {}),
        }),
      );
      props.onStarted(started.terminalId);
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
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="start-ai-dialog"
      >
        <DialogHeader>
          <DialogTitle>Start {PROVIDER_NAMES[provider]}</DialogTitle>
          <DialogDescription>
            Opens {PROVIDER_NAMES[provider]} in a new terminal in {props.label}. ATLAS sends only
            the text below as its first message and never reads the provider’s conversation.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>Provider</Label>
            <div className="flex gap-2" role="radiogroup" aria-label="Provider">
              {(['claude', 'codex'] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={provider === value}
                  variant={provider === value ? 'default' : 'outline'}
                  onClick={() => setProvider(value)}
                >
                  {PROVIDER_NAMES[value]}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="start-ai-task">Task</Label>
            <Select value={taskId} onValueChange={setTaskId}>
              <SelectTrigger id="start-ai-task" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TASK}>No specific task</SelectItem>
                {(tasks.value ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">What to send</legend>
          {(
            [
              [
                'context',
                'Stored context',
                'A compact bundle of this project’s memory, checked against the repository now.',
              ],
              [
                'handoff',
                'A handoff',
                'Continue from a handoff prepared earlier (e.g. from another provider).',
              ],
              ['none', 'Nothing', 'Start the provider without any ATLAS context.'],
            ] as const
          ).map(([value, title, text]) => (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer gap-3 rounded-md border p-2.5 text-sm',
                source === value && 'border-sidebar-primary bg-accent/40',
              )}
            >
              <input
                type="radio"
                name="start-ai-source"
                className="accent-sidebar-primary mt-0.5"
                checked={source === value}
                onChange={() => setSource(value)}
              />
              <span className="flex flex-col">
                <span className="font-medium">{title}</span>
                <span className="text-muted-foreground text-xs">{text}</span>
              </span>
            </label>
          ))}
          {source === 'handoff' && (
            <Select value={handoffId ?? undefined} onValueChange={setHandoffId}>
              <SelectTrigger aria-label="Handoff" className="w-full">
                <SelectValue placeholder="Choose a handoff" />
              </SelectTrigger>
              <SelectContent>
                {(handoffs.value ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {new Date(item.createdAt).toLocaleString()} — {item.objective.slice(0, 60)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </fieldset>

        {source === 'context' && <SelectionFields value={selection} onChange={setSelection} />}
        {source === 'context' && (skills.value ?? []).some((skill) => skill.validation.valid) && (
          <fieldset className="flex flex-col gap-1" data-testid="start-ai-skills">
            <legend className="mb-1 text-sm font-medium">Skills for this session</legend>
            {(skills.value ?? [])
              .filter((skill) => skill.validation.valid)
              .map((skill) => {
                const active = bundle.value?.skills.find((item) => item.skillId === skill.id);
                const chosen = selection.skillIds.includes(skill.id);
                const byRule = active !== undefined && !chosen;
                return (
                  <label key={skill.id} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={active !== undefined || chosen}
                      disabled={byRule}
                      onCheckedChange={(checked) =>
                        setSelection({
                          ...selection,
                          skillIds:
                            checked === true
                              ? [...selection.skillIds, skill.id]
                              : selection.skillIds.filter((id) => id !== skill.id),
                        })
                      }
                    />
                    <span className="flex flex-col">
                      <span>{skill.name}</span>
                      <span className="text-muted-foreground text-xs">
                        {byRule ? active.reason : skill.description.slice(0, 160)}
                      </span>
                    </span>
                  </label>
                );
              })}
          </fieldset>
        )}
        {source === 'context' && bundle.value && bundle.value.freshness.stale.length > 0 && (
          <Alert role="status" className="border-warning/40">
            <TriangleAlert className="text-warning" />
            <AlertDescription>
              {bundle.value.freshness.stale.length} item(s) may be outdated; they are marked STALE
              in the context.
            </AlertDescription>
          </Alert>
        )}
        {source === 'context' && bundle.value && (
          <details className="rounded-md border p-2" data-testid="start-ai-records">
            <summary className="cursor-pointer text-sm">
              Review records ({bundle.value.included.length} included,{' '}
              {bundle.value.excluded.length} left out)
            </summary>
            <div className="pt-2">
              <BundleRecords
                bundle={bundle.value}
                excludeIds={selection.excludeIds}
                onExcludeChange={(excludeIds) => setSelection({ ...selection, excludeIds })}
              />
            </div>
          </details>
        )}
        {preview !== null && (
          <section className="flex flex-col gap-1" aria-label="First message preview">
            <span className="text-muted-foreground text-xs">
              First message preview
              {source === 'context' && bundle.value ? ` · ${bundleSummary(bundle.value)}` : ''}
            </span>
            <pre
              className="bg-muted/50 max-h-64 overflow-auto rounded border p-2 font-mono text-xs whitespace-pre-wrap"
              data-testid="start-ai-preview"
            >
              {preview}
            </pre>
          </section>
        )}
        {(error ?? bundle.error ?? handoff.error) && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error ?? bundle.error ?? handoff.error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void start()} disabled={!ready || busy}>
            {busy ? 'Starting…' : `Start ${PROVIDER_NAMES[provider]}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
