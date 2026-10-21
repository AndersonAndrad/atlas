import {
  AGENT_ROLES,
  type AgentRole,
  type ContextBundle,
  type ContextReference,
  type ContextTarget,
} from '@atlas/contracts';
import { Lock, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  EXCLUSION_LABELS,
  ROLE_LABELS,
  SECTION_LABELS,
  VERIFICATION_LABELS,
  VERIFICATION_TONES,
  formatTokens,
} from '../format';
import { useKeyedLoad } from '../hooks/useContextData';

/** What the user chose to select context for (SDD-006 FR-601, FR-609). */
export interface ContextSelection {
  objective: string;
  agentRole: AgentRole;
  detail: 'essential' | 'full';
  excludeIds: string[];
  /** Skills added for this session only. */
  skillIds: string[];
}

export const DEFAULT_SELECTION: ContextSelection = {
  objective: '',
  agentRole: 'generic',
  detail: 'full',
  excludeIds: [],
  skillIds: [],
};

/** Request fields of a selection; empty values are left out. */
export function selectionRequest(selection: ContextSelection) {
  return {
    ...(selection.objective.trim() ? { objective: selection.objective.trim() } : {}),
    agentRole: selection.agentRole,
    detail: selection.detail,
    ...(selection.excludeIds.length > 0 ? { excludeIds: selection.excludeIds } : {}),
    ...(selection.skillIds.length > 0 ? { skillIds: selection.skillIds } : {}),
  };
}

const BUDGET_SOURCES: Record<ContextBundle['budgetSource'], string> = {
  request: 'requested',
  task: 'task budget',
  profile: 'execution profile budget',
  role: 'role budget',
  provider: 'provider budget',
  default: 'default budget',
};

/** One line summary: estimated size, budget and what was left out. */
export function bundleSummary(bundle: ContextBundle): string {
  const leftOut = bundle.excluded.length;
  return (
    `${formatTokens(bundle.estimatedTokens)} of ${bundle.budgetTokens.toLocaleString('en-US')} ` +
    `(${BUDGET_SOURCES[bundle.budgetSource]}) · ${bundle.included.length} record(s) included` +
    (leftOut ? ` · ${leftOut} left out` : '') +
    (bundle.freshness.stale.length ? ` · ${bundle.freshness.stale.length} stale` : '')
  );
}

