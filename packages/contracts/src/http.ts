import { z } from 'zod';

// ---------------------------------------------------------------------------
// HTTP Client & API Workbench (SDD-014 Milestone A, PLAN-042)
// ---------------------------------------------------------------------------

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** An RFC 9110 token. CONNECT opens a tunnel, not a request, and is refused (FR-1401). */
export const HttpMethodSchema = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/, 'Use a method name without spaces or symbols.')
  .refine((method) => method.toUpperCase() !== 'CONNECT', 'CONNECT is not supported.');

export const HTTP_URL_MAX_LENGTH = 16_000;
export const HTTP_BODY_TEXT_MAX_LENGTH = 5_000_000;
export const HTTP_TIMEOUT_DEFAULT_MS = 30_000;
export const HTTP_MAX_RESPONSE_DEFAULT_BYTES = 50 * 1024 * 1024;
export const HTTP_MAX_REDIRECTS_DEFAULT = 10;
/** Text of a response body sent to the window per read (FR-1414). */
export const HTTP_BODY_PAGE_BYTES = 2 * 1024 * 1024;

/** `{{name}}` references; they are resolved from environments in Milestone B (FR-1422). */
export const HTTP_PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Names of the variables a text refers to, in order, without duplicates. */
export function placeholderNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(HTTP_PLACEHOLDER_PATTERN)) names.add(match[1] ?? '');
  return [...names];
}

const SENSITIVE_EXACT = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'key',
  'sig',
  'auth',
  'sid',
]);
const SENSITIVE_PART =
  /token|secret|passw|passwd|pwd|api[-_]?key|access[-_]?key|private[-_]?key|credential|session|signature/i;

/**
 * Whether a header, query parameter or form field name usually carries a credential. Its
 * value is never saved, like a value the user marked as secret (PLAN-042 Q1).
 */
export function isSensitiveName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return SENSITIVE_EXACT.has(normalized) || SENSITIVE_PART.test(normalized);
}

const NameText = z.string().max(1000);
const ValueText = z.string().max(64_000);

/** A query parameter; a null value is `?flag`, an empty one `?flag=` (FR-1403). */
export const HttpQueryParamSchema = z.object({
  name: NameText,
  value: ValueText.nullable(),
  enabled: z.boolean(),
  secret: z.boolean(),
});
export type HttpQueryParam = z.infer<typeof HttpQueryParamSchema>;

/** Header names are tokens; values cannot hold line breaks (request splitting, FR-1404). */
export const HttpHeaderSchema = z.object({
  name: z
    .string()
    .max(256)
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]*$/, 'Header names cannot contain spaces or symbols.'),
  value: ValueText.regex(/^[^\r\n\0]*$/, 'Header values cannot contain line breaks.'),
  enabled: z.boolean(),
  secret: z.boolean(),
});
export type HttpHeader = z.infer<typeof HttpHeaderSchema>;

export const HttpFormFieldSchema = z.object({
  name: NameText,
  value: ValueText,
  enabled: z.boolean(),
  secret: z.boolean(),
});
export type HttpFormField = z.infer<typeof HttpFormFieldSchema>;

/** A file chosen in the native picker; the Engine reads it only when allowed (FR-1405). */
export const HttpFileRefSchema = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(255),
});
export type HttpFileRef = z.infer<typeof HttpFileRefSchema>;

const ContentTypeText = z
  .string()
  .max(200)
  .regex(/^[^\r\n\0]*$/, 'Content types cannot contain line breaks.');

export const HttpMultipartPartSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    name: NameText,
    value: ValueText,
    enabled: z.boolean(),
    secret: z.boolean(),
  }),
  z.object({
    kind: z.literal('file'),
    name: NameText,
    file: HttpFileRefSchema.nullable(),
    contentType: ContentTypeText.nullable(),
    enabled: z.boolean(),
  }),
]);
export type HttpMultipartPart = z.infer<typeof HttpMultipartPartSchema>;

export const HttpBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.enum(['text', 'json', 'xml']),
    text: z.string().max(HTTP_BODY_TEXT_MAX_LENGTH),
  }),
  z.object({ type: z.literal('form'), fields: z.array(HttpFormFieldSchema).max(500) }),
  z.object({ type: z.literal('multipart'), parts: z.array(HttpMultipartPartSchema).max(100) }),
  z.object({
    type: z.literal('binary'),
    file: HttpFileRefSchema.nullable(),
    contentType: ContentTypeText.nullable(),
  }),
]);
export type HttpBody = z.infer<typeof HttpBodySchema>;
export type HttpBodyType = HttpBody['type'];

