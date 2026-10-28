import {
  AUDIT_SCOPE_PATHS_MAX,
  type AiProvider,
  type AuditCategory,
  type AuditScopeKind,
  type ProjectAudit,
  type StartAuditInput,
} from '@atlas/contracts';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { useKeyedLoad } from '@/context/hooks/useContextData';
import { cn } from '@/lib/utils';
import { AUDIT_PROVIDER_LABELS, READ_ONLY_LABELS } from './audit-labels';

const DEFAULT_PROFILE = '__default__';

const SCOPES: { kind: AuditScopeKind; label: string; text: string }[] = [
  { kind: 'project', label: 'Entire project', text: 'Ignored and generated files are skipped.' },
  { kind: 'directories', label: 'Folders', text: 'One folder per line, relative to the project.' },
  { kind: 'files', label: 'Files', text: 'One file per line, relative to the project.' },
  { kind: 'changed', label: 'Changed files', text: 'Files with uncommitted Git changes.' },
];

interface AnalyzeProjectDialogProps {
  projectId: string;
  onClose: () => void;
  /** The audit was accepted; it continues if the dialog closes. */
  onStarted: (audit: ProjectAudit) => void;
}

/**
 * Configures an AI audit of a project (SDD-026 FR-001): provider, account, categories and
 * scope. Nothing is sent before Start; the audit then runs as a background job.
 */
