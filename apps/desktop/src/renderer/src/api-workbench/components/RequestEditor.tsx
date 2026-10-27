import {
  HTTP_METHODS,
  HttpHeaderSchema,
  HttpMethodSchema,
  httpParamsFromUrl,
  httpUrlWithParams,
  placeholderNames,
  type HttpRequestDefinition,
  type HttpRequestSettings,
} from '@atlas/contracts';
import { Loader2, Send, ShieldAlert, Square } from 'lucide-react';
import { useId } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { methodClass } from '../format';
import { BodyEditor } from './BodyEditor';
import { KeyValueEditor } from './KeyValueEditor';

const HEADER_NAME = HttpHeaderSchema.shape.name;

function headerNameError(name: string): string | null {
  const result = HEADER_NAME.safeParse(name);
  return result.success ? null : (result.error.issues[0]?.message ?? 'Invalid header name.');
}

/** Variables the request uses; environments resolve them in Milestone B (PLAN-042 Q3). */
function variablesOf(definition: HttpRequestDefinition): string[] {
  const texts = [definition.url];
  for (const header of definition.headers) {
    if (header.enabled) texts.push(header.name, header.value);
  }
  const { body } = definition;
  if ('text' in body) texts.push(body.text);
  if (body.type === 'form') {
    for (const field of body.fields) if (field.enabled) texts.push(field.name, field.value);
  }
  if (body.type === 'multipart') {
    for (const part of body.parts) {
      if (part.enabled && part.kind === 'text') texts.push(part.name, part.value);
    }
  }
  return [...new Set(texts.flatMap(placeholderNames))];
}

