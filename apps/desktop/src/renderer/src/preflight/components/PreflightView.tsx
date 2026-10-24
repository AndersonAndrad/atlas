import type {
  PreflightCheck,
  PreflightConfig,
  PreflightDiscovery,
  PreflightPlan,
  PreflightProfile,
  PreflightRun,
  PreflightSelection,
  PreflightWorkspace,
  WorkflowJobSummary,
  WorkflowSummary,
} from '@atlas/contracts';
import {
  FolderPlus,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useKeyedLoad } from '@/context/hooks/useContextData';
import { cn } from '@/lib/utils';
import type { ProjectDetails } from '@/types';
import {
  CATEGORY_LABELS,
  COMPATIBILITY_LABELS,
  RUN_STATUS_LABELS,
  STATUS_LABELS,
  blankCheck,
  checkSummary,
  compatibilityClass,
  formatTime,
  newItemId,
  statusClass,
} from '../format';
import { AuthorizationDialog } from './AuthorizationDialog';
import { CheckForm } from './CheckForm';
import { RunPanel } from './RunPanel';

export interface PreflightOpenRequest {
  projectId?: string;
  terminalId?: string;
  nonce: number;
}

const RUN_POLL_MS = 1000;
const PROJECT_PREFIX = 'project:';

type Tab = 'run' | 'checks' | 'profiles' | 'workflows' | 'history';

/** What the workspace selector lists: opened workspaces and projects not opened yet. */
function workspaceOptions(workspaces: PreflightWorkspace[], projects: ProjectDetails[]) {
  const opened = new Set(workspaces.map((workspace) => workspace.projectId).filter(Boolean));
  return [
    ...workspaces.map((workspace) => ({
      value: workspace.id,
      label: workspace.name,
      path: workspace.path,
    })),
    ...projects
      .filter((item) => !opened.has(item.project.id))
      .map((item) => ({
        value: `${PROJECT_PREFIX}${item.project.id}`,
        label: item.project.name,
        path: item.project.workspacePath,
      })),
  ];
}

/**
 * Preflight (SDD-007 Milestone A): checks, profiles and GitHub Actions workflows of a
 * project or folder, run locally without any AI provider, with their history.
 */
