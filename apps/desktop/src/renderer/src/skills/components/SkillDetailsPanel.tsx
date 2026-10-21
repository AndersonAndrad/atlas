import {
  AGENT_ROLES,
  AI_PROVIDERS,
  type SkillAssignmentEffect,
  type SkillDetails,
  type SkillScope,
} from '@atlas/contracts';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ROLE_LABELS, formatDateTime } from '@/context/format';
import { useKeyedLoad } from '@/context/hooks/useContextData';
import { cn } from '@/lib/utils';
import type { ProjectDetails } from '@/types';
import {
  CompatibilityBadges,
  IssueList,
  PROVIDER_NAMES,
  SCOPE_LABELS,
  SOURCE_LABELS,
  formatBytes,
} from '../format';

const message = (caught: unknown) =>
  caught instanceof ApiError && caught.issues.length > 0
    ? caught.issues.map((issue) => issue.message).join(' ')
    : errorMessage(caught);

interface SkillDetailsPanelProps {
  details: SkillDetails;
  projects: ProjectDetails[];
  onChanged: () => void;
  onRemoved: () => void;
  onImportUpdate: (path: string) => void;
}

/** Metadata, compatibility, activation, files and versions of one skill (FR-622). */
export function SkillDetailsPanel({
  details,
  projects,
  onChanged,
  onRemoved,
  onImportUpdate,
}: SkillDetailsPanelProps) {
  const { skill, versions } = details;
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [diffing, setDiffing] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const current = versions.find((version) => version.sequence === skill.currentSequence);
  const editable = skill.source.kind === 'template' || skill.source.kind === 'atlas';

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(message(caught));
    }
  }

  const targetLabel = (scope: SkillScope, target: string) =>
    scope === 'project'
      ? (projects.find((item) => item.project.id === target)?.project.name ?? 'Removed project')
      : scope === 'provider'
        ? PROVIDER_NAMES[target as keyof typeof PROVIDER_NAMES]
        : scope === 'role'
          ? ROLE_LABELS[target as keyof typeof ROLE_LABELS]
          : `Session ${target.slice(0, 8)}`;

  return (
    <section
      className="flex min-w-0 flex-col gap-4"
      data-testid="skill-details"
      aria-label={skill.name}
    >
      <header className="flex min-w-0 flex-col gap-1">
        <h2 className="text-lg font-semibold break-words">{skill.name}</h2>
        <p className="text-muted-foreground text-sm">{skill.description || 'No description.'}</p>
        <p className="text-muted-foreground text-xs">
          Version {skill.version} · {SOURCE_LABELS[skill.source.kind]}
          {skill.source.path ? ` · ${skill.source.path}` : ''}
        </p>
        <CompatibilityBadges items={skill.validation.compatibility} />
      </header>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription data-testid="skill-error">{error}</AlertDescription>
        </Alert>
      )}

      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={skill.enabled}
          disabled={!skill.validation.valid}
          onCheckedChange={(checked) =>
            void act(() => unwrap(api().skills.setEnabled(skill.id, checked === true)))
          }
          data-testid="skill-enabled"
        />
        <span className="flex flex-col">
          <span>Enabled for every project</span>
          <span className="text-muted-foreground text-xs">
            Narrower rules below win: project restrictions, then session, role, project and provider
            choices.
          </span>
        </span>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void act(() => unwrap(api().skills.validate(skill.id)))}
        >
          Check again
        </Button>
        {details.updateAvailable && skill.source.path && (
          <Button size="sm" onClick={() => onImportUpdate(skill.source.path!)}>
            Review update
          </Button>
        )}
        {editable && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={() => setRemoving(true)}
        >
          <Trash2 />
          Remove from ATLAS
        </Button>
      </div>

      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Checks</h3>
        <IssueList
          issues={[
            ...skill.validation.issues,
            ...skill.validation.compatibility.flatMap((item) => item.issues),
          ]}
          testId="skill-issues"
        />
        {skill.validation.permissions.length > 0 && (
          <ul className="list-disc pl-5 text-xs" aria-label="Requested permissions">
            {skill.validation.permissions.map((permission) => (
              <li key={permission}>{permission}</li>
            ))}
          </ul>
        )}
        {skill.validation.dependencies.map((dependency) => (
          <p key={`${dependency.kind}:${dependency.name}`} className="text-xs">
            {dependency.kind} <code>{dependency.name}</code>:{' '}
            <span className={dependency.status === 'missing' ? 'text-destructive' : undefined}>
              {dependency.status}
            </span>
          </p>
        ))}
        <p className="text-muted-foreground text-xs">
          Checked {formatDateTime(skill.validation.checkedAt)}
        </p>
      </section>

      <Assignments
        skillId={skill.id}
        assignments={skill.assignments}
        projects={projects}
        targetLabel={targetLabel}
        onAct={act}
      />

      {current && (
        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">Files</h3>
          <ul className="flex flex-col text-xs" data-testid="skill-files">
            {current.files.map((file) => (
              <li key={file.path} className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left font-mono hover:underline"
                  onClick={() => setViewing(file.path)}
                >
                  {file.path}
                </button>
                {file.script && <span className="text-warning">script</span>}
                <span className="text-muted-foreground tabular-nums">{formatBytes(file.size)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Versions</h3>
        <ol className="flex flex-col gap-1 text-xs" data-testid="skill-versions">
          {versions.map((version) => (
            <li key={version.sequence} className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className={cn(
                  'font-medium',
                  version.sequence === skill.currentSequence && 'text-success',
                )}
              >
                #{version.sequence} · {version.version}
              </span>
              <span className="text-muted-foreground">{formatDateTime(version.importedAt)}</span>
              {version.note && <span className="text-muted-foreground">— {version.note}</span>}
              {version.sequence > 1 && (
                <Button size="xs" variant="ghost" onClick={() => setDiffing(version.sequence)}>
                  Changes from #{version.sequence - 1}
                </Button>
              )}
            </li>
          ))}
        </ol>
      </section>

      {viewing && current && (
        <FileDialog
          skillId={skill.id}
          sequence={current.sequence}
          path={viewing}
          onClose={() => setViewing(null)}
        />
      )}
      {diffing !== null && (
        <DiffDialog skillId={skill.id} to={diffing} onClose={() => setDiffing(null)} />
      )}
      {editing && (
        <EditDialog
          skillId={skill.id}
          sequence={skill.currentSequence}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {skill.name} from ATLAS?</AlertDialogTitle>
            <AlertDialogDescription>
              Its versions and assignments are removed from ATLAS. The original folder
              {skill.source.path ? ` (${skill.source.path})` : ''} is not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void (async () => {
                  setError(null);
                  try {
                    await unwrap(api().skills.remove(skill.id));
                    onRemoved();
                  } catch (caught) {
                    setError(message(caught));
                  }
                })()
              }
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function Assignments({
  skillId,
  assignments,
  projects,
  targetLabel,
  onAct,
}: {
  skillId: string;
  assignments: SkillDetails['skill']['assignments'];
  projects: ProjectDetails[];
  targetLabel: (scope: SkillScope, target: string) => string;
  onAct: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [scope, setScope] = useState<'project' | 'provider' | 'role'>('project');
  const [target, setTarget] = useState<string>('');
  const [effect, setEffect] = useState<SkillAssignmentEffect>('enable');
  const targets: [string, string][] =
    scope === 'project'
      ? projects.map((item) => [item.project.id, item.project.name])
      : scope === 'provider'
        ? AI_PROVIDERS.map((provider) => [provider, PROVIDER_NAMES[provider]])
        : AGENT_ROLES.map((role) => [role, ROLE_LABELS[role]]);
  return (
    <section className="flex flex-col gap-2" data-testid="skill-assignments">
      <h3 className="text-sm font-semibold">Where it applies</h3>
      {assignments.length === 0 && (
        <p className="text-muted-foreground text-xs">
          No project, provider, role or session rules.
        </p>
      )}
      <ul className="flex flex-col gap-1 text-xs">
        {assignments.map((item) => (
          <li
            key={`${item.scope}:${item.target}`}
            className="flex items-center gap-2"
            data-testid="skill-assignment"
          >
            <span className={item.effect === 'enable' ? 'text-success' : 'text-destructive'}>
              {item.effect === 'enable' ? 'Enabled' : 'Disabled'}
            </span>
            <span>
              {SCOPE_LABELS[item.scope]}: {targetLabel(item.scope, item.target)}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove rule ${SCOPE_LABELS[item.scope]} ${targetLabel(item.scope, item.target)}`}
              onClick={() =>
                void onAct(() =>
                  unwrap(
                    api().skills.unassign({ skillId, scope: item.scope, target: item.target }),
                  ),
                )
              }
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
        <Select
          value={scope}
          onValueChange={(value) => {
            setScope(value as typeof scope);
            setTarget('');
          }}
        >
          <SelectTrigger aria-label="Rule scope" className="w-full sm:w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="project">Project</SelectItem>
            <SelectItem value="provider">Provider</SelectItem>
            <SelectItem value="role">Role</SelectItem>
          </SelectContent>
        </Select>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger aria-label="Rule target" className="w-full">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {targets.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={effect} onValueChange={(value) => setEffect(value as SkillAssignmentEffect)}>
          <SelectTrigger aria-label="Rule effect" className="w-full sm:w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="enable">Enable</SelectItem>
            <SelectItem value="disable">Disable</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={target === ''}
          onClick={() =>
            void onAct(() => unwrap(api().skills.assign({ skillId, scope, target, effect })))
          }
        >
          Add rule
        </Button>
      </div>
    </section>
  );
}

function FileDialog({
  skillId,
  sequence,
  path,
  onClose,
}: {
  skillId: string;
  sequence: number;
  path: string;
  onClose: () => void;
}) {
  const file = useKeyedLoad(`skill-file:${skillId}:${sequence}:${path}`, () =>
    api().skills.readFile({ skillId, sequence, path }),
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="skill-file-dialog"
      >
        <DialogHeader>
          <DialogTitle className="break-all font-mono text-sm">{path}</DialogTitle>
          <DialogDescription>
            Read-only copy stored by ATLAS. It is never executed.
          </DialogDescription>
        </DialogHeader>
        {file.error && <p className="text-destructive text-sm">{file.error}</p>}
        {file.value && (
          <pre className="bg-muted/50 max-h-[60vh] overflow-auto rounded border p-3 font-mono text-xs whitespace-pre-wrap">
            {file.value.content ?? 'Binary file: not shown.'}
            {file.value.truncated ? '\n…' : ''}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DiffDialog({
  skillId,
  to,
  onClose,
}: {
  skillId: string;
  to: number;
  onClose: () => void;
}) {
  const diff = useKeyedLoad(`skill-diff:${skillId}:${to}`, () =>
    api().skills.diff({ skillId, from: to - 1, to }),
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="skill-diff-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            Changes from version #{to - 1} to #{to}
          </DialogTitle>
          <DialogDescription>SKILL.md line by line, and the files that changed.</DialogDescription>
        </DialogHeader>
        {diff.error && <p className="text-destructive text-sm">{diff.error}</p>}
        {diff.value && (
          <>
            {diff.value.files.length > 0 && (
              <ul className="text-xs">
                {diff.value.files.map((file) => (
                  <li key={file.path}>
                    {file.change}: <code>{file.path}</code>
                  </li>
                ))}
              </ul>
            )}
            <pre
              className="max-h-[55vh] overflow-auto rounded border font-mono text-xs"
              data-testid="skill-diff"
            >
              {diff.value.lines.map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    'px-2 whitespace-pre-wrap',
                    line.kind === 'added' && 'bg-success/15',
                    line.kind === 'removed' && 'bg-destructive/15',
                  )}
                >
                  {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                  {line.text}
                </div>
              ))}
            </pre>
            {diff.value.truncated && (
              <p className="text-muted-foreground text-xs">Too long to compare line by line.</p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  skillId,
  sequence,
  onClose,
  onSaved,
}: {
  skillId: string;
  sequence: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const file = useKeyedLoad(`skill-edit:${skillId}:${sequence}`, () =>
    api().skills.readFile({ skillId, sequence, path: 'SKILL.md' }),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const content = draft ?? file.value?.content ?? '';

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api().skills.edit({ skillId, content }));
      onSaved();
    } catch (caught) {
      setError(message(caught));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="skill-edit-dialog"
      >
        <DialogHeader>
          <DialogTitle>Edit SKILL.md</DialogTitle>
          <DialogDescription>
            Saving creates a new version; earlier versions are kept.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="SKILL.md"
          rows={18}
          className="font-mono text-xs"
          value={content}
          onChange={(event) => setDraft(event.target.value)}
        />
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || draft === null}>
            {busy ? 'Saving…' : 'Save new version'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
