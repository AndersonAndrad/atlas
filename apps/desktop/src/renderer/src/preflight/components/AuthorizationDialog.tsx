import type { PreflightAuthorizationReason, PreflightPlan } from '@atlas/contracts';
import { ShieldAlert } from 'lucide-react';
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

const REASONS: Record<PreflightAuthorizationReason, string> = {
  FIRST_RUN: 'First run',
  CHANGED: 'Changed since you authorized it',
  SIDE_EFFECTS: 'May change something outside this computer',
};

/**
 * Shows exactly what will run before checks that need authorization start (SDD-007 §13).
 * Authorizing covers these definitions only; a change asks again.
 */
export function AuthorizationDialog({
  plan,
  onAuthorize,
  onCancel,
}: {
  plan: PreflightPlan;
  onAuthorize: () => void;
  onCancel: () => void;
}) {
  const pending = plan.checks.filter((check) => check.authorization !== null);
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="preflight-authorize"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5" />
            Authorize {pending.length === 1 ? 'this check' : `${pending.length} checks`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            These checks run project code on this computer. Review what each one runs.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="grid gap-3">
          {pending.map((check) => (
            <li key={check.checkId} className="grid gap-1.5 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{check.name}</span>
                <Badge
                  variant="outline"
                  className={
                    check.authorization === 'SIDE_EFFECTS' ? 'text-destructive' : undefined
                  }
                >
                  {REASONS[check.authorization!]}
                </Badge>
              </div>
              <code className="bg-muted rounded px-2 py-1 text-xs break-all">
                {check.reference}
              </code>
              <ul className="text-muted-foreground list-disc pl-5 text-xs">
                {check.warnings.map((warning) => (
                  <li key={warning} className="break-words">
                    {warning}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onAuthorize}>Authorize and run</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
