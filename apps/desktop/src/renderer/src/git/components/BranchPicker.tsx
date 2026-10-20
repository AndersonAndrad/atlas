import { Check, Search } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { filterBranches } from '../format';

export interface BranchGroup {
  label: string;
  names: string[];
}

interface BranchPickerProps {
  groups: BranchGroup[];
  value: string | null;
  onChange: (name: string) => void;
  label: string;
  disabled?: boolean;
}

/**
 * Searchable branch list for long repositories: type part of a name, move with the
 * arrow keys and choose with Enter or a click.
 */
export function BranchPicker({
  groups,
  value,
  onChange,
  label,
  disabled = false,
}: BranchPickerProps) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);

  const shown = groups
    .map((group) => ({
      label: group.label,
      names: filterBranches(
        group.names.map((name) => ({ name })),
        query,
      ).map((item) => item.name),
    }))
    .filter((group) => group.names.length > 0);
  const flat = shown.flatMap((group) => group.names);
  const active = Math.min(highlighted, Math.max(flat.length - 1, 0));
  const optionId = (index: number) => `${id}-option-${index}`;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (flat.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = (active + delta + flat.length) % flat.length;
      setHighlighted(next);
      document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const name = flat[active];
      if (name !== undefined) onChange(name);
    }
  };

  // Position of each group's first option in `flat`.
  const offsets = shown.map((_, groupIndex) =>
    shown.slice(0, groupIndex).reduce((total, group) => total + group.names.length, 0),
  );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="relative">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          autoFocus
          type="search"
          role="combobox"
          aria-label={label}
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={flat.length > 0 ? optionId(active) : undefined}
          aria-autocomplete="list"
          placeholder="Search branches"
          className="pl-8"
          value={query}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlighted(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label={label}
        className="max-h-56 overflow-y-auto rounded-md border p-1"
        data-testid="branch-picker"
      >
        {flat.length === 0 && (
          <p className="text-muted-foreground p-2 text-sm" role="status">
            {query.trim() === '' ? 'No other branches.' : `No branch matches “${query.trim()}”.`}
          </p>
        )}
        {shown.map((group, groupIndex) => (
          <div key={group.label} role="group" aria-label={group.label}>
            <div className="text-muted-foreground px-2 pt-1 pb-0.5 text-[11px] font-semibold tracking-wider uppercase">
              {group.label}
            </div>
            {group.names.map((name, nameIndex) => {
              const position = offsets[groupIndex]! + nameIndex;
              const selected = name === value;
              return (
                <div
                  key={name}
                  id={optionId(position)}
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    'flex cursor-default items-center gap-2 rounded-sm px-2 py-1 font-mono text-xs',
                    position === active && 'bg-accent text-accent-foreground',
                    disabled && 'pointer-events-none opacity-50',
                  )}
                  onMouseMove={() => setHighlighted(position)}
                  onClick={() => onChange(name)}
                >
                  <Check
                    className={cn('size-3.5 shrink-0', !selected && 'invisible')}
                    aria-hidden="true"
                  />
                  <span className="truncate">{name}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