export function AnalyzeProjectDialog(props: AnalyzeProjectDialogProps) {
  const options = useKeyedLoad(`audit-options:${props.projectId}`, () =>
    api().audit.options(props.projectId),
  );
  const [chosenProvider, setProvider] = useState<AiProvider | null>(null);
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE);
  const [chosenCategories, setCategories] = useState<AuditCategory[] | null>(null);
  const [scopeKind, setScopeKind] = useState<AuditScopeKind>('project');
  const [pathsText, setPathsText] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = options.value;
  const providers = value?.providers ?? [];
  // Never preselect an unavailable provider, and never switch one silently.
  const provider = chosenProvider ?? providers.find((item) => item.available)?.provider ?? null;
  const option = providers.find((item) => item.provider === provider) ?? null;
  const profiles = (value?.profiles ?? []).filter((item) => item.provider === provider);
  const profile = profiles.find((item) => item.id === profileId) ?? null;
  const categories = chosenCategories ?? value?.defaultCategories ?? [];
  const paths = pathsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const needsPaths = scopeKind === 'directories' || scopeKind === 'files';
  const warnings = option?.warnings ?? [];

  const ready =
    value !== null &&
    value.projectAvailable &&
    option?.available === true &&
    categories.length > 0 &&
    (!needsPaths || (paths.length > 0 && paths.length <= AUDIT_SCOPE_PATHS_MAX)) &&
    (scopeKind !== 'changed' || (value.git.changedFiles ?? 0) > 0) &&
    (warnings.length === 0 || acknowledged);

  function toggleCategory(category: AuditCategory, checked: boolean) {
    setCategories(
      checked
        ? [...new Set([...categories, category])]
        : categories.filter((item) => item !== category),
    );
  }

  async function start() {
    if (!ready || provider === null) return;
    setBusy(true);
    setError(null);
    const input: StartAuditInput = {
      projectId: props.projectId,
      provider,
      ...(profile ? { profileId: profile.id } : {}),
      categories,
      scope:
        scopeKind === 'directories' || scopeKind === 'files'
          ? { kind: scopeKind, paths }
          : { kind: scopeKind },
      acknowledgeWarnings: warnings.length > 0 && acknowledged,
    };
    try {
      props.onStarted(await unwrap(api().audit.start(input)));
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues.length > 0
          ? `${caught.message} ${caught.issues.map((issue) => issue.message).join(' ')}`
          : errorMessage(caught),
      );
      setBusy(false);
      void options.reload();
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="analyze-project-dialog"
      >
        <DialogHeader>
          <DialogTitle>Analyze project</DialogTitle>
          <DialogDescription>
            An AI provider reviews {value?.projectName ?? 'the project'} and reports findings. It
            runs in the background with read-only restrictions; nothing starts until you confirm.
          </DialogDescription>
        </DialogHeader>

        {value !== null && !value.projectAvailable && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>The project folder is not available.</AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">Provider</legend>
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Provider">
              {providers.map((item) => (
                <label
                  key={item.provider}
                  className={cn(
                    'flex min-w-0 items-start gap-2 text-sm',
                    !item.available && 'opacity-60',
                  )}
                  data-testid="audit-provider"
                >
                  <input
                    type="radio"
                    name="audit-provider"
                    className="accent-sidebar-primary mt-0.5"
                    checked={provider === item.provider}
                    disabled={!item.available}
                    onChange={() => {
                      setProvider(item.provider);
                      setProfileId(DEFAULT_PROFILE);
                      setAcknowledged(false);
                    }}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span>{AUDIT_PROVIDER_LABELS[item.provider]}</span>
                    <span className="text-muted-foreground text-xs break-words">
                      {item.available ? READ_ONLY_LABELS[item.readOnlyMode] : item.reason}
                    </span>
                  </span>
                </label>
              ))}
              {value === null && !options.error && (
                <span className="text-muted-foreground text-xs">Checking providers…</span>
              )}
            </div>
          </fieldset>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="audit-profile">Account</Label>
            <Select value={profileId} onValueChange={setProfileId} disabled={provider === null}>
              <SelectTrigger id="audit-profile" className="w-full">
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

        <fieldset className="flex min-w-0 flex-col gap-1.5" data-testid="audit-categories">
          <legend className="mb-1 flex w-full items-center justify-between gap-2 text-sm">
            <span className="font-medium">Categories</span>
            {value !== null && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setCategories([...value.defaultCategories])}
              >
                Default profile
              </Button>
            )}
          </legend>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {(value?.categories ?? []).map((category) => (
              <label key={category.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={categories.includes(category.id)}
                  onCheckedChange={(checked) => toggleCategory(category.id, checked === true)}
                  aria-label={category.label}
                />
                {category.label}
              </label>
            ))}
          </div>
          {value !== null && categories.length === 0 && (
            <span className="text-destructive text-xs">Choose at least one category.</span>
          )}
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-1.5">
          <legend className="mb-1 text-sm font-medium">Scope</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {SCOPES.map((scope) => {
              const disabled =
                scope.kind === 'changed' && (value === null || !value.git.repository);
              const text =
                scope.kind === 'changed' && value !== null
                  ? value.git.repository
                    ? `${value.git.changedFiles ?? 0} file(s) with uncommitted changes.`
                    : 'Only in Git repositories.'
                  : scope.text;
              return (
                <label
                  key={scope.kind}
                  className={cn(
                    'flex gap-2 rounded-md border p-2.5 text-sm',
                    disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                    scopeKind === scope.kind && 'border-sidebar-primary bg-accent/40',
                  )}
                >
                  <input
                    type="radio"
                    name="audit-scope"
                    className="accent-sidebar-primary mt-0.5"
                    checked={scopeKind === scope.kind}
                    disabled={disabled}
                    onChange={() => setScopeKind(scope.kind)}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{scope.label}</span>
                    <span className="text-muted-foreground text-xs">{text}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {needsPaths && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="audit-paths">
                {scopeKind === 'files' ? 'Files' : 'Folders'} (one per line)
              </Label>
              <Textarea
                id="audit-paths"
                rows={4}
                value={pathsText}
                placeholder={scopeKind === 'files' ? 'src/index.ts' : 'src\npackages/core'}
                onChange={(event) => setPathsText(event.target.value)}
                className="font-mono text-xs"
                aria-invalid={paths.length > AUDIT_SCOPE_PATHS_MAX}
              />
              <span className="text-muted-foreground text-xs">
                {paths.length > AUDIT_SCOPE_PATHS_MAX
                  ? `Use at most ${AUDIT_SCOPE_PATHS_MAX} paths.`
                  : 'Paths outside the project or excluded by its ignore rules are refused.'}
              </span>
            </div>
          )}
        </fieldset>

        {option !== null && option.available && (
          <Alert role="status" data-testid="audit-read-only">
            <ShieldCheck />
            <AlertDescription className="flex flex-col gap-1">
              <span>
                {READ_ONLY_LABELS[option.readOnlyMode]}. ATLAS never changes project files during an
                audit and checks the Git status before and after it.
              </span>
              <span className="text-muted-foreground">{option.dataNotice}</span>
            </AlertDescription>
          </Alert>
        )}
        {warnings.length > 0 && (
          <Alert role="alert" className="border-warning/40" data-testid="audit-warnings">
            <TriangleAlert className="text-warning" />
            <AlertDescription className="flex flex-col gap-2">
              {warnings.map((warning) => (
                <span key={warning}>{warning}</span>
              ))}
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={acknowledged}
                  onCheckedChange={(checked) => setAcknowledged(checked === true)}
                />
                I understand; audit with {provider ? AUDIT_PROVIDER_LABELS[provider] : 'it'}
              </label>
            </AlertDescription>
          </Alert>
        )}
        <p className="text-muted-foreground text-xs">
          Cost and duration cannot be estimated reliably, so none is shown. Usage reported by the
          provider is recorded with the audit.
        </p>

        {(error ?? options.error) && (
          <Alert variant="destructive" role="alert">
            <AlertDescription data-testid="audit-start-error">
              {error ?? options.error}
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void start()} disabled={!ready || busy}>
            {busy ? 'Starting…' : 'Start audit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
