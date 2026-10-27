import { isSensitiveName } from '@atlas/contracts';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface KeyValueRow {
  name: string;
  /** Null only for a query parameter written without `=` (FR-1403). */
  value: string | null;
  enabled: boolean;
  secret: boolean;
}

interface KeyValueEditorProps<T extends KeyValueRow> {
  rows: T[];
  onChange: (rows: T[]) => void;
  /** E.g. "header"; used in labels. */
  noun: string;
  create: () => T;
  testId: string;
  /** Values that cannot hold line breaks or are otherwise checked, with a message. */
  validateName?: (name: string) => string | null;
}

/**
 * Rows of names and values with on/off and secret switches (FR-1403, FR-1404). Secret
 * values, and those of names that usually carry credentials, are never saved.
 */
export function KeyValueEditor<T extends KeyValueRow>({
  rows,
  onChange,
  noun,
  create,
  testId,
  validateName,
}: KeyValueEditorProps<T>) {
  const update = (index: number, change: Partial<KeyValueRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      {rows.length === 0 && (
        <p className="text-muted-foreground text-sm">No {noun}s. Add one to send it.</p>
      )}
      {rows.map((row, index) => {
        const forced = isSensitiveName(row.name);
        const secret = row.secret || forced;
        const nameError = validateName?.(row.name) ?? null;
        return (
          <div
            // Rows have no identity of their own; their order is their identity.
            key={index}
            className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] items-center gap-1.5"
            data-testid={`${testId}-row`}
          >
            <Checkbox
              checked={row.enabled}
              onCheckedChange={(checked) => update(index, { enabled: checked === true })}
              aria-label={`Send this ${noun}`}
            />
            <Input
              value={row.name}
              onChange={(event) => update(index, { name: event.target.value })}
              placeholder="Name"
              aria-label={`${noun} name`}
              aria-invalid={nameError !== null}
              title={nameError ?? undefined}
              className={cn('h-8 font-mono text-xs', !row.enabled && 'opacity-60')}
            />
            <Input
              value={row.value ?? ''}
              type={secret ? 'password' : 'text'}
              autoComplete="off"
              onChange={(event) => update(index, { value: event.target.value })}
              placeholder={
                secret ? 'Secret: enter it each session' : row.value === null ? 'No value' : 'Value'
              }
              aria-label={`${noun} value`}
              className={cn('h-8 font-mono text-xs', !row.enabled && 'opacity-60')}
            />
            <Button
              size="icon-sm"
              variant={secret ? 'secondary' : 'ghost'}
              aria-pressed={secret}
              aria-label={
                forced
                  ? `${row.name} is always secret`
                  : secret
                    ? `Stop treating this ${noun} as secret`
                    : `Treat this ${noun} as secret`
              }
              title={
                forced
                  ? 'Values of this name are never saved.'
                  : 'Secret values are never saved, logged or kept in history.'
              }
              disabled={forced}
              onClick={() => update(index, { secret: !row.secret })}
            >
              <KeyRound className={cn(secret ? 'text-warning' : 'text-muted-foreground')} />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${noun} ${row.name || index + 1}`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <Trash2 />
            </Button>
            {nameError !== null && (
              <p className="text-destructive col-span-5 text-xs" role="alert">
                {nameError}
              </p>
            )}
          </div>
        );
      })}
      <div>
        <Button size="sm" variant="outline" onClick={() => onChange([...rows, create()])}>
          <Plus /> Add {noun}
        </Button>
      </div>
    </div>
  );
}