export const HttpRequestSettingsSchema = z.object({
  timeoutMs: z.number().int().min(1000).max(600_000),
  followRedirects: z.boolean(),
  maxRedirects: z.number().int().min(0).max(20),
  /** Off only by an explicit choice for this request; never for all requests (FR-1408). */
  verifyTls: z.boolean(),
  maxResponseBytes: z
    .number()
    .int()
    .min(1024)
    .max(1024 * 1024 * 1024),
});
export type HttpRequestSettings = z.infer<typeof HttpRequestSettingsSchema>;

export const DEFAULT_HTTP_REQUEST_SETTINGS: HttpRequestSettings = {
  timeoutMs: HTTP_TIMEOUT_DEFAULT_MS,
  followRedirects: true,
  maxRedirects: HTTP_MAX_REDIRECTS_DEFAULT,
  verifyTls: true,
  maxResponseBytes: HTTP_MAX_RESPONSE_DEFAULT_BYTES,
};

/**
 * What a request sends. The URL text is the source of truth: `params` is its editable
 * view and keeps the disabled parameters, which the URL does not contain.
 */
export const HttpRequestDefinitionSchema = z.object({
  method: HttpMethodSchema,
  url: z.string().max(HTTP_URL_MAX_LENGTH),
  params: z.array(HttpQueryParamSchema).max(500),
  headers: z.array(HttpHeaderSchema).max(200),
  body: HttpBodySchema,
  settings: HttpRequestSettingsSchema,
});
export type HttpRequestDefinition = z.infer<typeof HttpRequestDefinitionSchema>;

export function emptyHttpRequestDefinition(): HttpRequestDefinition {
  return {
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: { type: 'none' },
    settings: { ...DEFAULT_HTTP_REQUEST_SETTINGS },
  };
}

const Uuid = z.uuid();
export const HttpCollectionIdSchema = Uuid;
export const HttpRequestIdSchema = Uuid;
export const HttpFolderIdSchema = Uuid;
export const HttpExecutionIdSchema = Uuid;
export const HttpSnapshotIdSchema = Uuid;

const ItemName = z.string().trim().min(1, 'Enter a name.').max(120);

// --- Collections (FR-1416–FR-1418) ----------------------------------------

/** Global, one project, or explicitly shared with selected projects (FR-1417). */
export const HttpCollectionScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('project'), projectId: Uuid }),
  z.object({ kind: z.literal('shared'), projectIds: z.array(Uuid).min(1).max(100) }),
]);
export type HttpCollectionScope = z.infer<typeof HttpCollectionScopeSchema>;

export interface HttpRequestSummary {
  id: string;
  collectionId: string;
  folderId: string | null;
  name: string;
  method: string;
  url: string;
  position: number;
}

export interface HttpFolder {
  id: string;
  collectionId: string;
  parentId: string | null;
  name: string;
  position: number;
}

export interface HttpCollection {
  id: string;
  name: string;
  description: string;
  /** A project collection whose project was removed keeps `kind: 'project'` and a null id. */
  scope:
    | { kind: 'global' }
    | { kind: 'project'; projectId: string | null }
    | { kind: 'shared'; projectIds: string[] };
  /** Cookies received by its requests are kept in memory and sent back (FR-1413). */
  cookieJar: boolean;
  folders: HttpFolder[];
  requests: HttpRequestSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface HttpSavedRequest extends HttpRequestSummary {
  definition: HttpRequestDefinition;
  createdAt: string;
  updatedAt: string;
}

/** `project` lists global collections and those of the project; `all` lists every one. */
export const ListHttpCollectionsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project'), projectId: Uuid.nullable() }),
  z.object({ kind: z.literal('all') }),
]);
export type ListHttpCollectionsInput = z.infer<typeof ListHttpCollectionsSchema>;

export const CreateHttpCollectionSchema = z.object({
  name: ItemName,
  description: z.string().max(2000).default(''),
  scope: HttpCollectionScopeSchema,
});
export type CreateHttpCollectionInput = z.input<typeof CreateHttpCollectionSchema>;

