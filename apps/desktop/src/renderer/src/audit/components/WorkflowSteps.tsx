import type { ProjectWorkflowSummary } from '@atlas/contracts';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { useKeyedLoad } from '@/context/hooks/useContextData';
import { cn } from '@/lib/utils';
import { onTerminalLifecycle } from '@/terminal/state/terminal-events';
import { workflowSteps, type WorkflowTarget } from './workflow-steps';

interface WorkflowStepsProps {
  projectId: string;
  onNavigate: (target: WorkflowTarget) => void;
}

/**
 * Analyze → Review findings → Tasks → Execute with ATLAS → Review result: where the
 * project is and the next thing to do, kept current by audit, task and team events.
 */
export function WorkflowSteps({ projectId, onNavigate }: WorkflowStepsProps) {
  const [version, setVersion] = useState(0);
  const summary = useKeyedLoad(`workflow:${projectId}:${version}`, () =>
    api().audit.workflow(projectId),
  );
  useEffect(
    () =>
      onTerminalLifecycle((event) => {
        if (
          event.type === 'audit' ||
          event.type === 'team-execution' ||
          event.type === 'task-execution'
        ) {
          setVersion((value) => value + 1);
        }
      }),
    [],
  );
  // Keeps the last value while reloading, so the steps do not flicker.
  const [last, setLast] = useState<ProjectWorkflowSummary | null>(null);
  if (summary.value !== null && summary.value !== last) setLast(summary.value);
  const { steps, current } = workflowSteps(
    summary.value ?? (last?.projectId === projectId ? last : null),
  );

  return (
    <nav
      aria-label="Workflow"
      className="flex shrink-0 gap-2 overflow-x-auto border-b px-4 py-2"
      data-testid="workflow-steps"
    >
      <ol className="flex min-w-max gap-2">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className={cn(
              'flex min-w-40 flex-col gap-1 rounded-md border p-2 text-xs',
              index === current && 'border-sidebar-primary bg-accent/40',
            )}
            aria-current={index === current ? 'step' : undefined}
            data-testid="workflow-step"
          >
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full border text-[11px]',
                  step.done &&
                    'bg-sidebar-primary text-sidebar-primary-foreground border-transparent',
                )}
                aria-hidden
              >
                {step.done ? <Check className="size-3" /> : index + 1}
              </span>
              {step.title}
            </span>
            <span className="text-muted-foreground">{step.status}</span>
            {step.action && (
              <Button
                size="xs"
                variant={index === current ? 'default' : 'outline'}
                className="self-start"
                onClick={() => onNavigate(step.action!.target)}
              >
                {step.action.label}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
