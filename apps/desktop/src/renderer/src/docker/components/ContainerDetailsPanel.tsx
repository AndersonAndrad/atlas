import type { DockerContainerDetails, DockerContainerStats } from '@atlas/contracts';
import { X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, errorMessage, unwrap } from '@/api';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { LogViewer } from '@/preflight/components/LogViewer';
import { formatTime } from '@/preflight/format';
import {
  CONTAINER_STATE_LABELS,
  HEALTH_LABELS,
  containerStateClass,
  formatBytes,
  formatPort,
} from '../format';

/** Docker's usage reads take about two seconds; one read at a time, every few seconds. */
const STATS_INTERVAL_MS = 3000;

type Tab = 'overview' | 'logs' | 'usage';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Overview({ details }: { details: DockerContainerDetails }) {
  const { summary } = details;
  return (
    <dl
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm"
      data-testid="container-overview"
    >
      <Row label="ID">
        <span className="font-mono text-xs">{summary.id}</span>
      </Row>
      <Row label="Image">{summary.image}</Row>
      <Row label="Entrypoint">
        <code className="text-xs">{details.entrypoint?.join(' ') ?? 'Image default'}</code>
      </Row>
      <Row label="Command">
        <code className="text-xs">{details.command?.join(' ') ?? 'Image default'}</code>
      </Row>
      <Row label="User">
        {details.user === '' ? 'root (image default)' : details.user}
        {details.runsAsRoot && <span className="text-warning"> · runs as root</span>}
      </Row>
      {details.privileged && (
        <Row label="Privileged">
          <span className="text-destructive">Yes: full access to the host</span>
        </Row>
      )}
      <Row label="Restart policy">
        {details.restartPolicy.name}
        {details.restartCount > 0 ? ` · restarted ${details.restartCount}×` : ''}
      </Row>
      <Row label="Ports">
        {summary.ports.length === 0 ? 'None' : summary.ports.map(formatPort).join(', ')}
      </Row>
      <Row label="Mounts">
        {details.mounts.length === 0 ? (
          'None'
        ) : (
          <ul>
            {details.mounts.map((mount) => (
              <li key={`${mount.source}:${mount.destination}`}>
                {mount.type} {mount.source} → {mount.destination}
                {mount.readOnly ? ' (read-only)' : ''}
              </li>
            ))}
          </ul>
        )}
      </Row>
      <Row label="Networks">
        {details.networks.length === 0
          ? details.networkMode
          : details.networks
              .map(
                (network) => `${network.name}${network.ipAddress ? ` (${network.ipAddress})` : ''}`,
              )
              .join(', ')}
      </Row>
      <Row label="Health check">
        {details.healthcheck === null
          ? 'None'
          : `${details.healthcheck.test.join(' ')}${
              details.healthcheck.intervalSeconds
                ? ` · every ${details.healthcheck.intervalSeconds} s`
                : ''
            }`}
        {details.healthLog.length > 0 && (
          <span className="text-muted-foreground block text-xs">
            Last results: {details.healthLog.map((entry) => entry.exitCode).join(', ')}
          </span>
        )}
      </Row>
      <Row label="Limits">
        Memory {formatBytes(details.limits.memoryBytes)} · CPUs {details.limits.cpus ?? 'no limit'}
        {details.limits.pidsLimit ? ` · ${details.limits.pidsLimit} processes` : ''}
      </Row>
      <Row label="Created">{formatTime(summary.createdAt)}</Row>
      <Row label="Started">{formatTime(details.startedAt)}</Row>
      {details.finishedAt && <Row label="Finished">{formatTime(details.finishedAt)}</Row>}
      {details.exitCode !== null && (
        <Row label="Exit code">
          {details.exitCode}
          {details.oomKilled ? ' · stopped for lack of memory' : ''}
        </Row>
      )}
      {details.error && <Row label="Error">{details.error}</Row>}
      <Row label="Environment">
        {details.envNames.length === 0 ? (
          'None'
        ) : (
          <>
            <span className="font-mono text-xs">{details.envNames.join(', ')}</span>
            <span className="text-muted-foreground block text-xs">
              Values are not shown: they may hold secrets.
            </span>
          </>
        )}
      </Row>
    </dl>
  );
}

