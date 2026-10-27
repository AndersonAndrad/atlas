import type { HttpBodyPage, HttpCookie, HttpExecutionResult } from '@atlas/contracts';
import { Camera, Download, GitCompare, Search, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage, unwrap } from '@/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { formatBytes, formatMs, languageOf, prettyJson, statusClass } from '../format';
import type { ResponseState } from '../useWorkbench';
import { MonacoText } from './MonacoText';

/** Text kept in the window at most; the rest is for Download (§19). */
const MAX_SHOWN_BYTES = 16 * 1024 * 1024;

function ResponseBody({ result }: { result: HttpExecutionResult }) {
  const [page, setPage] = useState<HttpBodyPage | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pretty, setPretty] = useState(true);
  const [find, setFind] = useState(0);
  const textual = result.bodyKind !== 'binary' && result.bodyKind !== 'empty';

  const load = useCallback(
    async (offset: number) => {
      try {
        const next = await unwrap(api().http.readBody({ executionId: result.executionId, offset }));
        setPage(next);
        setText((current) => (offset === 0 ? next.text : current + next.text));
        setError(null);
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [result.executionId],
  );

  useEffect(() => {
    if (textual) void (async () => load(0))();
  }, [textual, load]);

  const canPretty = result.bodyKind === 'json' && page !== null && page.complete;
  // Formatting a large body on every render would slow typing in the request editor.
  const shown = useMemo(
    () => (canPretty && pretty ? prettyJson(text) : text),
    [canPretty, pretty, text],
  );

  if (result.bodyKind === 'empty') {
    return <p className="text-muted-foreground text-sm">The response has no body.</p>;
  }
  if (result.bodyKind === 'binary') {
    return (
      <p className="text-muted-foreground text-sm" data-testid="response-binary">
        Binary content ({result.contentType ?? 'unknown type'}, {formatBytes(result.bodyBytes)}).
        Download it to open it with another application.
      </p>
    );
  }
  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (page === null) return <p className="text-muted-foreground text-sm">Loading…</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {canPretty && (
          <div className="flex rounded-md border p-0.5" role="group" aria-label="Body format">
            {(['Pretty', 'Raw'] as const).map((label) => (
              <Button
                key={label}
                size="xs"
                variant={(label === 'Pretty') === pretty ? 'secondary' : 'ghost'}
                aria-pressed={(label === 'Pretty') === pretty}
                onClick={() => setPretty(label === 'Pretty')}
              >
                {label}
              </Button>
            ))}
          </div>
        )}
        <Button size="xs" variant="ghost" onClick={() => setFind((n) => n + 1)}>
          <Search /> Find
        </Button>
        {!page.complete && (
          <span className="text-muted-foreground text-xs">
            Showing {formatBytes(page.nextOffset)} of {formatBytes(page.totalBytes)}.
            {page.nextOffset < MAX_SHOWN_BYTES ? (
              <Button size="xs" variant="link" onClick={() => void load(page.nextOffset)}>
                Load more
              </Button>
            ) : (
              ' Download the response to see the rest.'
            )}
          </span>
        )}
      </div>
      {/* Returned HTML and scripts are shown as source, never run (FR-1411). */}
      <MonacoText
        value={shown}
        language={languageOf(result.bodyKind)}
        readOnly
        ariaLabel="Response body"
        className="min-h-40 flex-1"
        testId="response-body"
        findRequest={find}
      />
    </div>
  );
}

