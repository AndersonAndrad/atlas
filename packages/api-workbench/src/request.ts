import {
  isSensitiveName,
  placeholderNames,
  redactHttpUrlQuery,
  splitHttpUrl,
  parseHttpQuery,
  type HttpBodyKind,
  type HttpRequestDefinition,
} from '@atlas/contracts';
import { AtlasError, type FieldIssue } from '@atlas/shared';

export interface HttpTarget {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  /** Path and query, with only the characters a request line cannot hold encoded. */
  path: string;
  /** scheme://host[:port] */
  origin: string;
  /** What is sent, without the fragment. */
  url: string;
}

// Characters a request target cannot carry as typed; everything else is kept, so
// percent-encoded text, dot segments and `+` are sent exactly as written (FR-1402).
const UNSAFE_TARGET_CHAR = /[\0-\x20\x7f"<>\\^`{|}]|[^\0-\x7f]/gu;

function encodeTarget(path: string): string {
  return path.replace(UNSAFE_TARGET_CHAR, (char) => encodeURIComponent(char));
}

/** Parses the URL text into what one exchange needs, without normalizing its path. */
export function parseHttpTarget(url: string): HttpTarget {
  const invalid = (reason: string, message?: string) =>
    new AtlasError('HTTP_INVALID_URL', message, {
      details: { reason },
      issues: message ? [{ field: 'url', message }] : [],
    });
  const match = /^(https?):\/\/([^/?#]*)([^#]*)/i.exec(url.trim());
  if (match === null) throw invalid('scheme');
  const scheme = match[1]!.toLowerCase();
  const authority = match[2]!;
  if (authority.includes('@')) {
    // Credentials in a URL end up in history and logs; Milestone B adds authentication.
    throw invalid(
      'userinfo',
      'URLs with a user name or password are not supported. Use an Authorization header.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(`${scheme}://${authority}/`);
  } catch {
    throw invalid('authority');
  }
  if (parsed.hostname === '') throw invalid('host');
  const protocol = scheme === 'https' ? 'https:' : 'http:';
  const port = parsed.port === '' ? (protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  const rest = match[3]!;
  const path = encodeTarget(rest === '' ? '/' : rest.startsWith('?') ? `/${rest}` : rest);
  const origin = `${protocol}//${parsed.host}`;
  return {
    protocol,
    hostname: parsed.hostname.replace(/^\[(.*)\]$/, '$1'),
    port,
    path,
    origin,
    url: `${origin}${path}`,
  };
}

/** Names of the query parameters, headers and fields whose values are secret. */
export function secretNamesOf(definition: HttpRequestDefinition): Set<string> {
  const names = new Set<string>();
  for (const param of definition.params) if (param.secret) names.add(param.name);
  return names;
}

const isSecret = (row: { name: string; secret: boolean }) =>
  row.secret || isSensitiveName(row.name);

/**
 * Refuses what must not be sent (FR-1422, PLAN-042 Q1/Q3): placeholders that only
 * environments can resolve, secret values that were not entered again after a restart,
 * and file parts without a file.
 */
export function assertSendable(definition: HttpRequestDefinition): void {
  const { body } = definition;
  const texts: [string, string][] = [['url', definition.url]];
  const secretsMissing: FieldIssue[] = [];
  for (const header of definition.headers) {
    if (!header.enabled || header.name === '') continue;
    texts.push([`header ${header.name}`, header.name], [`header ${header.name}`, header.value]);
    if (isSecret(header) && header.value === '') {
      secretsMissing.push({ field: `header:${header.name}`, message: header.name });
    }
  }
  for (const param of parseHttpQuery(splitHttpUrl(definition.url).query)) {
    const flagged = definition.params.find((p) => p.enabled && p.name === param.name);
    if ((flagged?.secret || isSensitiveName(param.name)) && param.value === '') {
      secretsMissing.push({ field: `param:${param.name}`, message: param.name });
    }
  }
  const fileIssues: FieldIssue[] = [];
  switch (body.type) {
    case 'text':
    case 'json':
    case 'xml':
      texts.push(['body', body.text]);
      break;
    case 'form':
      for (const field of body.fields) {
        if (!field.enabled) continue;
        texts.push([`field ${field.name}`, field.name], [`field ${field.name}`, field.value]);
        if (isSecret(field) && field.value === '') {
          secretsMissing.push({ field: `field:${field.name}`, message: field.name });
        }
      }
      break;
    case 'multipart':
      for (const part of body.parts) {
        if (!part.enabled) continue;
        if (part.kind === 'text') {
          texts.push([`part ${part.name}`, part.name], [`part ${part.name}`, part.value]);
          if (isSecret(part) && part.value === '') {
            secretsMissing.push({ field: `part:${part.name}`, message: part.name });
          }
        } else if (part.file === null) {
          fileIssues.push({ field: `part:${part.name}`, message: 'Choose a file.' });
        }
      }
      break;
    case 'binary':
      if (body.file === null) fileIssues.push({ field: 'body', message: 'Choose a file.' });
      break;
    case 'none':
      break;
  }
  const variables = new Set<string>();
  for (const [, text] of texts) for (const name of placeholderNames(text)) variables.add(name);
  if (variables.size > 0) {
    throw new AtlasError('HTTP_UNRESOLVED_VARIABLE', undefined, {
      issues: [...variables].map((name) => ({ field: 'variable', message: `{{${name}}}` })),
    });
  }
  if (secretsMissing.length > 0) {
    throw new AtlasError('HTTP_SECRET_MISSING', undefined, { issues: secretsMissing });
  }
  if (fileIssues.length > 0) {
    throw new AtlasError('VALIDATION_FAILED', 'Choose the files to upload.', {
      issues: fileIssues,
    });
  }
}

/**
 * The definition as stored: values of secret rows, and of rows whose names usually carry
 * credentials, are emptied and the rows marked secret (PLAN-042 Q1). The user enters them
 * again before sending.
 */
export function definitionForStorage(definition: HttpRequestDefinition): HttpRequestDefinition {
  const strip = <T extends { name: string; secret: boolean; value: string }>(row: T): T =>
    isSecret(row) ? { ...row, value: '', secret: true } : row;
  const params = definition.params.map((param) =>
    param.secret || isSensitiveName(param.name)
      ? { ...param, value: param.value === null ? null : '', secret: true }
      : param,
  );
  const { body } = definition;
  return {
    ...definition,
    url: redactHttpUrlQuery(definition.url, secretNamesOf(definition)),
    params,
    headers: definition.headers.map(strip),
    body:
      body.type === 'form'
        ? { ...body, fields: body.fields.map(strip) }
        : body.type === 'multipart'
          ? {
              ...body,
              parts: body.parts.map((part) => (part.kind === 'text' ? strip(part) : part)),
            }
          : body,
  };
}

/** The URL as history shows it: secret query values replaced by a marker (FR-1419). */
export function urlForHistory(url: string, definition: HttpRequestDefinition): string {
  return redactHttpUrlQuery(url, secretNamesOf(definition), '[secret]').slice(0, 2000);
}

/** Every file a definition uploads. */
export function filesOf(definition: HttpRequestDefinition): string[] {
  const { body } = definition;
  if (body.type === 'binary') return body.file ? [body.file.path] : [];
  if (body.type === 'multipart') {
    return body.parts.flatMap((part) =>
      part.kind === 'file' && part.enabled && part.file ? [part.file.path] : [],
    );
  }
  return [];
}

const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

/**
 * Hides secret header values for display, history and snapshots. `extra` holds names the
 * user marked as secret.
 */
export function redactHeaders(
  headers: readonly [string, string][],
  extra: ReadonlySet<string> = new Set(),
): [string, string][] {
  return headers.map(([name, value]) => {
    const lower = name.toLowerCase();
    const hidden =
      SECRET_HEADERS.has(lower) ||
      lower === 'set-cookie' ||
      extra.has(lower) ||
      isSensitiveName(name);
    return [name, hidden ? '[secret]' : value];
  });
}

/** Headers whose values the user marked as secret, lower-cased. */
export function secretHeaderNames(definition: HttpRequestDefinition): Set<string> {
  return new Set(
    definition.headers.filter((header) => isSecret(header)).map((h) => h.name.toLowerCase()),
  );
}

/** What a redirect does to the next exchange (FR-1408). */
export interface RedirectPlan {
  url: string;
  method: string;
  keepBody: boolean;
  /** Credentials must not follow: another origin, or HTTPS to HTTP. */
  removeCredentials: boolean;
}

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function planRedirect(
  current: { method: string; target: HttpTarget },
  status: number,
  location: string,
): RedirectPlan {
  let next: URL;
  try {
    next = new URL(location, current.target.url);
  } catch {
    throw new AtlasError('HTTP_TRANSPORT_FAILED', 'The server sent an invalid redirect.', {
      details: { reason: 'redirect-location' },
    });
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw new AtlasError('HTTP_TRANSPORT_FAILED', 'The server redirected outside HTTP.', {
      details: { reason: 'redirect-scheme' },
    });
  }
  next.hash = '';
  const method = current.method.toUpperCase();
  // As browsers and curl do: 303 becomes GET; 301/302 after POST become GET.
  const toGet =
    (status === 303 && method !== 'HEAD') ||
    ((status === 301 || status === 302) && method === 'POST');
  const removeCredentials =
    next.origin !== current.target.origin ||
    (current.target.protocol === 'https:' && next.protocol === 'http:');
  return {
    url: next.href,
    method: toGet ? 'GET' : current.method,
    keepBody: !toGet,
    removeCredentials,
  };
}

const TEXT_TYPES =
  /^(text\/|application\/(javascript|x-www-form-urlencoded|graphql|yaml|x-yaml|toml|x-sh|csv))/i;

/** How a response body can be shown, from its type or, without one, its first bytes. */
export function bodyKindOf(
  contentType: string | null,
  head: Uint8Array,
  bytes: number,
): HttpBodyKind {
  if (bytes === 0) return 'empty';
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (/^application\/(.+\+)?json$/.test(type) || type === 'text/json') return 'json';
  if (/^(application|text)\/(.+\+)?xml$/.test(type)) return 'xml';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (TEXT_TYPES.test(type)) return 'text';
  if (type !== '' && type !== 'application/octet-stream') return 'binary';
  return looksLikeText(head) ? 'text' : 'binary';
}

function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(trimIncompleteUtf8(head));
    return true;
  } catch {
    return false;
  }
}

/** Drops a multi-byte character cut at the end, so a page of text decodes cleanly. */
export function trimIncompleteUtf8(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  let back = 0;
  while (end - back - 1 >= 0 && back < 4 && (bytes[end - back - 1]! & 0xc0) === 0x80) back += 1;
  const leadIndex = end - back - 1;
  if (leadIndex < 0) return bytes;
  const lead = bytes[leadIndex]!;
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (expected > back + 1) end = leadIndex;
  return bytes.subarray(0, end);
}