/** Objective, role and detail inputs; the objective applies when the field loses focus. */
export function SelectionFields({
  value,
  onChange,
}: {
  value: ContextSelection;
  onChange: (value: ContextSelection) => void;
}) {
  const [objective, setObjective] = useState(value.objective);
  const apply = () => {
    if (objective !== value.objective) onChange({ ...value, objective });
  };
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="context-objective">Objective (optional)</Label>
        <Textarea
          id="context-objective"
          rows={2}
          maxLength={4000}
          placeholder="e.g. Add refresh tokens to the JWT authentication"
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          onBlur={apply}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) apply();
          }}
          data-testid="context-objective"
        />
        <span className="text-muted-foreground text-xs">
          Records are ranked by how well they match it. Without one, the task’s objective is used.
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="context-role">Role</Label>
        <Select
          value={value.agentRole}
          onValueChange={(role) => onChange({ ...value, agentRole: role as AgentRole })}
        >
          <SelectTrigger id="context-role" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AGENT_ROLES.map((role) => (
              <SelectItem key={role} value={role}>
                {ROLE_LABELS[role]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="context-detail">Detail</Label>
        <Select
          value={value.detail}
          onValueChange={(detail) =>
            onChange({ ...value, detail: detail as ContextSelection['detail'] })
          }
        >
          <SelectTrigger id="context-detail" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="full">Full: task and project knowledge</SelectItem>
            <SelectItem value="essential">
              Essential: task state first, the rest on request
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

const explain = (reference: ContextReference) =>
  reference.factors
    .map(
      (factor) =>
        `${factor.points >= 0 ? '+' : ''}${factor.points} ${factor.name}: ${factor.detail}`,
    )
    .join('\n');

function ReferenceRow({
  reference,
  included,
  onToggle,
  aside,
}: {
  reference: ContextReference;
  included: boolean;
  onToggle?: () => void;
  aside?: ReactNode;
}) {
  const locked = reference.required;
  return (
    <li className="flex min-w-0 items-start gap-2 py-1.5" data-testid="context-reference">
      {onToggle && (
        <Checkbox
          className="mt-0.5"
          checked={included}
          disabled={locked}
          onCheckedChange={onToggle}
          aria-label={`${included ? 'Exclude' : 'Include'} “${reference.title}”`}
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
          <span className="min-w-0 break-words">{reference.title}</span>
          {locked && (
            <span
              className="bg-sidebar-primary/15 text-sidebar-primary inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
              title="Required entries are always included"
            >
              <Lock className="size-3" aria-hidden="true" />
              Required
            </span>
          )}
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-medium',
              VERIFICATION_TONES[reference.verification],
            )}
          >
            {VERIFICATION_LABELS[reference.verification]}
          </span>
          {reference.stale && (
            <span className="bg-warning/15 text-warning rounded px-1.5 py-0.5 text-[10px] font-medium">
              Stale
            </span>
          )}
          {reference.duplicates.length > 0 && (
            <span className="text-muted-foreground text-[10px]">
              +{reference.duplicates.length} duplicate(s)
            </span>
          )}
        </span>
        <span className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
          <span
            title={explain(reference)}
            aria-label={`Score ${reference.score}. ${explain(reference)}`}
            tabIndex={0}
            className="cursor-help tabular-nums"
          >
            Score {reference.score}
          </span>
          <span>{formatTokens(reference.estimatedTokens)}</span>
          <span>
            Source: {reference.source.kind}
            {reference.source.ref ? ` ${reference.source.ref.slice(0, 12)}` : ''}
          </span>
          {reference.files.length > 0 && (
            <span className="min-w-0 truncate font-mono">
              {reference.files.slice(0, 3).join(', ')}
            </span>
          )}
        </span>
      </span>
      {aside}
    </li>
  );
}

/**
 * Included records by section with exclusion controls, records left out with their
 * reason, and warnings. Required records cannot be excluded (FR-609).
 */
export function BundleRecords({
  bundle,
  excludeIds,
  onExcludeChange,
}: {
  bundle: ContextBundle;
  excludeIds: string[];
  onExcludeChange?: (excludeIds: string[]) => void;
}) {
  const toggle = (id: string) =>
    onExcludeChange?.(
      excludeIds.includes(id) ? excludeIds.filter((item) => item !== id) : [...excludeIds, id],
    );
  const sections = [...new Set(bundle.included.map((reference) => reference.section))];
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="context-records">
      {bundle.warnings.length > 0 && (
        <Alert role="status" className="border-warning/40">
          <TriangleAlert className="text-warning" />
          <AlertDescription>
            <ul className="list-disc pl-4" data-testid="context-warnings">
              {bundle.warnings.map((warning, index) => (
                <li key={`${warning.kind}:${index}`}>{warning.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {bundle.objective && (
        <p className="text-sm">
          <span className="text-muted-foreground">Objective: </span>
          <span className="break-words">{bundle.objective}</span>
        </p>
      )}
      {sections.length === 0 && (
        <p className="text-muted-foreground text-sm">No stored records are included.</p>
      )}
      {sections.map((section) => (
        <section key={section} className="min-w-0">
          <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {SECTION_LABELS[section]}
          </h4>
          <ul className="divide-y">
            {bundle.included
              .filter((reference) => reference.section === section)
              .map((reference) => (
                <ReferenceRow
                  key={reference.id}
                  reference={reference}
                  included
                  {...(onExcludeChange ? { onToggle: () => toggle(reference.id) } : {})}
                />
              ))}
          </ul>
        </section>
      ))}
      {bundle.excluded.length > 0 && (
        <details className="rounded-md border p-2" data-testid="context-excluded">
          <summary className="cursor-pointer text-sm">Left out ({bundle.excluded.length})</summary>
          <ul className="divide-y">
            {bundle.excluded.map(({ reference, reason }) => (
              <ReferenceRow
                key={reference.id}
                reference={reference}
                included={false}
                {...(onExcludeChange && reason === 'user'
                  ? { onToggle: () => toggle(reference.id) }
                  : {})}
                aside={
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {EXCLUSION_LABELS[reason]}
                  </span>
                }
              />
            ))}
          </ul>
        </details>
      )}
      <section className="flex flex-col gap-1" data-testid="context-skills">
        <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Applicable skills
        </h4>
        {bundle.skills.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            None. Enable skills in the Skills view for this project, role or provider.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5 text-xs">
            {bundle.skills.map((skill) => (
              <li key={skill.skillId} data-testid="context-skill">
                <span className="font-medium">{skill.name}</span>{' '}
                <span className="text-muted-foreground">
                  ({skill.version}) — {skill.reason} Listed with its file path; its text is not
                  copied into the context.
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-muted-foreground text-xs">
        Token counts are estimates ({bundle.tokenEstimateMethod}), not measured provider usage.
        Mandatory ATLAS instructions are always sent and cannot be removed.
      </p>
    </div>
  );
}

/** Context preview before any AI execution: records, exclusions and the exact text. */
export function ContextPreviewDialog({
  target,
  targetKey: key,
  onClose,
}: {
  target: ContextTarget;
  targetKey: string;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState(DEFAULT_SELECTION);
  const bundle = useKeyedLoad(`${key}:preview:${JSON.stringify(selection)}`, () =>
    api().context.bundle({ target, ...selectionRequest(selection) }),
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="context-bundle-dialog"
      >
        <DialogHeader>
          <DialogTitle>Context preview</DialogTitle>
          <DialogDescription data-testid="context-bundle-summary">
            {bundle.value
              ? bundleSummary(bundle.value)
              : (bundle.error ?? 'Checking the repository…')}
          </DialogDescription>
        </DialogHeader>
        <SelectionFields value={selection} onChange={setSelection} />
        {bundle.value && (
          <Tabs defaultValue="records" className="min-w-0">
            <TabsList>
              <TabsTrigger value="records">Records</TabsTrigger>
              <TabsTrigger value="text">Text</TabsTrigger>
            </TabsList>
            <TabsContent value="records">
              <BundleRecords
                bundle={bundle.value}
                excludeIds={selection.excludeIds}
                onExcludeChange={(excludeIds) => setSelection({ ...selection, excludeIds })}
              />
            </TabsContent>
            <TabsContent value="text">
              <pre
                className="bg-muted/50 max-h-[60vh] overflow-auto rounded border p-3 font-mono text-xs whitespace-pre-wrap"
                data-testid="context-bundle"
              >
                {bundle.value.markdown}
              </pre>
            </TabsContent>
          </Tabs>
        )}
        {selection.excludeIds.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setSelection({ ...selection, excludeIds: [] })}
          >
            Include everything again
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
