import type {
  HttpCollection,
  HttpCollectionScope,
  HttpCookie,
  HttpFolder,
  HttpHistoryEntry,
  HttpHistoryPage,
  HttpRequestDefinition,
  HttpSavedRequest,
  HttpSnapshot,
  HttpSnapshotSummary,
  ListHttpCollectionsInput,
  MoveHttpItemInput,
} from '@atlas/contracts';

/** What one exchange sends: a body ATLAS can produce again for each redirect. */
export type HttpOutgoingBody =
  | { kind: 'none' }
  | { kind: 'bytes'; data: Uint8Array }
  | { kind: 'file'; path: string }
  | {
      kind: 'multipart';
      parts: (
        | { kind: 'text'; name: string; value: string }
        | { kind: 'file'; name: string; path: string; fileName: string; contentType: string | null }
      )[];
    };

export interface HttpExchangeRequest {
  method: string;
  protocol: 'http:' | 'https:';
  /** Without IPv6 brackets. */
  hostname: string;
  port: number;
  /** Path and query as sent on the request line. */
  path: string;
  headers: [string, string][];
  body: HttpOutgoingBody;
  verifyTls: boolean;
  signal: AbortSignal;
  /** Decoded body bytes kept at most; the rest is not read. */
  maxBodyBytes: number;
  /** Where the decoded body is written; each exchange replaces the previous content. */
  bodyFile: string;
}

export interface HttpExchangeResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: [string, string][];
  /** Headers actually sent, including those the transport added (e.g. a multipart type). */
  sentHeaders: [string, string][];
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  firstByteMs: number | null;
  downloadMs: number | null;
  bodyBytes: number;
  transferredBytes: number;
  truncated: boolean;
  /** The first bytes of the decoded body, to recognize text. */
  head: Uint8Array;
}

/**
 * One HTTP exchange without following redirects (FR-1407). Failures are AtlasErrors with
 * transport codes (HTTP_DNS_FAILED, HTTP_TLS_FAILED, HTTP_TIMEOUT…), never HTTP statuses.
 */
export interface HttpTransport {
  exchange(request: HttpExchangeRequest): Promise<HttpExchangeResponse>;
  /** Whether a file to upload exists and can be read; returns its size. */
  inspectFile(path: string): Promise<{ size: number } | null>;
}

/** Cookie jars, one per collection, held in memory only (FR-1413). */
export interface HttpCookieJars {
  /** The `Cookie` header value for a URL, or null. */
  cookieHeader(jarId: string, url: string): Promise<string | null>;
  /** Stores the cookies a response set; returns those accepted. */
  store(jarId: string, url: string, setCookies: readonly string[]): Promise<void>;
  list(jarId: string): Promise<HttpCookie[]>;
  clear(jarId: string): Promise<void>;
  /** Reads a Set-Cookie value for display, scoped to the URL that set it. */
  parse(setCookie: string, url: string): HttpCookie | null;
}

/** Response bodies kept in private files while a window shows them. */
export interface HttpResponseFiles {
  /** A new, empty file path only the user can read. */
  allocate(executionId: string): Promise<string>;
  read(file: string, offset: number, limit: number): Promise<Uint8Array>;
  copyTo(file: string, destination: string): Promise<void>;
  remove(file: string): Promise<void>;
  /** Removes every kept body (start-up and shutdown). */
  removeAll(): Promise<void>;
}

export interface NewHttpCollection {
  id: string;
  name: string;
  description: string;
  scope: HttpCollectionScope;
  cookieJar: boolean;
  createdAt: string;
}

export interface HttpCollectionPatch {
  name?: string;
  description?: string;
  scope?: HttpCollectionScope;
  cookieJar?: boolean;
}

export interface StoredHttpRequest {
  id: string;
  collectionId: string;
  folderId: string | null;
  name: string;
  /** Already stripped of secret values. */
  definition: HttpRequestDefinition;
}

export interface NewHttpSnapshot extends Omit<HttpSnapshot, 'createdAt'> {
  createdAt: string;
}

export interface HttpWorkbenchRepository {
  listCollections(filter: ListHttpCollectionsInput): HttpCollection[];
  getCollection(id: string): HttpCollection | null;
  createCollection(collection: NewHttpCollection): void;
  updateCollection(id: string, patch: HttpCollectionPatch, updatedAt: string): boolean;
  deleteCollection(id: string): boolean;
  /** Inserts a collection with its folders and requests in one transaction. */
  insertCollectionTree(
    collection: NewHttpCollection,
    folders: HttpFolder[],
    requests: StoredHttpRequest[],
  ): void;

  getFolder(id: string): HttpFolder | null;
  createFolder(folder: Omit<HttpFolder, 'position'>, createdAt: string): HttpFolder;
  renameFolder(id: string, name: string, updatedAt: string): boolean;
  deleteFolder(id: string): boolean;

  getRequest(id: string): HttpSavedRequest | null;
  /** Inserts, or updates when the id exists; new requests go last in their folder. */
  saveRequest(request: StoredHttpRequest, now: string): HttpSavedRequest;
  deleteRequest(id: string): boolean;
  move(input: MoveHttpItemInput, updatedAt: string): void;
  /** Whether a saved request refers to this file to upload. */
  isStoredFile(path: string): boolean;

  addHistory(entry: Omit<HttpHistoryEntry, 'id'>, keep: number): void;
  history(query: { requestId?: string; before?: number; limit: number }): HttpHistoryPage;
  clearHistory(): void;
  /** Distinct recent URLs, newest first, for suggestions. */
  recentUrls(limit: number): string[];

  saveSnapshot(snapshot: NewHttpSnapshot): void;
  listSnapshots(requestId: string | null): HttpSnapshotSummary[];
  getSnapshot(id: string): HttpSnapshot | null;
  deleteSnapshot(id: string): boolean;
  countSnapshots(): number;
}