export const UpdateHttpCollectionSchema = z.object({
  id: Uuid,
  name: ItemName.optional(),
  description: z.string().max(2000).optional(),
  scope: HttpCollectionScopeSchema.optional(),
  cookieJar: z.boolean().optional(),
});
export type UpdateHttpCollectionInput = z.infer<typeof UpdateHttpCollectionSchema>;

export const CreateHttpFolderSchema = z.object({
  collectionId: Uuid,
  parentId: Uuid.nullable(),
  name: ItemName,
});
export type CreateHttpFolderInput = z.infer<typeof CreateHttpFolderSchema>;

export const RenameHttpItemSchema = z.object({ id: Uuid, name: ItemName });
export type RenameHttpItemInput = z.infer<typeof RenameHttpItemSchema>;

/** Moves a request or folder into a collection and folder, at a position (FR-1416). */
export const MoveHttpItemSchema = z.object({
  kind: z.enum(['request', 'folder']),
  id: Uuid,
  collectionId: Uuid,
  folderId: Uuid.nullable(),
  position: z.number().int().min(0).max(100_000),
});
export type MoveHttpItemInput = z.infer<typeof MoveHttpItemSchema>;

export const SaveHttpRequestSchema = z.object({
  /** Absent for a new request. */
  id: Uuid.optional(),
  collectionId: Uuid,
  folderId: Uuid.nullable(),
  name: ItemName,
  definition: HttpRequestDefinitionSchema,
});
export type SaveHttpRequestInput = z.infer<typeof SaveHttpRequestSchema>;

/** Paths chosen in the native file picker of this window (main process only). */
export const PickedFilesSchema = z.array(z.string().min(1).max(4096)).max(1000);

// --- Execution (FR-1407–FR-1414) ------------------------------------------

export const SendHttpRequestSchema = z.object({
  executionId: Uuid,
  /** Cookies of this collection's jar are used when it is on. */
  collectionId: Uuid.nullable(),
  requestId: Uuid.nullable(),
  definition: HttpRequestDefinitionSchema,
});
export type SendHttpRequestInput = z.infer<typeof SendHttpRequestSchema>;

export type HttpBodyKind = 'json' | 'xml' | 'html' | 'text' | 'binary' | 'empty';

export interface HttpRedirectHop {
  status: number;
  url: string;
  /** Credentials were not sent on to this URL: another origin, or HTTPS to HTTP. */
  credentialsRemoved: boolean;
}

/** Measured phases of the last exchange; null when that phase did not happen (FR-1410). */
export interface HttpTiming {
  totalMs: number;
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  /** From sending until the response headers arrived. */
  firstByteMs: number | null;
  downloadMs: number | null;
}

export interface HttpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Null for a session cookie. */
  expires: string | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
}

/** A response received from the server, whatever its status (FR-1407). */
export interface HttpExecutionResult {
  executionId: string;
  status: number;
  statusText: string;
  httpVersion: string;
  /** In received order; repeated headers are kept. */
  headers: [string, string][];
  /** What ATLAS sent on the last exchange; secret values are hidden. */
  requestHeaders: [string, string][];
  requestUrl: string;
  finalUrl: string;
  redirects: HttpRedirectHop[];
  timing: HttpTiming;
  /** Bytes of the decoded body kept by ATLAS. */
  bodyBytes: number;
  /** Bytes received on the wire for the body, before decompression. */
  transferredBytes: number;
  contentType: string | null;
  bodyKind: HttpBodyKind;
  /** The body went over the size limit; only its beginning was kept. */
  truncated: boolean;
  /** Cookies set by this response. */
  setCookies: HttpCookie[];
  receivedAt: string;
}

export const ReadHttpBodySchema = z.object({
  executionId: Uuid,
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(HTTP_BODY_PAGE_BYTES).default(HTTP_BODY_PAGE_BYTES),
});
export type ReadHttpBodyInput = z.input<typeof ReadHttpBodySchema>;

export interface HttpBodyPage {
  text: string;
  offset: number;
  nextOffset: number;
  totalBytes: number;
  complete: boolean;
}

// --- History and snapshots (FR-1415, FR-1419) -----------------------------

export interface HttpHistoryEntry {
  id: number;
  requestId: string | null;
  collectionId: string | null;
  method: string;
  /** Secret query values are removed. */
  url: string;
  status: number | null;
  durationMs: number;
  responseBytes: number | null;
  errorCode: string | null;
  errorSummary: string | null;
  executedAt: string;
}

