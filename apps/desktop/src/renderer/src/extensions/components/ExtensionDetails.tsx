import type {
  ExtensionCompatibility,
  ExtensionContributions,
  ExtensionDiagnostic,
  InstalledExtension,
  RegistryExtensionDetails,
} from '@atlas/contracts';
import { BadgeCheck, ExternalLink, Palette, Puzzle, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEditorPreferences } from '@/editor/hooks/useEditorPreferences';
import { cn } from '@/lib/utils';
import type { ProjectDetails } from '@/types';
import {
  COMPATIBILITY_HINTS,
  COMPATIBILITY_LABELS,
  REGISTRY_ERRORS,
  compatibilityClass,
  formatDate,
} from '../format';

export function CompatibilityBadge({ compatibility }: { compatibility: ExtensionCompatibility }) {
  return (
    <Badge
      variant="outline"
      className={cn(compatibilityClass(compatibility.level))}
      title={COMPATIBILITY_HINTS[compatibility.level]}
      data-testid="compatibility-badge"
    >
      {COMPATIBILITY_LABELS[compatibility.level]}
    </Badge>
  );
}

/** What works, what does not, and the test record (FR-1512, FR-1549). */
function CompatibilityReport({ compatibility }: { compatibility: ExtensionCompatibility }) {
  return (
    <section className="flex flex-col gap-2" data-testid="compatibility-report">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Compatibility</h3>
        <CompatibilityBadge compatibility={compatibility} />
      </div>
      <p className="text-muted-foreground text-xs">{COMPATIBILITY_HINTS[compatibility.level]}</p>
      {compatibility.working.length > 0 && (
        <div>
          <p className="text-xs font-medium">Works in ATLAS</p>
          <ul className="text-muted-foreground list-disc pl-5 text-xs" data-testid="compat-working">
            {compatibility.working.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {compatibility.unsupported.length > 0 && (
        <div>
          <p className="text-xs font-medium">Not supported</p>
          <ul
            className="text-muted-foreground list-disc pl-5 text-xs"
            data-testid="compat-unsupported"
          >
            {compatibility.unsupported.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {compatibility.notes.length > 0 && (
        <ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
          {compatibility.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground text-xs">
        {compatibility.tested === null
          ? 'Not in the ATLAS tested compatibility list.'
          : `Tested with ATLAS ${compatibility.tested.atlasVersion} on ${compatibility.tested.platform}, ${formatDate(compatibility.tested.testedAt)}.`}
      </p>
    </section>
  );
}

type Override = 'inherit' | 'enabled' | 'disabled';

interface ExtensionDetailsProps {
  id: string;
  installed: InstalledExtension | null;
  installedIds: ReadonlySet<string>;
  contributions: ExtensionContributions | null;
  projectId: string | null;
  projects: ProjectDetails[];
  onChanged: () => void;
}

/** Registry details, lifecycle actions, project scope and diagnostics of one extension. */
export function ExtensionDetails(props: ExtensionDetailsProps) {
  const { id, installed, projectId, contributions, onChanged } = props;
  const [details, setDetails] = useState<RegistryExtensionDetails | null>(null);
  const [registryError, setRegistryError] = useState<{ message: string; down: boolean } | null>(
    null,
  );
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [dependencyPlan, setDependencyPlan] = useState<string[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<ExtensionDiagnostic[]>([]);
  const [diagnosticsVersion, setDiagnosticsVersion] = useState(0);
  const { preferences, update: updatePreferences } = useEditorPreferences();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await unwrap(api().extensions.details({ id, version }));
        if (cancelled) return;
        setDetails(loaded);
        setRegistryError(null);
      } catch (caught) {
        if (cancelled) return;
        setDetails(null);
        setRegistryError({
          message: errorMessage(caught),
          down: caught instanceof ApiError && REGISTRY_ERRORS.has(caught.code),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, version, installed?.version]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await unwrap(api().extensions.diagnostics(id)).catch(() => []);
      if (!cancelled) setDiagnostics(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, installed?.updatedAt, diagnosticsVersion]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.issues.length > 0
          ? `${caught.message} ${caught.issues.map((issue) => issue.message).join(', ')}`
          : errorMessage(caught),
      );
    } finally {
      setBusy(null);
      setDiagnosticsVersion((current) => current + 1);
      onChanged();
    }
  };

  const install = (ids: string[]) =>
    run('install', async () => {
      // Dependencies first, one by one, as the user confirmed (PLAN-043 Q5).
      for (const dependency of ids) {
        await unwrap(api().extensions.install({ id: dependency, version: null }));
      }
      await unwrap(api().extensions.install({ id, version }));
    });

  const requestInstall = () => {
    const missing = (details?.dependencies ?? [])
      .filter((dependency) => !props.installedIds.has(dependency.id.toLowerCase()))
      .map((dependency) => dependency.id);
    if (missing.length > 0) setDependencyPlan(missing);
    else void install([]);
  };

  const name = details?.displayName ?? installed?.displayName ?? id;
  const compatibility = details?.compatibility ?? installed?.compatibility ?? null;
  const targetVersion = details?.version ?? null;
  const unsupported = details?.compatibility.level === 'UNSUPPORTED';
  const projectState = installed?.projects.find((state) => state.projectId === projectId);
  const override: Override =
    projectState === undefined ? 'inherit' : projectState.enabled ? 'enabled' : 'disabled';
  const key = id.toLowerCase();
  const themes = contributions?.themes.filter((theme) => theme.extensionId === key) ?? [];
  const iconThemes = contributions?.iconThemes.filter((theme) => theme.extensionId === key) ?? [];
  const projectName = props.projects.find(({ project }) => project.id === projectId)?.project.name;

  let installLabel = 'Install';
  if (installed !== null && targetVersion !== null) {
    installLabel =
      installed.version === targetVersion
        ? 'Reinstall'
        : `Install ${targetVersion} (replaces ${installed.version})`;
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
      data-testid="extension-details"
    >
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Puzzle className="text-muted-foreground size-5" aria-hidden="true" />
          <h2 className="text-lg font-semibold" data-testid="extension-title">
            {name}
          </h2>
          {details?.verified && (
            <Badge variant="outline" title="Publisher verified by Open VSX">
              <BadgeCheck /> Verified publisher
            </Badge>
          )}
          {details?.deprecated && <Badge variant="destructive">Deprecated</Badge>}
          {details?.preRelease && <Badge variant="outline">Pre-release</Badge>}
        </div>
        <p className="text-muted-foreground font-mono text-xs">
          {details?.id ?? installed?.id ?? id}
        </p>
        <p className="text-sm">{details?.description ?? installed?.description}</p>
      </header>

      {registryError && (
        <p
          className="border-border bg-muted rounded-md border px-3 py-2 text-xs"
          role={registryError.down ? 'status' : 'alert'}
          data-testid="registry-error"
        >
          {registryError.message}
          {installed !== null && ' The installed version keeps working.'}
        </p>
      )}
      {error && (
        <p className="text-destructive text-sm" role="alert" data-testid="extension-error">
          {error}
        </p>
      )}

      <section className="flex flex-wrap items-end gap-2">
        {details !== null && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="extension-version">Version</Label>
            <Select
              value={version ?? '__latest__'}
              onValueChange={(value) => setVersion(value === '__latest__' ? null : value)}
            >
              <SelectTrigger id="extension-version" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__latest__">
                  Latest ({details.versions[0] ?? details.version})
                </SelectItem>
                {details.versions.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {details !== null && (
          <Button
            onClick={requestInstall}
            disabled={busy !== null || unsupported || details.platform === null}
            data-testid="extension-install"
          >
            {busy === 'install' ? 'Installing…' : installLabel}
          </Button>
        )}
        {installed !== null && (
          <Button
            variant="outline"
            onClick={() => setConfirmRemove(true)}
            disabled={busy !== null}
            data-testid="extension-uninstall"
          >
            Uninstall
          </Button>
        )}
      </section>
      {details !== null && details.platform === null && (
        <p className="text-muted-foreground text-xs">
          No package for this system. Available for: {details.platforms.join(', ')}.
        </p>
      )}
      {unsupported && (
        <p className="text-muted-foreground text-xs">
          Installation is disabled because ATLAS could not use anything it provides.
        </p>
      )}

      {installed !== null && (
        <section
          className="flex flex-col gap-3 rounded-md border p-3"
          data-testid="extension-scope"
        >
          <p className="text-sm">
            Installed version <span className="font-mono">{installed.version}</span>
            {installed.broken && (
              <span className="text-destructive"> — files are missing; reinstall it.</span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Checkbox
              id="extension-enabled"
              checked={installed.enabled}
              disabled={busy !== null}
              onCheckedChange={(checked) =>
                void run('enable', () =>
                  unwrap(
                    api().extensions.setEnabled({ id, projectId: null, enabled: checked === true }),
                  ),
                )
              }
            />
            <Label htmlFor="extension-enabled">Enabled in every project</Label>
          </div>
          {projectId !== null && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="extension-project">In {projectName ?? 'this project'}</Label>
              <Select
                value={override}
                disabled={busy !== null}
                onValueChange={(value) =>
                  void run('scope', () =>
                    unwrap(
                      api().extensions.setEnabled({
                        id,
                        projectId,
                        enabled: value === 'inherit' ? null : value === 'enabled',
                      }),
                    ),
                  )
                }
              >
                <SelectTrigger id="extension-project" className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">
                    Follow the global setting ({installed.enabled ? 'enabled' : 'disabled'})
                  </SelectItem>
                  <SelectItem value="enabled">Enabled in this project</SelectItem>
                  <SelectItem value="disabled">Disabled in this project</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <p className="text-muted-foreground text-xs" data-testid="extension-active">
            {installed.activeHere
              ? `Active ${projectId === null ? 'globally' : 'in this project'}.`
              : `Not active ${projectId === null ? 'globally' : 'in this project'}.`}
          </p>
          {installed.missingDependencies.length > 0 && (
            <p className="text-amber-300 text-xs" role="status">
              <TriangleAlert className="mr-1 inline size-3.5" aria-hidden="true" />
              Missing dependencies: {installed.missingDependencies.join(', ')}
            </p>
          )}
          {(themes.length > 0 || iconThemes.length > 0) && (
            <div className="flex flex-col gap-1.5">
              {themes.map((theme) => (
                <ThemeRow
                  key={theme.key}
                  label={`Color theme: ${theme.label}`}
                  inUse={preferences.colorTheme === theme.key}
                  onUse={() => void updatePreferences({ colorTheme: theme.key })}
                  onStop={() => void updatePreferences({ colorTheme: null })}
                />
              ))}
              {iconThemes.map((theme) => (
                <ThemeRow
                  key={theme.key}
                  label={`File icon theme: ${theme.label}`}
                  inUse={preferences.iconTheme === theme.key}
                  onUse={() => void updatePreferences({ iconTheme: theme.key })}
                  onStop={() => void updatePreferences({ iconTheme: null })}
                />
              ))}
              <p className="text-muted-foreground text-xs">
                Installing never changes your theme; choose it here or in Settings.
              </p>
            </div>
          )}
        </section>
      )}

      {compatibility !== null && <CompatibilityReport compatibility={compatibility} />}

      {details !== null && (
        <section className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">Publisher</span>
          <span>{details.namespace}</span>
          <span className="text-muted-foreground">Published</span>
          <span>{formatDate(details.publishedAt)}</span>
          <span className="text-muted-foreground">License</span>
          <span>{details.license ?? 'Not stated'}</span>
          <span className="text-muted-foreground">Categories</span>
          <span>{details.categories.join(', ') || '—'}</span>
          <span className="text-muted-foreground">Platforms</span>
          <span>{details.platforms.join(', ')}</span>
          <span className="text-muted-foreground">Dependencies</span>
          <span data-testid="extension-dependencies">
            {details.dependencies.length === 0
              ? 'None'
              : details.dependencies
                  .map((item) => `${item.id}${item.installed ? ' (installed)' : ''}`)
                  .join(', ')}
          </span>
          {details.packMembers.length > 0 && (
            <>
              <span className="text-muted-foreground">Extension pack</span>
              <span>
                {details.packMembers
                  .map((item) => `${item.id}${item.installed ? ' (installed)' : ''}`)
                  .join(', ')}
              </span>
            </>
          )}
        </section>
      )}
      {details !== null && (details.homepage || details.repository) && (
        <div className="flex flex-wrap gap-2">
          {[details.homepage, details.repository]
            .filter((link): link is string => link !== null && link.startsWith('https://'))
            .map((link) => (
              <Button
                key={link}
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => void api().extensions.openLink(link)}
              >
                <ExternalLink /> {new URL(link).hostname}
              </Button>
            ))}
        </div>
      )}

      <section className="flex flex-col gap-1" data-testid="extension-diagnostics">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Diagnostics</h3>
          {diagnostics.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void unwrap(api().extensions.clearDiagnostics(id)).then(() => {
                  setDiagnosticsVersion((current) => current + 1);
                  onChanged();
                })
              }
            >
              Clear
            </Button>
          )}
        </div>
        {diagnostics.length === 0 ? (
          <p className="text-muted-foreground text-xs">No problems recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {diagnostics.map((item) => (
              <li key={item.id} className="flex gap-2">
                <span
                  className={cn(
                    'font-medium uppercase',
                    item.level === 'error' ? 'text-destructive' : 'text-amber-300',
                  )}
                >
                  {item.level}
                </span>
                <span className="text-muted-foreground">{formatDate(item.createdAt)}</span>
                <span className="min-w-0 break-words">{item.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its files are removed from ATLAS and its project settings are forgotten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void run('uninstall', () => unwrap(api().extensions.uninstall(id)))}
            >
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {dependencyPlan !== null && (
        <Dialog open onOpenChange={(open) => !open && setDependencyPlan(null)}>
          <DialogContent data-testid="dependency-dialog">
            <DialogHeader>
              <DialogTitle>Install dependencies first?</DialogTitle>
              <DialogDescription>
                {name} needs these extensions. Each is checked for compatibility like any other
                install; nothing else is installed.
              </DialogDescription>
            </DialogHeader>
            <ul className="list-disc pl-5 font-mono text-sm">
              {dependencyPlan.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDependencyPlan(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const plan = dependencyPlan;
                  setDependencyPlan(null);
                  void install(plan);
                }}
              >
                Install {dependencyPlan.length + 1} extensions
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function ThemeRow(props: { label: string; inUse: boolean; onUse: () => void; onStop: () => void }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Palette className="text-muted-foreground size-4" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.inUse ? (
        <>
          <Badge variant="secondary">In use</Badge>
          <Button size="xs" variant="ghost" onClick={props.onStop}>
            Stop using
          </Button>
        </>
      ) : (
        <Button size="xs" variant="outline" onClick={props.onUse}>
          Use
        </Button>
      )}
    </div>
  );
}
