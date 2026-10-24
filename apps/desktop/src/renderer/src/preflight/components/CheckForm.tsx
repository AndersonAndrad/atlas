import {
  DEFAULT_ACT_SETTINGS,
  PACKAGE_MANAGERS,
  PREFLIGHT_CHECK_CATEGORIES,
  PREFLIGHT_CHECK_TYPES,
  PREFLIGHT_TRIGGERS,
  type PackageManager,
  type PreflightActSettings,
  type PreflightCheck,
  type PreflightCheckType,
  type PreflightDiscovery,
  type PreflightTrigger,
} from '@atlas/contracts';
import { useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { CATEGORY_LABELS } from '../format';

const TYPE_LABELS: Record<PreflightCheckType, string> = {
  COMMAND: 'Command',
  PACKAGE_SCRIPT: 'Package script',
  GITHUB_ACTIONS: 'GitHub Actions (act)',
};

const TRIGGER_LABELS: Record<PreflightTrigger, string> = {
  MANUAL: 'Manual',
  PRE_COMMIT: 'Before commit',
  PRE_PUSH: 'Before push',
  PRE_MERGE: 'Before merge',
  PRE_DELIVERY: 'Before delivery',
};

const NONE = '__none__';

/** `NAME=value` lines; blank lines are ignored. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) env[trimmed] = '';
    else env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1);
  }
  return env;
}

const list = (text: string) =>
  text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

interface CheckFormProps {
  /** The check being edited, or a new one. */
  initial: PreflightCheck;
  isNew: boolean;
  /** Other checks of the workspace, for dependencies. */
  others: PreflightCheck[];
  discovery: PreflightDiscovery | null;
  /** Errors returned by the Engine for the last save. */
  errors: string[];
  saving: boolean;
  onSave: (check: PreflightCheck) => void;
  onCancel: () => void;
}