export const HttpHistoryQuerySchema = z.object({
  requestId: Uuid.optional(),
  /** Entries older than this id (pagination). */
  before: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type HttpHistoryQuery = z.input<typeof HttpHistoryQuerySchema>;

export interface HttpHistoryPage {
  entries: HttpHistoryEntry[];
  hasMore: boolean;
}

export const HTTP_SNAPSHOT_BODY_MAX_BYTES = 2 * 1024 * 1024;

export const SaveHttpSnapshotSchema = z.object({
  executionId: Uuid,
  requestId: Uuid.nullable(),
  name: ItemName,
});
export type SaveHttpSnapshotInput = z.infer<typeof SaveHttpSnapshotSchema>;

export interface HttpSnapshotSummary {
  id: string;
  requestId: string | null;
  name: string;
  method: string;
  url: string;
  status: number;
  createdAt: string;
}

export interface HttpSnapshot extends HttpSnapshotSummary {
  statusText: string;
  /** Credentials and cookies are hidden. */
  headers: [string, string][];
  contentType: string | null;
  bodyKind: HttpBodyKind;
  /** Null for binary bodies; at most 2 MB of text. */
  body: string | null;
  bodyTruncated: boolean;
}

export const HttpSnapshotListSchema = z.object({ requestId: Uuid.nullable() });
export type HttpSnapshotListInput = z.infer<typeof HttpSnapshotListSchema>;

// --- URL text and its query parameters (FR-1402, FR-1403) -----------------

/** The URL text split around its query, without decoding or normalizing anything. */
export function splitHttpUrl(url: string): { base: string; query: string | null; hash: string } {
  const hashAt = url.indexOf('#');
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  if (queryAt === -1) return { base: beforeHash, query: null, hash };
  return { base: beforeHash.slice(0, queryAt), query: beforeHash.slice(queryAt + 1), hash };
}

/**
 * Query parameters as written: `a` has no value, `a=` an empty one. Names and values
 * stay encoded as typed; duplicates and order are kept.
 */
export function parseHttpQuery(query: string | null): { name: string; value: string | null }[] {
  if (query === null || query === '') return [];
  return query
    .split('&')
    .filter((segment) => segment !== '')
    .map((segment) => {
      const equals = segment.indexOf('=');
      return equals === -1
        ? { name: segment, value: null }
        : { name: segment.slice(0, equals), value: segment.slice(equals + 1) };
    });
}

/** The URL with its query rebuilt from the enabled parameters, in order. */
export function httpUrlWithParams(url: string, params: readonly HttpQueryParam[]): string {
  const { base, hash } = splitHttpUrl(url);
  const query = params
    .filter((param) => param.enabled && param.name !== '')
    .map((param) => (param.value === null ? param.name : `${param.name}=${param.value}`))
    .join('&');
  return `${base}${query === '' ? '' : `?${query}`}${hash}`;
}

/**
 * Parameters after the URL text changed: the URL's own parameters, enabled, keeping the
 * secret flag of the same name, followed by the disabled parameters kept aside.
 */
export function httpParamsFromUrl(
  url: string,
  previous: readonly HttpQueryParam[],
): HttpQueryParam[] {
  const secretNames = new Set(previous.filter((param) => param.secret).map((p) => p.name));
  const enabled = parseHttpQuery(splitHttpUrl(url).query).map((param) => ({
    ...param,
    enabled: true,
    secret: secretNames.has(param.name) || isSensitiveName(param.name),
  }));
  return [...enabled, ...previous.filter((param) => !param.enabled)];
}

/**
 * The URL with the values of secret query parameters replaced (by `''` for storage, or a
 * marker for display). `secretNames` adds names the user marked as secret.
 */
export function redactHttpUrlQuery(
  url: string,
  secretNames: ReadonlySet<string>,
  replacement = '',
): string {
  const { base, query, hash } = splitHttpUrl(url);
  if (query === null) return url;
  const redacted = query
    .split('&')
    .map((segment) => {
      const equals = segment.indexOf('=');
      if (equals === -1) return segment;
      const name = segment.slice(0, equals);
      return secretNames.has(name) || isSensitiveName(safeDecode(name))
        ? `${name}=${replacement}`
        : segment;
    })
    .join('&');
  return `${base}?${redacted}${hash}`;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}
