import type { HttpSnapshot, HttpSnapshotSummary } from '@atlas/contracts';
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { languageOf, prettyJson, statusClass } from '../format';
import { MonacoDiff } from './MonacoText';

const headersText = (snapshot: HttpSnapshot) =>
  snapshot.headers
    .map(([name, value]) => `${name}: ${value}`)
    .sort((a, b) => a.localeCompare(b))
    .join('\n');

const bodyText = (snapshot: HttpSnapshot) =>
  snapshot.body === null
    ? '(binary body not saved)'
    : snapshot.bodyKind === 'json'
      ? prettyJson(snapshot.body)
      : snapshot.body;

function Comparison({ left, right }: { left: HttpSnapshot; right: HttpSnapshot }) {
  const language = left.bodyKind === right.bodyKind ? languageOf(left.bodyKind) : 'plaintext';
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="snapshot-comparison">
      <div className="grid grid-cols-2 gap-2 text-sm">
        {[left, right].map((snapshot) => (
          <p key={snapshot.id} className="flex min-w-0 items-center gap-2">
            <span className={cn('rounded px-1.5 font-mono text-xs', statusClass(snapshot.status))}>
              {snapshot.status} {snapshot.statusText}
            </span>
            <span className="truncate">{snapshot.name}</span>
          </p>
        ))}
      </div>
      {left.status !== right.status && (
        <p className="text-warning text-sm" data-testid="snapshot-status-changed">
          The status changed from {left.status} to {right.status}.
        </p>
      )}
      <Tabs defaultValue="body" className="min-h-0 flex-1">
        <TabsList>
          <TabsTrigger value="body">Body</TabsTrigger>
          <TabsTrigger value="headers">Headers</TabsTrigger>
        </TabsList>
        <TabsContent value="body" className="flex min-h-0 flex-col">
          <MonacoDiff
            original={bodyText(left)}
            modified={bodyText(right)}
            language={language}
            className="h-80"
          />
        </TabsContent>
        <TabsContent value="headers" className="flex min-h-0 flex-col">
          <MonacoDiff
            original={headersText(left)}
            modified={headersText(right)}
            language="plaintext"
            className="h-80"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface SnapshotsDialogProps {
  open: boolean;
  /** Saved responses of this request; every saved response when null. */
  requestId: string | null;
  onOpenChange: (open: boolean) => void;
}

/** Saved responses and a comparison of two of them (FR-1415). */
export function SnapshotsDialog(props: SnapshotsDialogProps) {
  // Mounted on each opening, so no choice from a previous opening remains.
  return props.open ? <SnapshotsContent {...props} /> : null;
}

function SnapshotsContent({ open, requestId, onOpenChange }: SnapshotsDialogProps) {
  const [list, setList] = useState<HttpSnapshotSummary[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [pair, setPair] = useState<[HttpSnapshot, HttpSnapshot] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await unwrap(api().http.snapshots({ requestId })));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [requestId]);

  useEffect(() => {
    void (async () => load())();
  }, [load]);

  const compare = async () => {
    try {
      // Oldest on the left.
      const [a, b] = await Promise.all(chosen.map((id) => unwrap(api().http.snapshot(id))));
      setPair(a!.createdAt <= b!.createdAt ? [a!, b!] : [b!, a!]);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] flex-col sm:max-w-4xl"
        data-testid="snapshots-dialog"
      >
        <DialogHeader>
          <DialogTitle>Saved responses</DialogTitle>
          <DialogDescription>
            Choose two to compare. Saved responses keep their body but never credentials or cookies.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-destructive text-sm">{error}</p>}
        {pair ? (
          <>
            <Comparison left={pair[0]} right={pair[1]} />
            <div>
              <Button size="sm" variant="outline" onClick={() => setPair(null)}>
                Back to the list
              </Button>
            </div>
          </>
        ) : (
          <>
            {list !== null && list.length === 0 && (
              <p className="text-muted-foreground text-sm">
                No saved responses yet. Use "Save response" after sending a request.
              </p>
            )}
            <ul className="min-h-0 flex-1 overflow-auto">
              {(list ?? []).map((snapshot) => (
                <li
                  key={snapshot.id}
                  className="flex items-center gap-2 border-b py-1.5 last:border-0"
                  data-testid="snapshot-row"
                >
                  <Checkbox
                    checked={chosen.includes(snapshot.id)}
                    disabled={!chosen.includes(snapshot.id) && chosen.length >= 2}
                    onCheckedChange={(checked) =>
                      setChosen((current) =>
                        checked === true
                          ? [...current, snapshot.id]
                          : current.filter((id) => id !== snapshot.id),
                      )
                    }
                    aria-label={`Compare ${snapshot.name}`}
                  />
                  <span
                    className={cn('rounded px-1.5 font-mono text-xs', statusClass(snapshot.status))}
                  >
                    {snapshot.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {snapshot.name}
                    <span className="text-muted-foreground block truncate font-mono text-xs">
                      {snapshot.method} {snapshot.url}
                    </span>
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {new Date(snapshot.createdAt).toLocaleString()}
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${snapshot.name}`}
                    onClick={async () => {
                      await unwrap(api().http.deleteSnapshot(snapshot.id)).catch(
                        (caught: unknown) => setError(errorMessage(caught)),
                      );
                      setChosen((current) => current.filter((id) => id !== snapshot.id));
                      await load();
                    }}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
            <div>
              <Button size="sm" disabled={chosen.length !== 2} onClick={() => void compare()}>
                Compare
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
