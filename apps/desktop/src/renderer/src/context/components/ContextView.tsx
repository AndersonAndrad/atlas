import type { AiProvider, AiSession, ContextOverview, ContextTarget } from '@atlas/contracts';
import {
  ArrowUpDown,
  BookOpen,
  CircleCheck,
  Database,
  GitCommitHorizontal,
  ListChecks,
  Network,
  SquareTerminal,
  Target,
  Waypoints,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ProjectDetails } from '@/types';
import { targetKey } from '../format';
import { useContextTargets, useKeyedLoad } from '../hooks/useContextData';
import { DecisionsTab } from './DecisionsTab';
import { HandoffDialog, HandoffsTab } from './HandoffsTab';
import { MemoryTab } from './MemoryTab';
import { SessionsTab, SummaryDialog } from './SessionsTab';
import { StartAiDialog } from './StartAiDialog';
import { TasksTab } from './TasksTab';

/** A request from a terminal or project to act on its shared context. */
export interface ContextOpenRequest {
  projectId?: string;
  terminalId?: string;
  action: 'view' | 'continue' | 'handoff' | 'summary' | 'attach';
  provider?: AiProvider;
  nonce: number;
}

type ContextDialog =
  | { kind: 'start'; provider: AiProvider; taskId?: string; handoffId?: string }
  | { kind: 'handoff'; taskId?: string; sourceSessionId?: string }
  | { kind: 'summary'; session: AiSession }
  | { kind: 'bundle' }
  | null;

interface ContextViewProps {
  projects: ProjectDetails[];
  request: ContextOpenRequest | null;
  onRequestHandled: () => void;
  /** Called after an AI session was started in a terminal. */
  onAiStarted: (terminalId: string) => void;
}

/**
 * Shared Context: persistent, provider-independent memory per project, repository
 * and task, with handoffs between Claude Code, Codex and later sessions.
 */