export function PreflightView({
  projects,
  request,
  onRequestHandled,
}: {
  projects: ProjectDetails[];
  request: PreflightOpenRequest | null;
  onRequestHandled: () => void;
}) {
  const [workspacesTick, setWorkspacesTick] = useState(0);
  const workspaces = useKeyedLoad(`preflight-workspaces:${workspacesTick}`, () =>
    api().preflight.workspaces(),
  );
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const openProject = useCallback(async (projectId: string) => {
    const workspace = await unwrap(api().preflight.openProject(projectId));
    setWorkspacesTick((value) => value + 1);
    setWorkspaceId(workspace.id);
  }, []);

  useEffect(() => {
    if (request === null) return;
    onRequestHandled();
    void (async () => {
      setError(null);
      setNotice(null);
      try {
        let projectId = request.projectId ?? null;
        if (projectId === null && request.terminalId !== undefined) {
          const context = await unwrap(api().terminals.projectContext(request.terminalId));
          projectId = context.associatedProjectId ?? context.matchedProjectId;
          if (projectId === null) {
            setNotice(
              'This terminal is not in a registered project. Register the folder as a project or add it here with "Add folder".',
            );
            return;
          }
        }
        if (projectId !== null) await openProject(projectId);
      } catch (caught) {
        setError(errorMessage(caught));
      }
    })();
  }, [request, onRequestHandled, openProject]);

  const options = workspaceOptions(workspaces.value ?? [], projects);
  const current =
    (workspaces.value ?? []).find((workspace) => workspace.id === workspaceId) ?? null;

  async function choose(value: string) {
    setError(null);
    try {
      if (value.startsWith(PROJECT_PREFIX)) await openProject(value.slice(PROJECT_PREFIX.length));
      else setWorkspaceId(value);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function addFolder() {
    setError(null);
    try {
      const choice = await unwrap(api().dialog.chooseDirectory('preflight-workspace'));
      if (choice.canceled || !choice.inspection) return;
      const folder = choice.inspection.resolvedPath ?? choice.inspection.inputPath;
      const workspace = await unwrap(api().preflight.addFolder(folder));
      setWorkspacesTick((value) => value + 1);
      setWorkspaceId(workspace.id);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="preflight-view">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">Preflight</h1>
        <Select value={workspaceId ?? undefined} onValueChange={(value) => void choose(value)}>
          <SelectTrigger size="sm" className="w-64 max-w-full" aria-label="Workspace">
            <SelectValue placeholder="Choose a project or folder" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value} title={option.path}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={() => void addFolder()}>
          <FolderPlus />
          Add folder
        </Button>
        <EnvironmentStatus />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {current === null ? (
          <div className="text-muted-foreground grid place-items-center gap-2 py-16 text-center text-sm">
            <ShieldCheck className="size-8" />
            <p>Choose a project or folder to configure and run its checks.</p>
            <p>Preflight runs locally and needs no AI account.</p>
          </div>
        ) : (
          <WorkspacePanel
            key={current.id}
            workspace={current}
            onRemoved={() => {
              setWorkspaceId(null);
              setWorkspacesTick((value) => value + 1);
            }}
          />
        )}
      </div>
    </main>
  );
}

function EnvironmentStatus() {
  const [tick, setTick] = useState(0);
  const status = useKeyedLoad(`preflight-environment:${tick}`, () =>
    api().preflight.environment(tick > 0),
  );
  const value = status.value;
  return (
    <div
      className="ml-auto flex max-w-full min-w-0 flex-wrap items-center gap-2 text-xs"
      data-testid="preflight-environment"
    >
      {value && (
        <>
          <Badge
            variant="outline"
            className={cn(
              'max-w-full whitespace-normal',
              value.act.available ? 'text-success' : 'text-muted-foreground',
            )}
          >
            act: {value.act.detail}
          </Badge>
          <Badge
            variant="outline"
            className={cn(
              'max-w-full whitespace-normal',
              value.docker.available ? 'text-success' : 'text-muted-foreground',
            )}
          >
            Docker: {value.docker.detail}
          </Badge>
        </>
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Check act and Docker again"
        onClick={() => setTick((current) => current + 1)}
      >
        <RefreshCw />
      </Button>
    </div>
  );
}

function WorkspacePanel({
  workspace,
  onRemoved,
}: {
  workspace: PreflightWorkspace;
  onRemoved: () => void;
}) {
  const [tick, setTick] = useState(0);
  const details = useKeyedLoad(`preflight-workspace:${workspace.id}:${tick}`, () =>
    api().preflight.workspace(workspace.id),
  );
  const discovery = useKeyedLoad(`preflight-discovery:${workspace.id}:${tick}`, () =>
    api().preflight.discover(workspace.id),
  );
  const [tab, setTab] = useState<Tab>('run');
  const [run, setRun] = useState<PreflightRun | null>(null);
  const [plan, setPlan] = useState<{ selection: PreflightSelection; plan: PreflightPlan } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const config = details.value?.config ?? null;

  // Follows the shown run while it is in progress.
  useEffect(() => {
    if (run?.status !== 'RUNNING') return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          setRun(await unwrap(api().preflight.run(run.id)));
        } catch {
          // The next tick tries again.
        }
      })();
    }, RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [run?.id, run?.status]);

  // The workspace's newest run is shown when the panel opens.
  useEffect(() => {
    void (async () => {
      try {
        const [latest] = await unwrap(
          api().preflight.runs({ workspaceId: workspace.id, limit: 1 }),
        );
        if (latest) setRun(await unwrap(api().preflight.run(latest.id)));
      } catch {
        // History is optional here.
      }
    })();
  }, [workspace.id]);

  async function save(next: PreflightConfig): Promise<string[]> {
    try {
      await unwrap(api().preflight.saveConfig(workspace.id, next));
      setTick((value) => value + 1);
      return [];
    } catch (caught) {
      if (caught instanceof ApiError && caught.issues.length > 0) {
        return caught.issues.map((issue) => issue.message);
      }
      return [errorMessage(caught)];
    }
  }

  async function start(selection: PreflightSelection) {
    setError(null);
    try {
      const planned = await unwrap(api().preflight.plan(selection));
      if (planned.checks.some((check) => check.authorization !== null)) {
        setPlan({ selection, plan: planned });
        return;
      }
      await launch(selection, planned);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function launch(selection: PreflightSelection, planned: PreflightPlan) {
    setPlan(null);
    try {
      const started = await unwrap(
        api().preflight.start({
          ...selection,
          authorizations: planned.checks
            .filter((check) => check.authorization !== null)
            .map((check) => ({ checkId: check.checkId, digest: check.digest })),
        }),
      );
      setRun(started);
      setTab('run');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function remove() {
    setRemoving(false);
    try {
      await unwrap(api().preflight.removeWorkspace(workspace.id));
      onRemoved();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground min-w-0 flex-1 truncate text-sm" title={workspace.path}>
          {workspace.path}
        </p>
        <Button size="sm" variant="ghost" onClick={() => setTick((value) => value + 1)}>
          <RefreshCw />
          Reload
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
          <Trash2 />
          Remove
        </Button>
      </div>
      {(error ?? details.error) && (
        <Alert variant="destructive">
          <AlertDescription>{error ?? details.error}</AlertDescription>
        </Alert>
      )}
      {details.value?.configInvalid && (
        <Alert>
          <AlertDescription>
            The saved configuration could not be read. Saving a change replaces it.
          </AlertDescription>
        </Alert>
      )}
      {config && (
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <TabsList className="flex-wrap">
            <TabsTrigger value="run">Run</TabsTrigger>
            <TabsTrigger value="checks">Checks ({config.checks.length})</TabsTrigger>
            <TabsTrigger value="profiles">Profiles ({config.profiles.length})</TabsTrigger>
            <TabsTrigger value="workflows">Workflows</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="run" className="flex flex-col gap-4">
            <RunLauncher
              workspaceId={workspace.id}
              config={config}
              running={run?.status === 'RUNNING'}
              onStart={(selection) => void start(selection)}
              onConfigure={() => setTab('checks')}
            />
            {run && (
              <RunPanel
                key={run.id}
                run={run}
                onCancel={() =>
                  void unwrap(api().preflight.cancel(run.id)).catch((caught) =>
                    setError(errorMessage(caught)),
                  )
                }
                onRetry={(checkIds) =>
                  void start({
                    workspaceId: workspace.id,
                    profileId: null,
                    checkIds,
                    retryOf: run.id,
                  })
                }
              />
            )}
          </TabsContent>
          <TabsContent value="checks">
            <ChecksTab config={config} discovery={discovery.value} onSave={save} />
          </TabsContent>
          <TabsContent value="profiles">
            <ProfilesTab config={config} onSave={save} />
          </TabsContent>
          <TabsContent value="workflows">
            <WorkflowsTab
              config={config}
              discovery={discovery.value}
              error={discovery.error}
              onSave={save}
              onAdded={() => setTab('checks')}
            />
          </TabsContent>
          <TabsContent value="history">
            <HistoryTab
              workspaceId={workspace.id}
              refreshKey={`${tick}:${run?.id ?? ''}:${run?.status ?? ''}`}
              onOpen={async (runId) => {
                try {
                  setRun(await unwrap(api().preflight.run(runId)));
                  setTab('run');
                } catch (caught) {
                  setError(errorMessage(caught));
                }
              }}
            />
          </TabsContent>
        </Tabs>
      )}
      {plan && (
        <AuthorizationDialog
          plan={plan.plan}
          onCancel={() => setPlan(null)}
          onAuthorize={() => void launch(plan.selection, plan.plan)}
        />
      )}
      {removing && (
        <AlertDialog open onOpenChange={(open) => !open && setRemoving(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {workspace.name} from Preflight?</AlertDialogTitle>
              <AlertDialogDescription>
                Its checks, profiles, authorizations, history and logs are deleted. The folder
                itself is not changed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void remove()}>Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function RunLauncher({
  workspaceId,
  config,
  running,
  onStart,
  onConfigure,
}: {
  workspaceId: string;
  config: PreflightConfig;
  running: boolean;
  onStart: (selection: PreflightSelection) => void;
  onConfigure: () => void;
}) {
  const enabled = config.checks.filter((check) => check.enabled);
  const [selected, setSelected] = useState<string[]>([]);
  const [profileId, setProfileId] = useState<string | null>(config.profiles[0]?.id ?? null);

  if (config.checks.length === 0) {
    return (
      <div className="grid justify-items-start gap-2 rounded-md border p-4 text-sm">
        <p>This workspace has no checks yet.</p>
        <Button size="sm" onClick={onConfigure}>
          <Plus />
          Add checks
        </Button>
      </div>
    );
  }
  return (
    <div className="grid gap-3 rounded-md border p-3">
      {config.profiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={profileId ?? undefined} onValueChange={setProfileId}>
            <SelectTrigger size="sm" className="w-56" aria-label="Profile">
              <SelectValue placeholder="Choose a profile" />
            </SelectTrigger>
            <SelectContent>
              {config.profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name} ({profile.checkIds.length})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={running || profileId === null}
            onClick={() => onStart({ workspaceId, profileId, checkIds: null })}
          >
            <Play />
            Run profile
          </Button>
        </div>
      )}
      <fieldset className="grid gap-2">
        <legend className="text-muted-foreground mb-1 text-xs">Or choose checks</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {enabled.map((check) => (
            <label key={check.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selected.includes(check.id)}
                onCheckedChange={(value) =>
                  setSelected((current) =>
                    value === true
                      ? [...current, check.id]
                      : current.filter((id) => id !== check.id),
                  )
                }
              />
              {check.name}
            </label>
          ))}
        </div>
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={running || selected.length === 0}
            onClick={() =>
              onStart({
                workspaceId,
                profileId: null,
                checkIds: enabled
                  .filter((check) => selected.includes(check.id))
                  .map((check) => check.id),
              })
            }
          >
            <Play />
            Run selected
          </Button>
        </div>
      </fieldset>
      {running && <p className="text-muted-foreground text-xs">A run is in progress.</p>}
    </div>
  );
}

function ChecksTab({
  config,
  discovery,
  onSave,
}: {
  config: PreflightConfig;
  discovery: PreflightDiscovery | null;
  onSave: (config: PreflightConfig) => Promise<string[]>;
}) {
  const [editing, setEditing] = useState<{ check: PreflightCheck; isNew: boolean } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const ids = config.checks.map((check) => check.id);

  async function persist(next: PreflightConfig) {
    setSaving(true);
    const problems = await onSave(next);
    setSaving(false);
    setErrors(problems);
    return problems.length === 0;
  }

  async function saveCheck(check: PreflightCheck) {
    const checks = editing?.isNew
      ? [...config.checks, check]
      : config.checks.map((item) => (item.id === check.id ? check : item));
    if (await persist({ ...config, checks })) setEditing(null);
  }

  async function removeCheck(id: string) {
    await persist({
      checks: config.checks
        .filter((check) => check.id !== id)
        .map((check) => ({ ...check, dependsOn: check.dependsOn.filter((item) => item !== id) })),
      profiles: config.profiles.map((profile) => ({
        ...profile,
        checkIds: profile.checkIds.filter((item) => item !== id),
      })),
    });
  }

  const suggestions = [
    ...(discovery?.scripts ?? [])
      .filter((script) => !config.checks.some((check) => check.script === script.name))
      .map((script) =>
        blankCheck({
          id: newItemId(script.name, ids),
          name: script.name,
          type: 'PACKAGE_SCRIPT',
          category: script.category,
          packageManager: discovery?.packageManager ?? 'npm',
          script: script.name,
        }),
      ),
    ...(discovery?.commands ?? [])
      .filter((command) => !config.checks.some((check) => check.command === command.command))
      .map((command) =>
        blankCheck({
          id: newItemId(command.name, ids),
          name: command.name,
          type: 'COMMAND',
          category: command.category,
          command: command.command,
        }),
      ),
  ];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            setErrors([]);
            setEditing({
              check: blankCheck({
                id: newItemId('check', ids),
                name: '',
                type: 'COMMAND',
                category: 'CUSTOM',
                command: '',
              }),
              isNew: true,
            });
          }}
        >
          <Plus />
          Add check
        </Button>
      </div>
      {errors.length > 0 && editing === null && (
        <Alert variant="destructive">
          <AlertDescription>{errors.join(' ')}</AlertDescription>
        </Alert>
      )}
      {config.checks.length > 0 && (
        <ul className="grid gap-2" data-testid="preflight-checks">
          {config.checks.map((check) => (
            <li key={check.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {check.name}
                  <Badge variant="outline">{CATEGORY_LABELS[check.category]}</Badge>
                  {check.required ? (
                    <Badge variant="secondary">Required</Badge>
                  ) : (
                    <Badge variant="outline">Advisory</Badge>
                  )}
                  {!check.enabled && <Badge variant="outline">Disabled</Badge>}
                </p>
                <p className="text-muted-foreground truncate font-mono text-xs">
                  {checkSummary(check)}
                </p>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Edit ${check.name}`}
                onClick={() => {
                  setErrors([]);
                  setEditing({ check, isNew: false });
                }}
              >
                <Pencil />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${check.name}`}
                onClick={() => void removeCheck(check.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {suggestions.length > 0 && (
        <section className="grid gap-2" aria-label="Suggestions">
          <h2 className="text-sm font-medium">Found in this workspace</h2>
          <p className="text-muted-foreground text-xs">
            Read from package.json and build files; nothing was run. Choose what becomes a check.
          </p>
          <ul className="grid gap-1" data-testid="preflight-suggestions">
            {suggestions.map((suggestion) => (
              <li key={suggestion.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {suggestion.name}{' '}
                  <span className="text-muted-foreground font-mono text-xs">
                    {checkSummary(suggestion)}
                  </span>
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={`Add ${suggestion.name}`}
                  onClick={() => {
                    setErrors([]);
                    setEditing({ check: suggestion, isNew: true });
                  }}
                >
                  <Plus />
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {editing && (
        <CheckForm
          initial={editing.check}
          isNew={editing.isNew}
          others={config.checks.filter((check) => check.id !== editing.check.id)}
          discovery={discovery}
          errors={errors}
          saving={saving}
          onSave={(check) => void saveCheck(check)}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ProfilesTab({
  config,
  onSave,
}: {
  config: PreflightConfig;
  onSave: (config: PreflightConfig) => Promise<string[]>;
}) {
  const [editing, setEditing] = useState<{ profile: PreflightProfile; isNew: boolean } | null>(
    null,
  );
  const [errors, setErrors] = useState<string[]>([]);

  async function saveProfile(profile: PreflightProfile) {
    const profiles = editing?.isNew
      ? [...config.profiles, profile]
      : config.profiles.map((item) => (item.id === profile.id ? profile : item));
    const problems = await onSave({ ...config, profiles });
    setErrors(problems);
    if (problems.length === 0) setEditing(null);
  }

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-sm">
        A profile is a named set of checks, e.g. Quick (lint, type check, unit tests) or Full. The
        name does not decide what runs; its checks do.
      </p>
      <div>
        <Button
          size="sm"
          disabled={config.checks.length === 0}
          onClick={() => {
            setErrors([]);
            setEditing({
              profile: {
                id: newItemId(
                  'profile',
                  config.profiles.map((profile) => profile.id),
                ),
                name: '',
                checkIds: [],
                concurrency: 1,
              },
              isNew: true,
            });
          }}
        >
          <Plus />
          Add profile
        </Button>
      </div>
      <ul className="grid gap-2" data-testid="preflight-profiles">
        {config.profiles.map((profile) => (
          <li key={profile.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{profile.name}</p>
              <p className="text-muted-foreground truncate text-xs">
                {profile.checkIds
                  .map((id) => config.checks.find((check) => check.id === id)?.name ?? id)
                  .join(' → ') || 'No checks'}
                {profile.concurrency > 1 ? ` · up to ${profile.concurrency} at once` : ''}
              </p>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Edit ${profile.name}`}
              onClick={() => {
                setErrors([]);
                setEditing({ profile, isNew: false });
              }}
            >
              <Pencil />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${profile.name}`}
              onClick={() =>
                void onSave({
                  ...config,
                  profiles: config.profiles.filter((item) => item.id !== profile.id),
                })
              }
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      {editing && (
        <ProfileForm
          initial={editing.profile}
          isNew={editing.isNew}
          checks={config.checks}
          errors={errors}
          onSave={(profile) => void saveProfile(profile)}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ProfileForm({
  initial,
  isNew,
  checks,
  errors,
  onSave,
  onCancel,
}: {
  initial: PreflightProfile;
  isNew: boolean;
  checks: PreflightCheck[];
  errors: string[];
  onSave: (profile: PreflightProfile) => void;
  onCancel: () => void;
}) {
  const [profile, setProfile] = useState(initial);
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" data-testid="preflight-profile-form">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(profile);
          }}
        >
          <DialogHeader>
            <DialogTitle>{isNew ? 'New profile' : `Edit ${initial.name}`}</DialogTitle>
            <DialogDescription>Checks run in the order you select them.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              value={profile.name}
              maxLength={60}
              placeholder="e.g. Quick"
              onChange={(event) => setProfile({ ...profile, name: event.target.value })}
              required
            />
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Checks</legend>
            {checks.map((check) => {
              const index = profile.checkIds.indexOf(check.id);
              return (
                <label key={check.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={index >= 0}
                    onCheckedChange={(value) =>
                      setProfile({
                        ...profile,
                        checkIds:
                          value === true
                            ? [...profile.checkIds, check.id]
                            : profile.checkIds.filter((id) => id !== check.id),
                      })
                    }
                  />
                  {index >= 0 && (
                    <span className="text-muted-foreground w-4 text-xs">{index + 1}.</span>
                  )}
                  {check.name}
                </label>
              );
            })}
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor="profile-concurrency">Checks at once</Label>
            <Input
              id="profile-concurrency"
              type="number"
              min={1}
              max={8}
              value={profile.concurrency}
              onChange={(event) =>
                setProfile({ ...profile, concurrency: Number(event.target.value) })
              }
            />
            <p className="text-muted-foreground text-xs">
              Checks that depend on each other, run alone or use act still wait for their turn.
            </p>
          </div>
          {errors.length > 0 && (
            <ul className="text-destructive list-disc pl-5 text-sm" role="alert">
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">{isNew ? 'Add profile' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function JobDetails({ job }: { job: WorkflowJobSummary }) {
  return (
    <div className="grid gap-1 text-xs">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{job.name}</span>
        <Badge variant="outline" className={compatibilityClass(job.compatibility)}>
          {COMPATIBILITY_LABELS[job.compatibility]}
        </Badge>
        {job.runsOn.length > 0 && (
          <span className="text-muted-foreground">{job.runsOn.join(', ')}</span>
        )}
      </p>
      <ul className="text-muted-foreground list-disc pl-5">
        {job.compatibilityReasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
        {job.dangerReasons.map((reason) => (
          <li key={reason} className="text-destructive">
            May change something outside this computer: {reason}
          </li>
        ))}
        {job.actions.length > 0 && <li>Actions: {job.actions.join(', ')}</li>}
      </ul>
    </div>
  );
}

function WorkflowsTab({
  config,
  discovery,
  error,
  onSave,
  onAdded,
}: {
  config: PreflightConfig;
  discovery: PreflightDiscovery | null;
  error: string | null;
  onSave: (config: PreflightConfig) => Promise<string[]>;
  onAdded: () => void;
}) {
  const [problems, setProblems] = useState<string[]>([]);

  async function add(workflow: WorkflowSummary, job: WorkflowJobSummary | null) {
    const ids = config.checks.map((check) => check.id);
    const name = job === null ? workflow.name : `${workflow.name} · ${job.name}`;
    const event = (['push', 'pull_request', 'workflow_dispatch'] as const).find((item) =>
      workflow.triggers.includes(item),
    );
    const check = blankCheck({
      id: newItemId(name, ids),
      name: name.slice(0, 80),
      type: 'GITHUB_ACTIONS',
      category: 'WORKFLOW',
      workflowPath: workflow.path,
      workflowJob: job?.id ?? null,
      exclusive: true,
      timeoutSeconds: 3600,
    });
    if (event && check.act) check.act = { ...check.act, event };
    const errors = await onSave({ ...config, checks: [...config.checks, check] });
    setProblems(errors);
    if (errors.length === 0) onAdded();
  }

  if (error) return <p className="text-destructive text-sm">{error}</p>;
  const workflows = discovery?.workflows ?? [];
  return (
    <div className="grid gap-3" data-testid="preflight-workflows">
      <Alert>
        <TriangleAlert className="size-4" />
        <AlertDescription>
          Workflows run locally through act and Docker. A local result is not a GitHub-hosted CI
          result, and the classification below only reflects what the file shows.
        </AlertDescription>
      </Alert>
      {problems.length > 0 && <p className="text-destructive text-sm">{problems.join(' ')}</p>}
      {workflows.length === 0 && (
        <p className="text-muted-foreground text-sm">No workflows in .github/workflows.</p>
      )}
      {workflows.map((workflow) => (
        <section
          key={workflow.path}
          className="grid gap-2 rounded-md border p-3"
          aria-label={workflow.name}
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">{workflow.name}</h2>
            <span className="text-muted-foreground font-mono text-xs">{workflow.path}</span>
            <Badge variant="outline" className={compatibilityClass(workflow.compatibility)}>
              {COMPATIBILITY_LABELS[workflow.compatibility]}
            </Badge>
            {workflow.parseError === null && (
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                onClick={() => void add(workflow, null)}
              >
                <Plus />
                Add workflow
              </Button>
            )}
          </div>
          {workflow.parseError ? (
            <p className="text-destructive text-xs">{workflow.parseError}</p>
          ) : (
            <>
              <p className="text-muted-foreground text-xs">
                Triggers: {workflow.triggers.join(', ') || '—'}
              </p>
              <ul className="grid gap-2">
                {workflow.jobs.map((job) => (
                  <li key={job.id} className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <JobDetails job={job} />
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={job.compatibility === 'UNSUPPORTED'}
                      onClick={() => void add(workflow, job)}
                    >
                      <Plus />
                      Add job
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
    </div>
  );
}

function HistoryTab({
  workspaceId,
  refreshKey,
  onOpen,
}: {
  workspaceId: string;
  refreshKey: string;
  onOpen: (runId: string) => void;
}) {
  const runs = useKeyedLoad(`preflight-runs:${workspaceId}:${refreshKey}`, () =>
    api().preflight.runs({ workspaceId, limit: 50 }),
  );
  if (runs.error) return <p className="text-destructive text-sm">{runs.error}</p>;
  if ((runs.value ?? []).length === 0) {
    return <p className="text-muted-foreground text-sm">No runs yet.</p>;
  }
  return (
    <ul className="grid gap-1" data-testid="preflight-history">
      {(runs.value ?? []).map((run) => (
        <li key={run.id}>
          <button
            type="button"
            onClick={() => onOpen(run.id)}
            className="hover:bg-accent flex w-full flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm"
          >
            <Badge variant="outline" className={statusClass(run.status)}>
              {RUN_STATUS_LABELS[run.status]}
            </Badge>
            <span className="min-w-0 flex-1 truncate">{run.profileName}</span>
            <span className="text-muted-foreground text-xs">
              {Object.entries(run.counts)
                .map(
                  ([status, count]) =>
                    `${count} ${STATUS_LABELS[status as keyof typeof STATUS_LABELS].toLowerCase()}`,
                )
                .join(' · ')}
            </span>
            <span className="text-muted-foreground text-xs">
              {run.branch ?? ''} {run.sourceRevision?.slice(0, 8) ?? ''} ·{' '}
              {formatTime(run.startedAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
