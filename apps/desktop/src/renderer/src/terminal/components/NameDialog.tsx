import { useId, useState, type FormEvent } from 'react';
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

interface NameDialogProps {
  title: string;
  description?: string;
  label: string;
  initialValue: string;
  submitLabel: string;
  maxLength: number;
  onSubmit: (value: string) => Promise<string | null>;
  onClose: () => void;
}

/** Asks for a name (create or rename). `onSubmit` resolves to an error message or null. */
export function NameDialog(props: NameDialogProps) {
  const fieldId = useId();
  const [value, setValue] = useState(props.initialValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim() === '') {
      setError('Name is required.');
      return;
    }
    setBusy(true);
    const failure = await props.onSubmit(value.trim());
    setBusy(false);
    if (failure === null) props.onClose();
    else setError(failure);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="name-dialog">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description && <DialogDescription>{props.description}</DialogDescription>}
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor={fieldId}>{props.label}</Label>
            <Input
              id={fieldId}
              autoFocus
              value={value}
              maxLength={props.maxLength}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${fieldId}-error` : undefined}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            />
            {error && (
              <p id={`${fieldId}-error`} className="text-destructive text-xs">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {props.submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