export function ContextView({
  projects,
  request,
  onRequestHandled,
  onAiStarted,
}: ContextViewProps) {
  const options = useContextTargets(projects);
  const [chosen, setChosen] = useState<string | null>(null);
  const [tab, setTab] = useState('overview');
  const [dialog, setDialog] = useState<ContextDialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [handledRequest, setHandledRequest] = useState<number | null>(null);

  const selected = options.find((option) => option.key === chosen) ?? options[0] ?? null;
  const target = selected?.target ?? null;
  const key = targetKey(target);
  const overview = useKeyedLoad(key === null ? null : `${key}:overview:${version}`, () =>
    api().context.overview(target!),
  );
  const changed = () => setVersion((value) => value + 1);

  // Requests from terminals or projects: resolve their target, then act once.
  if (request !== null && request.nonce !== handledRequest) {
    setHandledRequest(request.nonce);
    if (request.projectId) setChosen(`project:${request.projectId}`);
  }
  useEffect(() => {
    if (request === null) return;
    onRequestHandled();
    void (async () => {
      try {
        let resolved: ContextTarget | null = request.projectId
          ? { projectId: request.projectId }
          : null;
        if (request.terminalId) {
          const repositories = await unwrap(api().git.repositories());
          const entry = repositories.find((item) => item.terminalIds.includes(request.terminalId!));
          if (entry) {
            resolved = entry.projectIds[0]
              ? { projectId: entry.projectIds[0] }
              : { workspacePath: entry.repositoryRoot };
          }
        }
        if (resolved === null) {
          setError('This terminal is not in a registered project or Git repository.');
          return;
        }
        setChosen(targetKey(resolved));
        if (request.action === 'continue') {
          setDialog({ kind: 'start', provider: request.provider ?? 'claude' });
        } else if (request.action === 'handoff') {
          setDialog({ kind: 'handoff' });
        } else if (request.terminalId && request.action === 'summary') {
          const session = await unwrap(api().context.sessionForTerminal(request.terminalId));
          if (session === null) setNotice('This terminal has no active AI session to summarize.');
          else setDialog({ kind: 'summary', session });
        } else if (request.terminalId && request.action === 'attach') {
          await unwrap(api().ai.attach({ terminalId: request.terminalId }));
          setNotice('ATLAS now tracks this terminal. Save a session summary when you finish.');
          setTab('sessions');
          changed();
        }
      } catch (caught) {
        setError(errorMessage(caught));
      }
    })();
  }, [request, onRequestHandled]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="context-view">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">Shared Context</h1>
        {options.length > 0 && (
          <Select value={selected?.key} onValueChange={setChosen}>
            <SelectTrigger className="w-64 min-w-0 shrink" aria-label="Project or repository">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.key} value={option.key}>
                  {option.label}{' '}
                  <span className="text-muted-foreground text-xs">· {option.kind}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {notice && (
          <Alert role="status" data-testid="context-notice">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="context-error">{error}</AlertDescription>
          </Alert>
        )}
        {target === null || key === null ? (
          <div
            className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm"
            data-testid="context-empty"
          >
            <Database className="size-8" aria-hidden="true" />
            <p className="text-foreground font-medium">No project or repository yet</p>
            <p className="max-w-sm">
              Register a project, or open a terminal in a Git repository, to give it a shared
              memory.
            </p>
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab} className="min-w-0">
            <TabsList className="max-w-full justify-start overflow-x-auto [scrollbar-width:none]">
              <TabsTrigger value="overview" className="flex-none">
                Overview
              </TabsTrigger>
              <TabsTrigger value="memory" className="flex-none">
                Memory
              </TabsTrigger>
              <TabsTrigger value="tasks" className="flex-none">
                Tasks
              </TabsTrigger>
              <TabsTrigger value="decisions" className="flex-none">
                Decisions
              </TabsTrigger>
              <TabsTrigger value="sessions" className="flex-none">
                Sessions
              </TabsTrigger>
              <TabsTrigger value="handoffs" className="flex-none">
                Handoffs
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <Overview
                counts={overview.value}
                onStart={(provider) => setDialog({ kind: 'start', provider })}
                onPreview={() => setDialog({ kind: 'bundle' })}
                onHandoff={() => setDialog({ kind: 'handoff' })}
              />
            </TabsContent>
            <TabsContent value="memory">
              <MemoryTab key={key} target={target} targetKey={key} onChanged={changed} />
            </TabsContent>
            <TabsContent value="tasks">
              <TasksTab
                key={`${key}:${version}`}
                target={target}
                targetKey={key}
                onChanged={changed}
                onContinue={(provider, taskId) => setDialog({ kind: 'start', provider, taskId })}
                onHandoff={(taskId) => setDialog({ kind: 'handoff', taskId })}
              />
            </TabsContent>
            <TabsContent value="decisions">
              <DecisionsTab key={key} target={target} targetKey={key} onChanged={changed} />
            </TabsContent>
            <TabsContent value="sessions">
              <SessionsTab
                key={`${key}:${version}`}
                target={target}
                targetKey={key}
                onChanged={changed}
                onSummarize={(session) => setDialog({ kind: 'summary', session })}
              />
            </TabsContent>
            <TabsContent value="handoffs">
              <HandoffsTab
                key={`${key}:${version}`}
                target={target}
                targetKey={key}
                onCreate={() => setDialog({ kind: 'handoff' })}
                onContinue={(provider, handoff) =>
                  setDialog({
                    kind: 'start',
                    provider,
                    handoffId: handoff.id,
                    ...(handoff.taskId ? { taskId: handoff.taskId } : {}),
                  })
                }
              />
            </TabsContent>
          </Tabs>
        )}
      </div>

      {target && key && dialog?.kind === 'start' && (
        <StartAiDialog
          target={target}
          targetKey={key}
          label={selected!.label}
          provider={dialog.provider}
          {...(dialog.taskId ? { taskId: dialog.taskId } : {})}
          {...(dialog.handoffId ? { handoffId: dialog.handoffId } : {})}
          onClose={() => setDialog(null)}
          onStarted={(terminalId) => {
            setDialog(null);
            changed();
            onAiStarted(terminalId);
          }}
        />
      )}
      {target && key && dialog?.kind === 'handoff' && (
        <HandoffDialog
          target={target}
          targetKey={key}
          {...(dialog.taskId ? { taskId: dialog.taskId } : {})}
          {...(dialog.sourceSessionId ? { sourceSessionId: dialog.sourceSessionId } : {})}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            setTab('handoffs');
            changed();
          }}
        />
      )}
      {target && key && dialog?.kind === 'summary' && (
        <SummaryDialog
          target={target}
          targetKey={key}
          session={dialog.session}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            setNotice('Session summary saved to shared context.');
            changed();
          }}
        />
      )}
      {target && key && dialog?.kind === 'bundle' && (
        <BundleDialog target={target} targetKey={key} onClose={() => setDialog(null)} />
      )}
    </main>
  );
}