function HeaderTable({ headers, testId }: { headers: [string, string][]; testId: string }) {
  if (headers.length === 0) return <p className="text-muted-foreground text-sm">No headers.</p>;
  return (
    <table className="w-full table-fixed text-left text-xs" data-testid={testId}>
      <tbody>
        {headers.map(([name, value], index) => (
          <tr key={index} className="border-b last:border-0">
            <th scope="row" className="w-1/3 py-1 pr-2 align-top font-mono font-medium break-all">
              {name}
            </th>
            <td className="py-1 font-mono break-all">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CookieList({ cookies, empty }: { cookies: HttpCookie[]; empty: string }) {
  if (cookies.length === 0) return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {cookies.map((cookie, index) => (
        <li
          key={`${cookie.domain}${cookie.path}${cookie.name}${index}`}
          className="rounded border p-2"
        >
          <span className="font-mono font-medium">{cookie.name}</span>
          <span className="font-mono break-all"> = {cookie.value}</span>
          <span className="text-muted-foreground block">
            {cookie.domain}
            {cookie.path} ·{' '}
            {cookie.expires ? `expires ${new Date(cookie.expires).toLocaleString()}` : 'session'}
            {cookie.secure ? ' · Secure' : ''}
            {cookie.httpOnly ? ' · HttpOnly' : ''}
            {cookie.sameSite ? ` · SameSite=${cookie.sameSite}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Cookies({
  result,
  collectionId,
}: {
  result: HttpExecutionResult;
  collectionId: string | null;
}) {
  const [jar, setJar] = useState<HttpCookie[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (collectionId === null) return;
    try {
      setJar(await unwrap(api().http.cookies(collectionId)));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [collectionId]);
  useEffect(() => {
    void (async () => load())();
  }, [load, result.executionId]);
  return (
    <div className="flex flex-col gap-3" data-testid="response-cookies">
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium">Set by this response</h3>
        <CookieList cookies={result.setCookies} empty="This response set no cookies." />
      </section>
      <section className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium">Collection cookie jar</h3>
          {collectionId !== null && jar !== null && jar.length > 0 && (
            <Button
              size="xs"
              variant="outline"
              onClick={async () => {
                await unwrap(api().http.clearCookies(collectionId)).catch(() => undefined);
                await load();
              }}
            >
              Clear
            </Button>
          )}
        </div>
        {collectionId === null ? (
          <p className="text-muted-foreground text-sm">
            Requests outside a collection keep no cookies.
          </p>
        ) : error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : (
          <CookieList
            cookies={jar ?? []}
            empty="No cookies are kept for this collection. Cookies stay in memory until ATLAS closes."
          />
        )}
      </section>
    </div>
  );
}

function Timing({ result }: { result: HttpExecutionResult }) {
  const { timing } = result;
  const rows: [string, number | null][] = [
    ['DNS lookup', timing.dnsMs],
    ['Connection', timing.connectMs],
    ['TLS handshake', timing.tlsMs],
    ['Waiting for the first byte', timing.firstByteMs],
    ['Download', timing.downloadMs],
  ];
  return (
    <dl
      className="grid max-w-md grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm"
      data-testid="response-timing"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right tabular-nums">
            {value === null ? 'Did not happen' : formatMs(value)}
          </dd>
        </div>
      ))}
      <dt className="font-medium">Total{result.redirects.length > 0 ? ' (all redirects)' : ''}</dt>
      <dd className="text-right font-medium tabular-nums">{formatMs(timing.totalMs)}</dd>
      <dt className="text-muted-foreground col-span-2 pt-1 text-xs">
        Phases are of the last exchange, measured on a new connection.
      </dt>
    </dl>
  );
}

interface ResponseViewerProps {
  response: ResponseState;
  collectionId: string | null;
  onSaveSnapshot: (result: HttpExecutionResult) => void;
  onCompare: () => void;
}

/** Status, body, headers, cookies and timing of the last response (FR-1410–FR-1414). */
export function ResponseViewer({
  response,
  collectionId,
  onSaveSnapshot,
  onCompare,
}: ResponseViewerProps) {
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  if (response.status === 'idle') {
    return (
      <p className="text-muted-foreground p-4 text-sm" data-testid="response-empty">
        Send the request to see its response here.
      </p>
    );
  }
  if (response.status === 'sending') {
    return (
      <p className="text-muted-foreground p-4 text-sm" data-testid="response-sending">
        Waiting for the response…
      </p>
    );
  }
  if (response.status === 'failed') {
    return (
      <div className="p-3" data-testid="response-failed">
        <Alert variant={response.code === 'HTTP_CANCELLED' ? 'default' : 'destructive'}>
          <TriangleAlert />
          <AlertTitle>No response</AlertTitle>
          <AlertDescription>
            <p>{response.message}</p>
            {response.details.length > 0 && (
              <p className="font-mono text-xs">{response.details.join(', ')}</p>
            )}
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  const { result } = response;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3" data-testid="response-viewer">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span
          className={cn(
            'rounded px-2 py-0.5 font-mono text-xs font-semibold',
            statusClass(result.status),
          )}
          data-testid="response-status"
        >
          {result.status} {result.statusText}
        </span>
        <span className="tabular-nums" data-testid="response-time">
          {formatMs(result.timing.totalMs)}
        </span>
        <span className="tabular-nums" data-testid="response-size">
          {formatBytes(result.bodyBytes)}
          {result.transferredBytes !== result.bodyBytes && (
            <span className="text-muted-foreground">
              {' '}
              ({formatBytes(result.transferredBytes)} received)
            </span>
          )}
        </span>
        <span className="text-muted-foreground">{result.httpVersion}</span>
        {result.contentType && (
          <span className="text-muted-foreground truncate">{result.contentType}</span>
        )}
        <div className="ml-auto flex flex-wrap gap-1">
          <Button
            size="xs"
            variant="outline"
            onClick={async () => {
              setDownloadMessage(null);
              try {
                const { saved } = await unwrap(api().http.saveResponse(result.executionId));
                if (saved) setDownloadMessage('Saved.');
              } catch (caught) {
                setDownloadMessage(errorMessage(caught));
              }
            }}
          >
            <Download /> Download
          </Button>
          <Button size="xs" variant="outline" onClick={() => onSaveSnapshot(result)}>
            <Camera /> Save response
          </Button>
          <Button size="xs" variant="ghost" onClick={onCompare}>
            <GitCompare /> Compare
          </Button>
        </div>
      </div>
      {downloadMessage && (
        <p className="text-muted-foreground text-xs" role="status">
          {downloadMessage}
        </p>
      )}
      <p
        className="text-muted-foreground truncate font-mono text-xs"
        title={result.finalUrl}
        data-testid="response-url"
      >
        {result.finalUrl}
      </p>
      {result.redirects.length > 0 && (
        <ul className="text-muted-foreground text-xs" data-testid="response-redirects">
          {result.redirects.map((hop, index) => (
            <li key={index}>
              {hop.status} → <span className="font-mono">{hop.url}</span>
              {hop.credentialsRemoved && (
                <span className="text-foreground">
                  {' '}
                  <ShieldCheck className="inline size-3" aria-hidden /> credentials not forwarded
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {result.truncated && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            The response was larger than the limit of this request; only its beginning was kept.
          </AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue="body" className="min-h-0 flex-1">
        <TabsList>
          <TabsTrigger value="body">Body</TabsTrigger>
          <TabsTrigger value="headers">Headers ({result.headers.length})</TabsTrigger>
          <TabsTrigger value="cookies">Cookies ({result.setCookies.length})</TabsTrigger>
          <TabsTrigger value="timing">Timing</TabsTrigger>
          <TabsTrigger value="sent">Sent</TabsTrigger>
        </TabsList>
        <TabsContent value="body" className="flex min-h-0 flex-col">
          <ResponseBody key={result.executionId} result={result} />
        </TabsContent>
        <TabsContent value="headers" className="min-h-0 overflow-auto">
          <HeaderTable headers={result.headers} testId="response-headers" />
        </TabsContent>
        <TabsContent value="cookies" className="min-h-0 overflow-auto">
          <Cookies result={result} collectionId={collectionId} />
        </TabsContent>
        <TabsContent value="timing" className="min-h-0 overflow-auto">
          <Timing result={result} />
        </TabsContent>
        <TabsContent value="sent" className="min-h-0 overflow-auto">
          <p className="text-muted-foreground mb-1 font-mono text-xs break-all">
            {result.requestUrl}
          </p>
          <HeaderTable headers={result.requestHeaders} testId="request-sent-headers" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