function Usage({ context, containerId }: { context: string; containerId: string }) {
  const [stats, setStats] = useState<DockerContainerStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only while shown and the window is visible (FR-1309).
    const read = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const next = await unwrap(api().docker.stats({ context, containerId }));
          if (!cancelled) {
            setStats(next);
            setError(null);
          }
        } catch (caught) {
          if (!cancelled) setError(errorMessage(caught));
        }
      }
      if (!cancelled) timer = setTimeout(() => void read(), STATS_INTERVAL_MS);
    };
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [context, containerId]);

  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (stats === null) return <p className="text-muted-foreground text-sm">Reading usage…</p>;
  const value = (text: string | number | null, suffix = '') =>
    text === null ? 'Not reported' : `${text}${suffix}`;
  return (
    <dl
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm"
      data-testid="container-usage"
    >
      <Row label="CPU">{value(stats.cpuPercent, ' %')}</Row>
      <Row label="Memory">
        {value(stats.memoryUsage)}
        {stats.memoryLimit ? ` of ${stats.memoryLimit}` : ''}
        {stats.memoryPercent !== null ? ` (${stats.memoryPercent} %)` : ''}
      </Row>
      <Row label="Network I/O">{value(stats.networkIO)}</Row>
      <Row label="Block I/O">{value(stats.blockIO)}</Row>
      <Row label="Processes">{value(stats.pids)}</Row>
      <Row label="Read at">{formatTime(stats.at)}</Row>
    </dl>
  );
}

function Logs({ context, containerId }: { context: string; containerId: string }) {
  const [session, setSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: string | null = null;
    unwrap(api().docker.logsOpen({ context, containerId, tail: 500 })).then(
      (id) => {
        opened = id;
        if (cancelled) void api().docker.logsClose(id);
        else setSession(id);
      },
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    );
    // Closing the panel stops the stream (§17).
    return () => {
      cancelled = true;
      if (opened !== null) void api().docker.logsClose(opened);
    };
  }, [context, containerId]);

  const load = useCallback(
    (after: number) => unwrap(api().docker.logsRead({ sessionId: session!, after })),
    [session],
  );
  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (session === null) return <p className="text-muted-foreground text-sm">Opening logs…</p>;
  return (
    <LogViewer
      key={session}
      runId={session}
      position={0}
      load={load}
      label="Container logs"
      testId="container-logs"
    />
  );
}

/** Details, logs and usage of one container (FR-1306, FR-1307, FR-1309). */
export function ContainerDetailsPanel({
  context,
  containerId,
  refreshKey,
  initialTab = 'overview',
  onClose,
  onMissing,
}: {
  context: string;
  containerId: string;
  /** Changes when Docker reported a change of this container. */
  refreshKey: number;
  initialTab?: Tab;
  onClose: () => void;
  onMissing: () => void;
}) {
  const [details, setDetails] = useState<DockerContainerDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    let cancelled = false;
    unwrap(api().docker.container({ context, containerId })).then(
      (next) => {
        if (cancelled) return;
        setDetails(next);
        setError(null);
      },
      (caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.code === 'DOCKER_CONTAINER_NOT_FOUND') onMissing();
        else setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [context, containerId, refreshKey, onMissing]);

  const running = details?.summary.state === 'running';
  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-md border p-3"
      aria-labelledby="container-details-title"
      data-testid="container-details"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id="container-details-title" className="truncate font-semibold">
            {details?.summary.name ?? containerId.slice(0, 12)}
          </h2>
          {details && (
            <p className="text-xs">
              <span className={cn('font-medium', containerStateClass(details.summary.state))}>
                {CONTAINER_STATE_LABELS[details.summary.state]}
              </span>
              {HEALTH_LABELS[details.summary.health] && (
                <span className="text-muted-foreground">
                  {' '}
                  · {HEALTH_LABELS[details.summary.health]}
                </span>
              )}
              <span className="text-muted-foreground"> · {details.summary.status}</span>
            </p>
          )}
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close container details"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      {details && (
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="usage" disabled={!running}>
              Usage
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <Overview details={details} />
          </TabsContent>
          <TabsContent value="logs">
            {tab === 'logs' && <Logs context={context} containerId={details.summary.id} />}
          </TabsContent>
          <TabsContent value="usage">
            {tab === 'usage' && running && (
              <Usage context={context} containerId={details.summary.id} />
            )}
          </TabsContent>
        </Tabs>
      )}
    </section>
  );
}
