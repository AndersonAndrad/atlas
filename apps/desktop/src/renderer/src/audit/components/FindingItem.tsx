import { AUDIT_CATEGORY_LABELS, type AuditFinding } from '@atlas/contracts';
import { FileCode } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { openInEditor } from '@/editor/navigation';
import { LOCATION_LABELS, SEVERITY_CLASSES, VALIDATION_LABELS } from './audit-labels';

/** One finding; `leading` (a checkbox) and `footer` (its decision and actions) are optional. */
export function FindingItem({
  finding,
  leading,
  footer,
}: {
  finding: AuditFinding;
  leading?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 gap-2 rounded-md border p-3" data-testid="audit-finding">
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <details>
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
            <Badge
              variant="outline"
              className={SEVERITY_CLASSES[finding.severity]}
              data-testid="audit-finding-severity"
            >
              {finding.severity}
            </Badge>
            <span className="min-w-0 flex-1 font-medium break-words">{finding.title}</span>
            <Badge variant="outline" data-testid="audit-finding-validation">
              {VALIDATION_LABELS[finding.validation]}
            </Badge>
          </summary>
          <div className="mt-3 flex min-w-0 flex-col gap-2 text-sm">
            <p className="text-muted-foreground text-xs">
              {AUDIT_CATEGORY_LABELS[finding.category]} ·{' '}
              {finding.kind === 'hypothesis' ? 'Hypothesis (not confirmed)' : 'Observation'} ·{' '}
              {finding.confidence.toLowerCase()} confidence
              {finding.effort ? ` · ${finding.effort} effort` : ''}
            </p>
            {finding.validationNotes.length > 0 && (
              <ul className="text-warning list-disc pl-5 text-xs" aria-label="Validation notes">
                {finding.validationNotes.map((note) => (
                  <li key={note} className="break-words">
                    {note}
                  </li>
                ))}
              </ul>
            )}
            {finding.containsCommands && (
              <p className="text-muted-foreground text-xs" data-testid="audit-finding-commands">
                This finding mentions shell commands. They are shown as text; ATLAS never runs them.
              </p>
            )}
            <Field label="Description" value={finding.description} />
            <Field label="Evidence" value={finding.evidence} />
            {finding.excerpt && (
              <pre className="bg-muted/50 max-h-48 overflow-auto rounded border p-2 font-mono text-xs whitespace-pre-wrap">
                {finding.excerpt}
              </pre>
            )}
            {finding.locations.length > 0 && (
              <ul className="flex flex-col gap-1" aria-label="Locations">
                {finding.locations.map((location, index) => {
                  const openable =
                    location.status === 'located' || location.status === 'line-out-of-range';
                  const lines =
                    location.startLine === null
                      ? ''
                      : `:${location.startLine}${location.endLine && location.endLine !== location.startLine ? `-${location.endLine}` : ''}`;
                  return (
                    <li key={index} className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-mono text-xs break-all">
                        {location.path}
                        {lines}
                      </span>
                      {location.symbol && (
                        <span className="text-muted-foreground text-xs">{location.symbol}</span>
                      )}
                      <span className="text-muted-foreground text-xs">
                        ({LOCATION_LABELS[location.status]})
                      </span>
                      {openable && (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() =>
                            openInEditor({
                              projectId: finding.projectId,
                              path: location.path,
                              ...(location.startLine === null ? {} : { line: location.startLine }),
                            })
                          }
                          data-testid="audit-finding-open"
                        >
                          <FileCode />
                          Open
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <Field label="Impact" value={finding.impact} />
            <Field label="Recommendation" value={finding.recommendation} />
            <Field label="Suggested task" value={finding.suggestedTaskTitle} />
            {finding.acceptanceCriteria.length > 0 && (
              <div>
                <span className="text-muted-foreground text-xs">Acceptance criteria</span>
                <ul className="list-disc pl-5">
                  {finding.acceptanceCriteria.map((criterion) => (
                    <li key={criterion} className="break-words">
                      {criterion}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
        {footer}
      </div>
    </li>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="text-muted-foreground text-xs">{label}</span>
      <p className="break-words whitespace-pre-wrap">{value}</p>
    </div>
  );
}