function Overview({
  counts,
  onStart,
  onPreview,
  onHandoff,
}: {
  counts: ContextOverview | null;
  onStart: (provider: AiProvider) => void;
  onPreview: () => void;
  onHandoff: () => void;
}) {
  const saved: [ReactNode, string, number | null][] = [
    [<Target key="t" />, 'Objectives and scope', counts?.tasks ?? null],
    [<GitCommitHorizontal key="c" />, 'Commits and changes', null],
    [<ListChecks key="l" />, 'Tasks and progress', counts?.openTasks ?? null],
    [<CircleCheck key="v" />, 'Tests and validations', null],
    [<BookOpen key="b" />, 'Technical decisions', counts?.decisions ?? null],
    [<Waypoints key="w" />, 'Next steps', counts?.pending ?? null],
  ];
  return (
    <section className="flex flex-col gap-4 rounded-xl border p-5" data-testid="context-overview">
      <div className="flex flex-col items-center gap-1 text-center">
        <Database className="text-sky-400 size-5" aria-hidden="true" />
        <h2 className="text-lg font-semibold">ATLAS Shared Context</h2>
        <p className="text-muted-foreground text-sm">
          Persistent memory per workspace, project and task
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(['claude', 'codex'] as const).map((provider) => (
          <div
            key={provider}
            className="flex flex-col items-center gap-1 rounded-lg border p-3 text-center"
          >
            <SquareTerminal className="size-4" aria-hidden="true" />
            <span className="font-medium">{provider === 'claude' ? 'Claude' : 'Codex'}</span>
            <span className="text-muted-foreground text-sm">Ordinary session</span>
            <Button size="xs" variant="outline" className="mt-1" onClick={() => onStart(provider)}>
              Start with context
            </Button>
          </div>
        ))}
        <div className="flex flex-col items-center gap-1 rounded-lg border p-3 text-center opacity-70">
          <Network className="size-4" aria-hidden="true" />
          <span className="font-medium">ATLAS</span>
          <span className="text-muted-foreground text-sm">Multi-agent team</span>
          <span className="text-muted-foreground mt-1 text-xs">
            Arrives with SDD-005 Milestone B
          </span>
        </div>
      </div>
      <p className="text-success flex items-center justify-center gap-2 text-sm">
        <ArrowUpDown className="size-4" aria-hidden="true" />
        Controlled reading, updates and handoffs
      </p>
      <div className="rounded-lg border p-4">
        <h3 className="mb-3 font-semibold">What is saved</h3>
        <ul className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          {saved.map(([icon, label, count]) => (
            <li key={label} className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0">
              {icon}
              <span>{label}</span>
              {count !== null && (
                <span className="text-muted-foreground ml-auto text-xs tabular-nums">{count}</span>
              )}
            </li>
          ))}
        </ul>
        {counts && (
          <p className="text-muted-foreground mt-3 text-xs" data-testid="context-counts">
            {counts.entries} entries · {counts.sessions} AI sessions ({counts.activeSessions}{' '}
            active) · {counts.handoffs} handoffs
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="outline" onClick={onPreview}>
          Preview context
        </Button>
        <Button variant="outline" onClick={onHandoff}>
          Prepare handoff
        </Button>
      </div>
    </section>
  );
}

function BundleDialog({
  target,
  targetKey: key,
  onClose,
}: {
  target: ContextTarget;
  targetKey: string;
  onClose: () => void;
}) {
  const bundle = useKeyedLoad(`${key}:preview`, () => api().context.bundle({ target }));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="context-bundle-dialog"
      >
        <DialogHeader>
          <DialogTitle>Context bundle</DialogTitle>
          <DialogDescription>
            {bundle.value
              ? `~${bundle.value.tokenEstimate} tokens · ${bundle.value.freshness.stale.length} stale item(s)` +
                (bundle.value.omitted ? ` · ${bundle.value.omitted} left out` : '')
              : (bundle.error ?? 'Checking the repository…')}
          </DialogDescription>
        </DialogHeader>
        <pre
          className="bg-muted/50 max-h-[60vh] overflow-auto rounded border p-3 font-mono text-xs whitespace-pre-wrap"
          data-testid="context-bundle"
        >
          {bundle.value?.markdown ?? ''}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