export function CheckForm({
  initial,
  isNew,
  others,
  discovery,
  errors,
  saving,
  onSave,
  onCancel,
}: CheckFormProps) {
  const [check, setCheck] = useState<PreflightCheck>(initial);
  const [envText, setEnvText] = useState(
    Object.entries(initial.env)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n'),
  );
  const [toolsText, setToolsText] = useState(initial.requiredTools.join(', '));
  const [matrixText, setMatrixText] = useState(initial.act?.matrix.join(', ') ?? '');
  const [platformsText, setPlatformsText] = useState(
    initial.act?.platforms.map((item) => `${item.label}=${item.image}`).join('\n') ?? '',
  );
  const update = (changes: Partial<PreflightCheck>) =>
    setCheck((current) => ({ ...current, ...changes }));
  const updateAct = (changes: Partial<PreflightActSettings>) =>
    setCheck((current) => ({ ...current, act: { ...current.act!, ...changes } }));

  const workflow = discovery?.workflows.find((item) => item.path === check.workflowPath) ?? null;

  function changeType(type: PreflightCheckType) {
    setCheck((current) => ({
      ...current,
      type,
      command: type === 'COMMAND' ? (current.command ?? '') : null,
      packageManager:
        type === 'PACKAGE_SCRIPT'
          ? (current.packageManager ?? discovery?.packageManager ?? 'npm')
          : null,
      script: type === 'PACKAGE_SCRIPT' ? current.script : null,
      workflowPath: type === 'GITHUB_ACTIONS' ? current.workflowPath : null,
      workflowJob: type === 'GITHUB_ACTIONS' ? current.workflowJob : null,
      act: type === 'GITHUB_ACTIONS' ? (current.act ?? { ...DEFAULT_ACT_SETTINGS }) : null,
      category: type === 'GITHUB_ACTIONS' ? 'WORKFLOW' : current.category,
      workingDirectory: type === 'GITHUB_ACTIONS' ? '' : current.workingDirectory,
      exclusive: type === 'GITHUB_ACTIONS' ? true : current.exclusive,
    }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const platforms = list(platformsText).map((item) => {
      const index = item.indexOf('=');
      return index < 0
        ? { label: item, image: '' }
        : { label: item.slice(0, index).trim(), image: item.slice(index + 1).trim() };
    });
    onSave({
      ...check,
      env: parseEnv(envText),
      requiredTools: list(toolsText),
      act: check.act === null ? null : { ...check.act, matrix: list(matrixText), platforms },
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="preflight-check-form"
      >
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{isNew ? 'New check' : `Edit ${initial.name}`}</DialogTitle>
            <DialogDescription>
              A check runs on this computer when you run Preflight. ATLAS asks before it runs a
              check for the first time and whenever what it runs changes.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="check-name">Name</Label>
              <Input
                id="check-name"
                value={check.name}
                maxLength={80}
                onChange={(event) => update({ name: event.target.value })}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="check-type">Type</Label>
              <Select
                value={check.type}
                onValueChange={(value) => changeType(value as PreflightCheckType)}
              >
                <SelectTrigger id="check-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PREFLIGHT_CHECK_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="check-category">Category</Label>
              <Select
                value={check.category}
                onValueChange={(value) => update({ category: value as PreflightCheck['category'] })}
              >
                <SelectTrigger id="check-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PREFLIGHT_CHECK_CATEGORIES.map((category) => (
                    <SelectItem key={category} value={category}>
                      {CATEGORY_LABELS[category]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {check.type !== 'GITHUB_ACTIONS' && (
              <div className="grid gap-1.5">
                <Label htmlFor="check-folder">Working folder</Label>
                <Input
                  id="check-folder"
                  value={check.workingDirectory}
                  placeholder="(workspace folder)"
                  onChange={(event) => update({ workingDirectory: event.target.value })}
                />
              </div>
            )}
          </div>

          {check.type === 'COMMAND' && (
            <div className="grid gap-1.5">
              <Label htmlFor="check-command">Command</Label>
              <Input
                id="check-command"
                className="font-mono"
                value={check.command ?? ''}
                placeholder="e.g. pnpm lint"
                onChange={(event) => update({ command: event.target.value })}
                required
              />
              <p className="text-muted-foreground text-xs">
                Runs in your shell with your terminal environment, exactly as typed. It is not
                sandboxed.
              </p>
            </div>
          )}

          {check.type === 'PACKAGE_SCRIPT' && (
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              <div className="grid gap-1.5">
                <Label htmlFor="check-manager">Package manager</Label>
                <Select
                  value={check.packageManager ?? 'npm'}
                  onValueChange={(value) => update({ packageManager: value as PackageManager })}
                >
                  <SelectTrigger id="check-manager">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PACKAGE_MANAGERS.map((manager) => (
                      <SelectItem key={manager} value={manager}>
                        {manager}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="check-script">Script</Label>
                <Input
                  id="check-script"
                  className="font-mono"
                  list="preflight-scripts"
                  value={check.script ?? ''}
                  onChange={(event) => update({ script: event.target.value })}
                  required
                />
                <datalist id="preflight-scripts">
                  {discovery?.scripts.map((script) => (
                    <option key={script.name} value={script.name}>
                      {script.body}
                    </option>
                  ))}
                </datalist>
              </div>
            </div>
          )}

          {check.type === 'GITHUB_ACTIONS' && check.act !== null && (
            <div className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="check-workflow">Workflow</Label>
                  <Select
                    value={check.workflowPath ?? NONE}
                    onValueChange={(value) =>
                      update({ workflowPath: value === NONE ? null : value, workflowJob: null })
                    }
                  >
                    <SelectTrigger id="check-workflow">
                      <SelectValue placeholder="Choose a workflow" />
                    </SelectTrigger>
                    <SelectContent>
                      {(discovery?.workflows ?? []).map((item) => (
                        <SelectItem key={item.path} value={item.path}>
                          {item.name} ({item.path})
                        </SelectItem>
                      ))}
                      {check.workflowPath &&
                        !discovery?.workflows.some((item) => item.path === check.workflowPath) && (
                          <SelectItem value={check.workflowPath}>{check.workflowPath}</SelectItem>
                        )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="check-job">Job</Label>
                  <Select
                    value={check.workflowJob ?? NONE}
                    onValueChange={(value) =>
                      update({ workflowJob: value === NONE ? null : value })
                    }
                  >
                    <SelectTrigger id="check-job">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>All jobs</SelectItem>
                      {(workflow?.jobs ?? []).map((job) => (
                        <SelectItem key={job.id} value={job.id}>
                          {job.name}
                        </SelectItem>
                      ))}
                      {check.workflowJob &&
                        !workflow?.jobs.some((job) => job.id === check.workflowJob) && (
                          <SelectItem value={check.workflowJob}>{check.workflowJob}</SelectItem>
                        )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="check-event">Event</Label>
                  <Select
                    value={check.act.event}
                    onValueChange={(value) =>
                      updateAct({ event: value as PreflightActSettings['event'] })
                    }
                  >
                    <SelectTrigger id="check-event">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['push', 'pull_request', 'workflow_dispatch'] as const).map((event) => (
                        <SelectItem key={event} value={event}>
                          {event}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="check-arch">Container architecture</Label>
                  <Select
                    value={check.act.containerArchitecture ?? NONE}
                    onValueChange={(value) =>
                      updateAct({
                        containerArchitecture:
                          value === NONE ? null : (value as 'linux/amd64' | 'linux/arm64'),
                      })
                    }
                  >
                    <SelectTrigger id="check-arch">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Docker default</SelectItem>
                      <SelectItem value="linux/amd64">linux/amd64</SelectItem>
                      <SelectItem value="linux/arm64">linux/arm64</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="check-matrix">Matrix filters</Label>
                  <Input
                    id="check-matrix"
                    className="font-mono"
                    value={matrixText}
                    placeholder="os:ubuntu-24.04"
                    onChange={(event) => setMatrixText(event.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="check-cpus">CPUs</Label>
                    <Input
                      id="check-cpus"
                      type="number"
                      min={0.5}
                      step={0.5}
                      value={check.act.cpus ?? ''}
                      onChange={(event) =>
                        updateAct({
                          cpus: event.target.value === '' ? null : Number(event.target.value),
                        })
                      }
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="check-memory">Memory (MB)</Label>
                    <Input
                      id="check-memory"
                      type="number"
                      min={256}
                      step={256}
                      value={check.act.memoryMb ?? ''}
                      onChange={(event) =>
                        updateAct({
                          memoryMb: event.target.value === '' ? null : Number(event.target.value),
                        })
                      }
                    />
                  </div>
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="check-platforms">Runner images (label=image, one per line)</Label>
                <Textarea
                  id="check-platforms"
                  className="font-mono"
                  rows={2}
                  value={platformsText}
                  placeholder="ubuntu-24.04=catthehacker/ubuntu:act-24.04"
                  onChange={(event) => setPlatformsText(event.target.value)}
                />
              </div>
              <p className="text-muted-foreground text-xs">
                Runs locally through act and Docker. This is not GitHub-hosted CI, and jobs that
                need secrets are blocked.
              </p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="check-timeout">Timeout (seconds)</Label>
              <Input
                id="check-timeout"
                type="number"
                min={5}
                max={21600}
                value={check.timeoutSeconds}
                onChange={(event) => update({ timeoutSeconds: Number(event.target.value) })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="check-tools">Required tools</Label>
              <Input
                id="check-tools"
                value={toolsText}
                placeholder="e.g. docker, make"
                onChange={(event) => setToolsText(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="check-env">Variables (NAME=value, one per line)</Label>
            <Textarea
              id="check-env"
              className="font-mono"
              rows={2}
              value={envText}
              onChange={(event) => setEnvText(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Stored in plain text. Secrets are refused.
            </p>
          </div>

          <div className="grid gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={check.enabled}
                onCheckedChange={(value) => update({ enabled: value === true })}
              />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={check.required}
                onCheckedChange={(value) => update({ required: value === true })}
              />
              Required (advisory when off)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={check.exclusive || check.type === 'GITHUB_ACTIONS'}
                disabled={check.type === 'GITHUB_ACTIONS'}
                onCheckedChange={(value) => update({ exclusive: value === true })}
              />
              Runs alone (never next to another check)
            </label>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Triggers</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {PREFLIGHT_TRIGGERS.map((trigger) => (
                <label key={trigger} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={check.executionTriggers.includes(trigger)}
                    onCheckedChange={(value) =>
                      update({
                        executionTriggers:
                          value === true
                            ? [...check.executionTriggers, trigger]
                            : check.executionTriggers.filter((item) => item !== trigger),
                      })
                    }
                  />
                  {TRIGGER_LABELS[trigger]}
                </label>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              Checks run manually for now; Git triggers take effect with quality gates.
            </p>
          </fieldset>

          {others.length > 0 && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Runs after these checks pass</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {others.map((other) => (
                  <label key={other.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={check.dependsOn.includes(other.id)}
                      onCheckedChange={(value) =>
                        update({
                          dependsOn:
                            value === true
                              ? [...check.dependsOn, other.id]
                              : check.dependsOn.filter((id) => id !== other.id),
                        })
                      }
                    />
                    {other.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

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
            <Button type="submit" disabled={saving}>
              {isNew ? 'Add check' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
