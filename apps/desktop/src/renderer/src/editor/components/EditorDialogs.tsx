import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { fileName, parentPath } from '../state/tabs';
import { FileIcon } from './FileIcon';

interface UnsavedDialogProps {
  /** Files with unsaved changes the action would discard. */
  paths: string[];
  /** e.g. "Close" or "Switch project". */
  action: string;
  onSave: () => Promise<void>;
  onDiscard: () => void;
  onCancel: () => void;
}

/** Save, discard or cancel before unsaved changes would be lost (FR-1105). */
export function UnsavedDialog({ paths, action, onSave, onDiscard, onCancel }: UnsavedDialogProps) {
  const [busy, setBusy] = useState(false);
  const single = paths.length === 1;
  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <AlertDialogContent data-testid="unsaved-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {single
              ? `Save changes to ${fileName(paths[0]!)}?`
              : `Save changes to ${paths.length} files?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Your changes are lost if you don&apos;t save them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!single && (
          <ul className="text-muted-foreground max-h-40 overflow-y-auto font-mono text-xs">
            {paths.map((path) => (
              <li key={path} className="truncate">
                {path}
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="outline" disabled={busy} onClick={onDiscard}>
            {`Don't save`}
          </Button>
          <Button
            autoFocus
            disabled={busy}
            onClick={async () => {
              // The caller closes the dialog when everything was saved.
              setBusy(true);
              await onSave();
              setBusy(false);
            }}
          >
            {single ? 'Save' : 'Save all'}
            <span className="sr-only">{` and ${action.toLowerCase()}`}</span>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}

/** Confirms an action; `onConfirm` resolves to an error message or null. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <AlertDialogContent data-testid="confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">{props.title}</AlertDialogTitle>
          <AlertDialogDescription className="wrap-anywhere">
            {props.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} autoFocus>
            Cancel
          </AlertDialogCancel>
          <Button
            variant={props.destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const failure = await props.onConfirm();
              setBusy(false);
              if (failure === null) props.onClose();
              else setError(failure);
            }}
          >
            {props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface QuickOpenDialogProps {
  projectId: string;
  onOpen: (path: string) => void;
  onClose: () => void;
}

/** Opens a project file by name (Cmd/Ctrl+P), searched by the Engine (FR-1101). */
export function QuickOpenDialog({ projectId, onOpen, onClose }: QuickOpenDialogProps) {
  const inputId = useId();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ paths: string[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const request = useRef(0);

  useEffect(() => {
    const id = ++request.current;
    const timer = setTimeout(() => {
      unwrap(api().projectFiles.find({ projectId, query, limit: 50 })).then(
        (found) => {
          if (id !== request.current) return;
          setResult(found);
          setSelected(0);
          setError(null);
        },
        (caught: unknown) => id === request.current && setError(errorMessage(caught)),
      );
    }, 80);
    return () => clearTimeout(timer);
  }, [projectId, query]);

  const paths = result?.paths ?? [];
  const choose = (path: string | undefined) => {
    if (path === undefined) return;
    onOpen(path);
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((index) => Math.min(paths.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(paths[selected]);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="top-[15%] translate-y-0 gap-2 p-3 sm:max-w-xl"
        data-testid="quick-open"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Open file</DialogTitle>
          <DialogDescription>Type part of a file name or path.</DialogDescription>
        </DialogHeader>
        <Input
          id={inputId}
          autoFocus
          value={query}
          placeholder="Search files by name"
          aria-label="Search files by name"
          aria-controls={`${inputId}-results`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {error && <p className="text-destructive text-xs">{error}</p>}
        <ul
          id={`${inputId}-results`}
          role="listbox"
          aria-label="Files"
          className="max-h-80 overflow-y-auto"
        >
          {paths.map((path, index) => (
            <li
              key={path}
              role="option"
              aria-selected={index === selected}
              className={cn(
                'flex cursor-default items-center gap-2 rounded px-2 py-1 text-sm',
                index === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(path)}
            >
              <FileIcon name={fileName(path)} kind="file" />
              <span className="truncate">{fileName(path)}</span>
              <span className="text-muted-foreground truncate text-xs">{parentPath(path)}</span>
            </li>
          ))}
          {result !== null && paths.length === 0 && (
            <li className="text-muted-foreground px-2 py-1 text-sm">No matching files.</li>
          )}
        </ul>
        {result?.truncated && (
          <p className="text-muted-foreground text-[11px]">
            The project has more files than were searched; type more of the name.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
