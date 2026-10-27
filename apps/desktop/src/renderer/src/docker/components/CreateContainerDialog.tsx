import {
  CreateContainerSchema,
  RESTART_POLICIES,
  splitCommandLine,
  type CreateContainerInput,
  type DockerContainerSummary,
} from '@atlas/contracts';
import { Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface PortRow {
  key: number;
  hostPort: string;
  containerPort: string;
  network: boolean;
}
interface PairRow {
  key: number;
  first: string;
  second: string;
  readOnly: boolean;
}

let rowKey = 0;
const newPort = (): PortRow => ({ key: ++rowKey, hostPort: '', containerPort: '', network: false });
const newPair = (): PairRow => ({ key: ++rowKey, first: '', second: '', readOnly: false });

/** "Rows" of a repeatable field: add, edit and remove. */
function Rows<T extends { key: number }>({
  label,
  rows,
  onChange,
  create,
  render,
}: {
  label: string;
  rows: T[];
  onChange: (rows: T[]) => void;
  create: () => T;
  render: (row: T, update: (patch: Partial<T>) => void) => React.ReactNode;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {rows.map((row) => (
        <div key={row.key} className="flex min-w-0 flex-wrap items-center gap-2">
          {render(row, (patch) =>
            onChange(rows.map((item) => (item.key === row.key ? { ...item, ...patch } : item))),
          )}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove from ${label.toLowerCase()}`}
            onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => onChange([...rows, create()])}
      >
        <Plus />
        Add {label.toLowerCase().replace(/s$/, '')}
      </Button>
    </fieldset>
  );
}

const toPort = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value) : Number.NaN);

/**
 * Creates a container from a local image (SDD-013 FR-1310). Nothing risky is on by
 * default: ports stay on this computer and privileged mode is not offered. The Engine
 * decides which options need a confirmation and lists why.
 */
export function CreateContainerDialog({
  context,
  onClose,
  onCreated,
}: {
  context: string;
  onClose: () => void;
  onCreated: (container: DockerContainerSummary) => void;
}) {
  const [image, setImage] = useState('');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [network, setNetwork] = useState('');
  const [restart, setRestart] = useState<(typeof RESTART_POLICIES)[number]>('no');
  const [start, setStart] = useState(true);
  const [ports, setPorts] = useState<PortRow[]>([]);
  const [env, setEnv] = useState<PairRow[]>([]);
  const [binds, setBinds] = useState<PairRow[]>([]);
  const [volumes, setVolumes] = useState<PairRow[]>([]);
  const [risks, setRisks] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  function input(): CreateContainerInput {
    return {
      context,
      image,
      ...(name.trim() ? { name } : {}),
      command: splitCommandLine(command),
      ports: ports.map((port) => ({
        hostIp: port.network ? '0.0.0.0' : '127.0.0.1',
        hostPort: port.hostPort.trim() === '' ? null : toPort(port.hostPort),
        containerPort: toPort(port.containerPort),
      })),
      env: env.map((row) => ({ name: row.first.trim(), value: row.second })),
      binds: binds.map((row) => ({
        source: row.first,
        target: row.second,
        readOnly: row.readOnly,
      })),
      volumes: volumes.map((row) => ({
        name: row.first,
        target: row.second,
        readOnly: row.readOnly,
      })),
      ...(network.trim() ? { network } : {}),
      restartPolicy: restart,
      start,
      confirmRisks: confirmed,
    };
  }

  /** Any change asks for a new confirmation of what the Engine reported. */
  const changed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setRisks([]);
      setConfirmed(false);
    };

  async function submit() {
    const parsed = CreateContainerSchema.safeParse(input());
    if (!parsed.success) {
      setIssues([
        ...new Set(
          parsed.error.issues.map((issue) =>
            issue.path.length > 0 ? `${issue.path.join(' ')}: ${issue.message}` : issue.message,
          ),
        ),
      ]);
      return;
    }
    setBusy(true);
    setIssues([]);
    try {
      onCreated(await unwrap(api().docker.create(parsed.data)));
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'DOCKER_CONFIRMATION_REQUIRED') {
        setRisks(caught.issues.map((issue) => issue.message));
        setConfirmed(false);
      } else if (caught instanceof ApiError && caught.issues.length > 0) {
        setIssues(caught.issues.map((issue) => issue.message));
      } else {
        setIssues([errorMessage(caught)]);
      }
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        data-testid="create-container"
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
      >
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
        >
          <DialogHeader>
            <DialogTitle>New container</DialogTitle>
            <DialogDescription>
              From an image already on this Docker engine ({context}). Images are not downloaded
              here.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="container-image">Image</Label>
              <Input
                id="container-image"
                value={image}
                onChange={(event) => changed(setImage)(event.target.value)}
                placeholder="redis:7"
                autoFocus
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="container-name">Name (optional)</Label>
              <Input
                id="container-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="cache"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="container-command">Command (optional)</Label>
            <Input
              id="container-command"
              className="font-mono"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="redis-server --appendonly yes"
            />
            <p className="text-muted-foreground text-xs">
              Arguments after the image. Quotes group words; nothing is expanded.
            </p>
          </div>
          <Rows
            label="Ports"
            rows={ports}
            onChange={changed(setPorts)}
            create={newPort}
            render={(row, update) => (
              <>
                <Input
                  className="w-28"
                  inputMode="numeric"
                  aria-label="Host port"
                  placeholder="Host (any)"
                  value={row.hostPort}
                  onChange={(event) => update({ hostPort: event.target.value.replace(/\D/g, '') })}
                />
                <span aria-hidden="true">→</span>
                <Input
                  className="w-28"
                  inputMode="numeric"
                  aria-label="Container port"
                  placeholder="Container"
                  value={row.containerPort}
                  onChange={(event) =>
                    update({ containerPort: event.target.value.replace(/\D/g, '') })
                  }
                />
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={row.network}
                    onCheckedChange={(value) => update({ network: value === true })}
                  />
                  Open to the network
                </label>
              </>
            )}
          />
          <Rows
            label="Environment variables"
            rows={env}
            onChange={setEnv}
            create={newPair}
            render={(row, update) => (
              <>
                <Input
                  className="w-44 font-mono"
                  aria-label="Variable name"
                  placeholder="NAME"
                  value={row.first}
                  onChange={(event) => update({ first: event.target.value })}
                />
                <Input
                  className="min-w-40 flex-1 font-mono"
                  type="password"
                  aria-label="Variable value"
                  placeholder="value"
                  value={row.second}
                  onChange={(event) => update({ second: event.target.value })}
                />
              </>
            )}
          />
          <Rows
            label="Folders from this computer"
            rows={binds}
            onChange={changed(setBinds)}
            create={newPair}
            render={(row, update) => (
              <>
                <Input
                  className="min-w-40 flex-1"
                  aria-label="Folder on this computer"
                  placeholder="/Users/me/project"
                  value={row.first}
                  onChange={(event) => update({ first: event.target.value })}
                />
                <Input
                  className="min-w-32 flex-1"
                  aria-label="Path in the container"
                  placeholder="/app"
                  value={row.second}
                  onChange={(event) => update({ second: event.target.value })}
                />
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={row.readOnly}
                    onCheckedChange={(value) => update({ readOnly: value === true })}
                  />
                  Read-only
                </label>
              </>
            )}
          />
          <Rows
            label="Volumes"
            rows={volumes}
            onChange={setVolumes}
            create={newPair}
            render={(row, update) => (
              <>
                <Input
                  className="min-w-32 flex-1"
                  aria-label="Volume name"
                  placeholder="data"
                  value={row.first}
                  onChange={(event) => update({ first: event.target.value })}
                />
                <Input
                  className="min-w-32 flex-1"
                  aria-label="Volume path in the container"
                  placeholder="/data"
                  value={row.second}
                  onChange={(event) => update({ second: event.target.value })}
                />
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={row.readOnly}
                    onCheckedChange={(value) => update({ readOnly: value === true })}
                  />
                  Read-only
                </label>
              </>
            )}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="container-network">Network (optional)</Label>
              <Input
                id="container-network"
                value={network}
                onChange={(event) => changed(setNetwork)(event.target.value)}
                placeholder="bridge"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="container-restart">Restart policy</Label>
              <Select
                value={restart}
                onValueChange={(value) => setRestart(value as typeof restart)}
              >
                <SelectTrigger id="container-restart" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESTART_POLICIES.map((policy) => (
                    <SelectItem key={policy} value={policy}>
                      {policy}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={start} onCheckedChange={(value) => setStart(value === true)} />
            Start it after creating
          </label>
          {risks.length > 0 && (
            <Alert variant="destructive" data-testid="container-risks">
              <TriangleAlert />
              <AlertTitle>Review this configuration</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {risks.map((risk) => (
                    <li key={risk}>It {risk}.</li>
                  ))}
                </ul>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={confirmed}
                    onCheckedChange={(value) => setConfirmed(value === true)}
                  />
                  I understand; create it anyway
                </label>
              </AlertDescription>
            </Alert>
          )}
          {issues.length > 0 && (
            <ul className="text-destructive list-disc pl-4 text-sm" role="alert">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (risks.length > 0 && !confirmed)}>
              Create container
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
