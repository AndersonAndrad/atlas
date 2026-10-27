import {
  EXTENSION_CATEGORIES,
  type ExtensionCategory,
  type ExtensionUpdateCheck,
  type InstalledExtension,
} from '@atlas/contracts';
import { Puzzle, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { cn } from '@/lib/utils';
import type { ProjectDetails } from '@/types';
import { formatDate } from '../format';
import { useExtensionSearch, useInstalledExtensions } from '../useExtensions';
import { CompatibilityBadge, ExtensionDetails } from './ExtensionDetails';

const ALL = '__all__';
const GLOBAL = '__global__';

function ListButton(props: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={props.selected ? 'true' : undefined}
        onClick={props.onSelect}
        className={cn(
          'hover:bg-accent flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left',
          props.selected && 'bg-accent',
        )}
        data-testid="extension-item"
      >
        <span className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{props.title}</span>
          {props.children}
        </span>
        <span className="text-muted-foreground line-clamp-2 text-xs">{props.subtitle}</span>
      </button>
    </li>
  );
}

/**
 * Extensions Hub (SDD-015 Milestone A): Open VSX search, installed extensions, updates and
 * per-project enablement. Declarative contributions only: no extension code runs.
 */
export function ExtensionsView({
  projects,
  projectId: selectedProjectId,
}: {
  projects: ProjectDetails[];
  projectId: string | null;
}) {
  const [tab, setTab] = useState<'marketplace' | 'installed' | 'updates'>('marketplace');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ExtensionCategory | null>(null);
  const [publisher, setPublisher] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [scopeProject, setScopeProject] = useState<string | null | undefined>(undefined);
  const projectId = scopeProject === undefined ? selectedProjectId : scopeProject;
  const search = useExtensionSearch(query, category, publisher);
  const { installed, contributions, error, reload } = useInstalledExtensions(projectId);
  const [updates, setUpdates] = useState<ExtensionUpdateCheck | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const installedById = useMemo(
    () => new Map((installed ?? []).map((item) => [item.id.toLowerCase(), item])),
    [installed],
  );
  const installedIds = useMemo(() => new Set(installedById.keys()), [installedById]);
  const selectedInstalled: InstalledExtension | null =
    selected === null ? null : (installedById.get(selected.toLowerCase()) ?? null);

  const checkUpdates = async () => {
    setUpdating('check');
    setUpdateError(null);
    try {
      setUpdates(await unwrap(api().extensions.checkUpdates()));
    } catch (caught) {
      setUpdateError(errorMessage(caught));
    } finally {
      setUpdating(null);
    }
  };

  const update = async (ids: string[]) => {
    setUpdating(ids.length === 1 ? (ids[0] ?? null) : 'all');
    setUpdateError(null);
    try {
      for (const id of ids) await unwrap(api().extensions.install({ id, version: null }));
      setUpdates((current) =>
        current === null
          ? null
          : { ...current, updates: current.updates.filter((item) => !ids.includes(item.id)) },
      );
    } catch (caught) {
      setUpdateError(errorMessage(caught));
    } finally {
      setUpdating(null);
      reload();
    }
  };

  const compatibleUpdates =
    updates?.updates.filter((item) => item.compatibility.level !== 'UNSUPPORTED') ?? [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="extensions-view">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <Puzzle className="text-muted-foreground size-5" aria-hidden="true" />
        <h1 className="text-base font-semibold">Extensions</h1>
        <p className="text-muted-foreground hidden text-xs lg:block">
          Themes, icons, grammars, snippets and language settings from Open VSX. Extension code does
          not run in ATLAS yet.
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor="extensions-project" className="text-xs">
            Project
          </Label>
          <Select
            value={projectId ?? GLOBAL}
            onValueChange={(value) => setScopeProject(value === GLOBAL ? null : value)}
          >
            <SelectTrigger id="extensions-project" className="w-48" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={GLOBAL}>No project (global)</SelectItem>
              {projects.map(({ project }) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="flex max-h-[45%] shrink-0 flex-col gap-2 border-b p-3 md:max-h-none md:w-80 md:border-r md:border-b-0">
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as typeof tab)}
            className="min-h-0 flex-1"
          >
            <TabsList className="w-full">
              <TabsTrigger value="marketplace">Open VSX</TabsTrigger>
              <TabsTrigger value="installed">
                Installed{installed && installed.length > 0 ? ` (${installed.length})` : ''}
              </TabsTrigger>
              <TabsTrigger value="updates">Updates</TabsTrigger>
            </TabsList>
            <TabsContent value="marketplace" className="flex min-h-0 flex-col gap-2">
              <Input
                aria-label="Search extensions"
                placeholder="Search Open VSX"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={200}
              />
              <div className="flex gap-2">
                <Select
                  value={category ?? ALL}
                  onValueChange={(value) =>
                    setCategory(value === ALL ? null : (value as ExtensionCategory))
                  }
                >
                  <SelectTrigger aria-label="Category" className="min-w-0 flex-1" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All categories</SelectItem>
                    {EXTENSION_CATEGORIES.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  aria-label="Publisher"
                  placeholder="Publisher"
                  className="h-8 w-28"
                  value={publisher}
                  onChange={(event) => setPublisher(event.target.value)}
                  maxLength={128}
                />
              </div>
              {search.error && (
                <p
                  className="bg-muted rounded-md px-2 py-1.5 text-xs"
                  role="status"
                  data-testid="registry-unavailable"
                >
                  {search.error}
                </p>
              )}
              {search.loading && search.result === null && (
                <p className="text-muted-foreground text-xs">Searching…</p>
              )}
              <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
                {search.result?.extensions.map((item) => (
                  <ListButton
                    key={item.id}
                    selected={selected === item.id}
                    onSelect={() => setSelected(item.id)}
                    title={item.displayName}
                    subtitle={`${item.namespace} · ${item.version} · ${item.description}`}
                  >
                    {installedIds.has(item.id.toLowerCase()) && (
                      <Badge variant="secondary">Installed</Badge>
                    )}
                  </ListButton>
                ))}
                {search.result?.extensions.length === 0 && (
                  <p className="text-muted-foreground px-2 text-xs">No extensions found.</p>
                )}
              </ul>
            </TabsContent>
            <TabsContent value="installed" className="flex min-h-0 flex-col gap-2">
              {error && (
                <p className="text-destructive text-xs" role="alert">
                  {error}
                </p>
              )}
              {installed?.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  No extensions installed. Search Open VSX to add one.
                </p>
              )}
              <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
                {installed?.map((item) => (
                  <ListButton
                    key={item.id}
                    selected={selected === item.id}
                    onSelect={() => setSelected(item.id)}
                    title={item.displayName}
                    subtitle={`${item.version} · ${
                      item.broken ? 'files missing' : item.activeHere ? 'active' : 'disabled'
                    }${item.problems > 0 ? ` · ${item.problems} problems` : ''}`}
                  >
                    <CompatibilityBadge compatibility={item.compatibility} />
                  </ListButton>
                ))}
              </ul>
            </TabsContent>
            <TabsContent value="updates" className="flex min-h-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void checkUpdates()}
                  disabled={updating !== null}
                >
                  <RefreshCw /> {updating === 'check' ? 'Checking…' : 'Check for updates'}
                </Button>
                {compatibleUpdates.length > 1 && (
                  <Button
                    size="sm"
                    onClick={() => void update(compatibleUpdates.map((item) => item.id))}
                    disabled={updating !== null}
                  >
                    Update all
                  </Button>
                )}
              </div>
              <p className="text-muted-foreground text-xs">
                ATLAS checks only when you ask
                {updates ? `; last checked ${formatDate(updates.checkedAt)}.` : '.'}
              </p>
              {updateError && (
                <p className="text-destructive text-xs" role="alert">
                  {updateError}
                </p>
              )}
              {updates !== null && updates.failed.length > 0 && (
                <p className="text-muted-foreground text-xs">
                  Could not check: {updates.failed.join(', ')}
                </p>
              )}
              {updates?.updates.length === 0 && (
                <p className="text-muted-foreground text-xs" data-testid="no-updates">
                  Everything is up to date.
                </p>
              )}
              <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {updates?.updates.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
                    data-testid="extension-update"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left"
                      onClick={() => setSelected(item.id)}
                    >
                      <span className="font-medium">{item.id}</span> {item.installedVersion} →{' '}
                      {item.latestVersion}
                    </button>
                    <CompatibilityBadge compatibility={item.compatibility} />
                    <Button
                      size="xs"
                      disabled={updating !== null || item.compatibility.level === 'UNSUPPORTED'}
                      onClick={() => void update([item.id])}
                    >
                      {updating === item.id ? 'Updating…' : 'Update'}
                    </Button>
                  </li>
                ))}
              </ul>
            </TabsContent>
          </Tabs>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected === null ? (
            <div className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-sm">
              Choose an extension to see what works in ATLAS.
            </div>
          ) : (
            <ExtensionDetails
              key={selected}
              id={selected}
              installed={selectedInstalled}
              installedIds={installedIds}
              contributions={contributions}
              projectId={projectId}
              projects={projects}
              onChanged={reload}
            />
          )}
        </main>
      </div>
    </div>
  );
}
