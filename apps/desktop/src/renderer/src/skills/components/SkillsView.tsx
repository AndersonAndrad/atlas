import { Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { Badge, CompatibilityBadges } from '../format';
import { ImportSkillDialog } from './ImportSkillDialog';
import { SkillDetailsPanel } from './SkillDetailsPanel';
import { SourcesPanel } from './SourcesPanel';
import { SyncPanel } from './SyncPanel';

/**
 * Skills Hub (SDD-006 Milestone B): reusable skills managed by ATLAS, independent of
 * provider sessions, with discovery, import, activation rules and synchronization.
 */
export function SkillsView({ projects }: { projects: ProjectDetails[] }) {
  const [tab, setTab] = useState('installed');
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const changed = () => setVersion((value) => value + 1);

  const skills = useKeyedLoad(`skills:${version}`, () => api().skills.list());
  const current = selected ?? skills.value?.[0]?.id ?? null;
  const details = useKeyedLoad(current === null ? null : `skill:${current}:${version}`, () =>
    api().skills.details(current!),
  );

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="skills-view">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <h1 className="text-lg font-semibold">Skills</h1>
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <Plus />
          New from template
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Tabs value={tab} onValueChange={setTab} className="min-w-0">
          <TabsList>
            <TabsTrigger value="installed">Installed</TabsTrigger>
            <TabsTrigger value="available">Available</TabsTrigger>
            <TabsTrigger value="sync">Sync</TabsTrigger>
          </TabsList>
          <TabsContent value="installed">
            {skills.error && <p className="text-destructive text-sm">{skills.error}</p>}
            {skills.value?.length === 0 ? (
              <div
                className="text-muted-foreground flex flex-col items-center gap-2 p-8 text-center text-sm"
                data-testid="skills-empty"
              >
                <Sparkles className="size-8" aria-hidden="true" />
                <p className="text-foreground font-medium">No skills yet</p>
                <p className="max-w-sm">
                  Import skills from Claude Code, Codex or any folder in Available, or start from a
                  template. New skills stay disabled until you enable them.
                </p>
              </div>
            ) : (
              <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                <ul className="flex min-w-0 flex-col gap-1" aria-label="Installed skills">
                  {skills.value?.map((skill) => (
                    <li key={skill.id}>
                      <button
                        type="button"
                        className={cn(
                          'flex w-full min-w-0 flex-col gap-1 rounded-md border p-2 text-left',
                          skill.id === current && 'border-sidebar-primary bg-accent/40',
                        )}
                        onClick={() => setSelected(skill.id)}
                        data-testid="skill-item"
                        aria-current={skill.id === current}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-medium">{skill.name}</span>
                          <Badge
                            className={
                              skill.enabled
                                ? 'bg-success/15 text-success'
                                : 'bg-muted text-muted-foreground'
                            }
                          >
                            {skill.enabled ? 'Enabled' : 'Off'}
                          </Badge>
                          {!skill.validation.valid && (
                            <Badge className="bg-destructive/15 text-destructive">Invalid</Badge>
                          )}
                        </span>
                        <span className="text-muted-foreground text-xs">{skill.version}</span>
                        <CompatibilityBadges items={skill.validation.compatibility} />
                      </button>
                    </li>
                  ))}
                </ul>
                {details.error && <p className="text-destructive text-sm">{details.error}</p>}
                {details.value && (
                  <SkillDetailsPanel
                    key={details.value.skill.id}
                    details={details.value}
                    projects={projects}
                    onChanged={changed}
                    onRemoved={() => {
                      setSelected(null);
                      changed();
                    }}
                    onImportUpdate={setImporting}
                  />
                )}
              </div>
            )}
          </TabsContent>
          <TabsContent value="available">
            <SourcesPanel version={version} onImport={setImporting} />
          </TabsContent>
          <TabsContent value="sync">
            <SyncPanel version={version} />
          </TabsContent>
        </Tabs>
      </div>
      {importing && (
        <ImportSkillDialog
          path={importing}
          onClose={() => setImporting(null)}
          onImported={(id) => {
            setImporting(null);
            setSelected(id);
            setTab('installed');
            changed();
          }}
        />
      )}
      {creating && (
        <TemplateDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
            setTab('installed');
            changed();
          }}
        />
      )}
    </main>
  );
}

function TemplateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const templates = useKeyedLoad('skill-templates', () => api().skills.templates());
  const [templateId, setTemplateId] = useState<string>('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const template = templates.value?.find((item) => item.id === templateId);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const skill = await unwrap(api().skills.createFromTemplate({ templateId, name }));
      onCreated(skill.id);
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
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="skill-template-dialog">
        <DialogHeader>
          <DialogTitle>New skill from a template</DialogTitle>
          <DialogDescription>
            Templates are optional starting points; the new skill is yours to edit and stays off
            until you enable it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-template">Template</Label>
            <Select
              value={templateId}
              onValueChange={(value) => {
                setTemplateId(value);
                if (name === '') setName(value);
              }}
            >
              <SelectTrigger id="skill-template" className="w-full">
                <SelectValue placeholder="Choose a template" />
              </SelectTrigger>
              <SelectContent>
                {templates.value?.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name} ({item.version})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {template && <p className="text-muted-foreground text-xs">{template.description}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-name">Skill name</Label>
            <Input
              id="skill-name"
              value={name}
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
              placeholder="lowercase-with-hyphens"
            />
          </div>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={busy || templateId === '' || name === ''}>
            {busy ? 'Creating…' : 'Create skill'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