function SettingsEditor({
  settings,
  onChange,
}: {
  settings: HttpRequestSettings;
  onChange: (settings: HttpRequestSettings) => void;
}) {
  const id = useId();
  const number = (value: string, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return (
    <div className="grid max-w-xl grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-sm">
      <Label htmlFor={`${id}-timeout`}>Timeout (seconds)</Label>
      <Input
        id={`${id}-timeout`}
        type="number"
        min={1}
        max={600}
        value={Math.round(settings.timeoutMs / 1000)}
        onChange={(event) =>
          onChange({
            ...settings,
            timeoutMs: Math.min(600, Math.max(1, number(event.target.value, 30))) * 1000,
          })
        }
        className="h-8 w-28"
      />
      <Label htmlFor={`${id}-redirects`}>Follow redirects</Label>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-redirects`}
          checked={settings.followRedirects}
          onCheckedChange={(checked) =>
            onChange({ ...settings, followRedirects: checked === true })
          }
        />
        <Input
          type="number"
          min={0}
          max={20}
          aria-label="Maximum redirects"
          disabled={!settings.followRedirects}
          value={settings.maxRedirects}
          onChange={(event) =>
            onChange({
              ...settings,
              maxRedirects: Math.min(20, Math.max(0, Math.round(number(event.target.value, 10)))),
            })
          }
          className="h-8 w-20"
        />
        <span className="text-muted-foreground text-xs">at most</span>
      </div>
      <Label htmlFor={`${id}-size`}>Response size limit (MB)</Label>
      <Input
        id={`${id}-size`}
        type="number"
        min={1}
        max={1024}
        value={Math.round(settings.maxResponseBytes / (1024 * 1024))}
        onChange={(event) =>
          onChange({
            ...settings,
            maxResponseBytes:
              Math.min(1024, Math.max(1, Math.round(number(event.target.value, 50)))) * 1024 * 1024,
          })
        }
        className="h-8 w-28"
      />
      <Label htmlFor={`${id}-tls`}>Verify TLS certificates</Label>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-tls`}
          checked={settings.verifyTls}
          onCheckedChange={(checked) => onChange({ ...settings, verifyTls: checked === true })}
        />
        <span className="text-muted-foreground text-xs">Only for this request.</span>
      </div>
      {!settings.verifyTls && (
        <Alert className="col-span-2" variant="destructive">
          <ShieldAlert />
          <AlertDescription>
            Certificates are not verified for this request: anyone between you and the server can
            read or change it. Other requests still verify.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

interface RequestEditorProps {
  definition: HttpRequestDefinition;
  onChange: (definition: HttpRequestDefinition) => void;
  sending: boolean;
  onSend: () => void;
  onCancel: () => void;
  recentUrls: string[];
}

/** Method, URL, parameters, headers, body and settings of one request (FR-1401–FR-1406). */
export function RequestEditor({
  definition,
  onChange,
  sending,
  onSend,
  onCancel,
  recentUrls,
}: RequestEditorProps) {
  const id = useId();
  const variables = variablesOf(definition);
  const methodValid = HttpMethodSchema.safeParse(definition.method).success;
  const urlEmpty = definition.url.trim() === '';
  const headersInvalid = definition.headers.some((h) => h.enabled && headerNameError(h.name));
  const canSend = methodValid && !urlEmpty && variables.length === 0 && !headersInvalid;
  const enabledCount = (rows: { enabled: boolean; name: string }[]) =>
    rows.filter((row) => row.enabled && row.name !== '').length;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3"
      data-testid="request-editor"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSend && !sending) {
          event.preventDefault();
          onSend();
        }
      }}
    >
      <form
        className="flex flex-wrap items-center gap-2 sm:flex-nowrap"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend && !sending) onSend();
        }}
      >
        <Input
          list={`${id}-methods`}
          value={definition.method}
          onChange={(event) => onChange({ ...definition, method: event.target.value.trim() })}
          aria-label="Method"
          aria-invalid={!methodValid}
          className={cn(
            'h-9 w-28 shrink-0 font-mono font-semibold',
            methodClass(definition.method),
          )}
        />
        <datalist id={`${id}-methods`}>
          {HTTP_METHODS.map((method) => (
            <option key={method} value={method} />
          ))}
        </datalist>
        <Input
          list={`${id}-urls`}
          value={definition.url}
          onChange={(event) =>
            onChange({
              ...definition,
              url: event.target.value,
              params: httpParamsFromUrl(event.target.value, definition.params),
            })
          }
          placeholder="http://localhost:3000/api/users"
          aria-label="URL"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 font-mono text-sm"
        />
        <datalist id={`${id}-urls`}>
          {recentUrls.map((url) => (
            <option key={url} value={url} />
          ))}
        </datalist>
        {sending ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            <Square /> Cancel
          </Button>
        ) : (
          <Button type="submit" disabled={!canSend}>
            <Send /> Send
          </Button>
        )}
        {sending && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-hidden />}
      </form>
      {!methodValid && definition.method !== '' && (
        <p className="text-destructive text-xs" role="alert">
          Use a method name without spaces or symbols. CONNECT is not supported.
        </p>
      )}
      {variables.length > 0 && (
        <Alert data-testid="unresolved-variables">
          <AlertDescription>
            This request uses {variables.map((name) => `{{${name}}}`).join(', ')}. Variables come
            with environments in a later version; replace them with values to send the request.
          </AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue="params" className="min-h-0 flex-1">
        <TabsList>
          <TabsTrigger value="params">Params {badge(enabledCount(definition.params))}</TabsTrigger>
          <TabsTrigger value="headers">
            Headers {badge(enabledCount(definition.headers))}
          </TabsTrigger>
          <TabsTrigger value="body">Body</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="params" className="min-h-0 overflow-auto">
          <KeyValueEditor
            rows={definition.params}
            onChange={(params) =>
              onChange({ ...definition, params, url: httpUrlWithParams(definition.url, params) })
            }
            noun="parameter"
            create={() => ({ name: '', value: '', enabled: true, secret: false })}
            testId="query-params"
          />
        </TabsContent>
        <TabsContent value="headers" className="min-h-0 overflow-auto">
          <KeyValueEditor
            rows={definition.headers}
            onChange={(headers) => onChange({ ...definition, headers })}
            noun="header"
            create={() => ({ name: '', value: '', enabled: true, secret: false })}
            testId="request-headers"
            validateName={(name) => (name === '' ? null : headerNameError(name))}
          />
          <p className="text-muted-foreground mt-2 text-xs">
            ATLAS adds User-Agent, Accept, Accept-Encoding and the body's Content-Type when you do
            not set them.
          </p>
        </TabsContent>
        <TabsContent value="body" className="flex min-h-0 flex-col">
          <BodyEditor
            body={definition.body}
            onChange={(body) => onChange({ ...definition, body })}
          />
        </TabsContent>
        <TabsContent value="settings" className="min-h-0 overflow-auto">
          <SettingsEditor
            settings={definition.settings}
            onChange={(settings) => onChange({ ...definition, settings })}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function badge(count: number) {
  return count > 0 ? <span className="text-muted-foreground text-xs">({count})</span> : null;
}
