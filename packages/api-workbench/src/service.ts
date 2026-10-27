import { isAbsolute } from 'node:path';
import {
  CreateHttpCollectionSchema,
  CreateHttpFolderSchema,
  HTTP_SNAPSHOT_BODY_MAX_BYTES,
  HttpCollectionIdSchema,
  HttpExecutionIdSchema,
  HttpFolderIdSchema,
  HttpHistoryQuerySchema,
  HttpRequestIdSchema,
  HttpSnapshotIdSchema,
  HttpSnapshotListSchema,
  ListHttpCollectionsSchema,
  MoveHttpItemSchema,
  ReadHttpBodySchema,
  RenameHttpItemSchema,
  SaveHttpRequestSchema,
  SaveHttpSnapshotSchema,
  SendHttpRequestSchema,
  UpdateHttpCollectionSchema,
  parseInput,
  type HttpBody,
  type HttpBodyPage,
  type HttpCollection,
  type HttpCollectionScope,
  type HttpCookie,
  type HttpExecutionResult,
  type HttpFolder,
  type HttpHistoryEntry,
  type HttpHistoryPage,
  type HttpRedirectHop,
  type HttpRequestDefinition,
  type HttpSavedRequest,
  type HttpSnapshot,
  type HttpSnapshotSummary,
} from '@atlas/contracts';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import type {
  HttpCookieJars,
  HttpExchangeResponse,
  HttpOutgoingBody,
  HttpResponseFiles,
  HttpTransport,
  HttpWorkbenchRepository,
  StoredHttpRequest,
} from './ports.js';
import {
  REDIRECT_STATUSES,
  assertSendable,
  bodyKindOf,
  definitionForStorage,
  filesOf,
  parseHttpTarget,
  planRedirect,
  redactHeaders,
  secretHeaderNames,
  trimIncompleteUtf8,
  urlForHistory,
  type HttpTarget,
} from './request.js';

/** Requests running at once for one window (§19). */
export const MAX_RUNNING_PER_WINDOW = 6;
/** Responses kept per window; the oldest body file is removed first. */
export const MAX_KEPT_RESPONSES = 20;
export const HISTORY_KEPT = 1000;
export const MAX_SNAPSHOTS = 100;

export interface HttpWorkbenchOptions {
  repository: HttpWorkbenchRepository;
  transport: HttpTransport;
  cookies: HttpCookieJars;
  responses: HttpResponseFiles;
  projectExists: (projectId: string) => Promise<boolean>;
  /** Sent as `User-Agent` unless the request sets one. */
  userAgent: string;
  clock: { now(): Date };
  generateId: () => string;
  logger: Logger;
}

interface Running {
  subscriber: string;
  controller: AbortController;
}

interface Kept {
  subscriber: string;
  file: string;
  result: HttpExecutionResult;
  method: string;
  requestId: string | null;
  /** The URL for history and snapshots: secret query values hidden. */
  shownUrl: string;
  secretHeaders: Set<string>;
}

const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

/**
 * Requests, collections and history of the API Workbench (SDD-014 Milestone A). HTTP runs
 * here, in the Engine, never in the window (§2.1).
 */
export class HttpWorkbenchService {
  private readonly running = new Map<string, Running>();
  private readonly kept = new Map<string, Kept>();
  private closed = false;

  constructor(private readonly options: HttpWorkbenchOptions) {}

  /** Removes response bodies a previous run left behind. */
  async initialize(): Promise<void> {
    await this.options.responses.removeAll();
  }

  // --- Collections -------------------------------------------------------

  listCollections(input: unknown): HttpCollection[] {
    return this.options.repository.listCollections(parseInput(ListHttpCollectionsSchema, input));
  }

  async createCollection(input: unknown): Promise<HttpCollection> {
    const parsed = parseInput(CreateHttpCollectionSchema, input);
    await this.assertProjects(parsed.scope);
    const id = this.options.generateId();
    this.options.repository.createCollection({
      id,
      name: parsed.name,
      description: parsed.description,
      scope: parsed.scope,
      cookieJar: true,
      createdAt: this.now(),
    });
    return this.collection(id);
  }

  async updateCollection(input: unknown): Promise<HttpCollection> {
    const { id, ...patch } = parseInput(UpdateHttpCollectionSchema, input);
    if (patch.scope) await this.assertProjects(patch.scope);
    if (!this.options.repository.updateCollection(id, patch, this.now())) {
      throw new AtlasError('HTTP_COLLECTION_NOT_FOUND');
    }
    if (patch.cookieJar === false) await this.options.cookies.clear(id);
    return this.collection(id);
  }

  duplicateCollection(input: unknown): HttpCollection {
    const source = this.collection(parseInput(HttpCollectionIdSchema, input));
    const id = this.options.generateId();
    const folderIds = new Map(
      source.folders.map((folder) => [folder.id, this.options.generateId()]),
    );
    const folders: HttpFolder[] = source.folders.map((folder) => ({
      ...folder,
      id: folderIds.get(folder.id)!,
      collectionId: id,
      parentId: folder.parentId === null ? null : (folderIds.get(folder.parentId) ?? null),
    }));
    const requests: StoredHttpRequest[] = source.requests.map((summary) => {
      const request = this.options.repository.getRequest(summary.id);
      if (request === null) throw new AtlasError('HTTP_REQUEST_NOT_FOUND');
      return {
        id: this.options.generateId(),
        collectionId: id,
        folderId: summary.folderId === null ? null : (folderIds.get(summary.folderId) ?? null),
        name: summary.name,
        definition: request.definition,
      };
    });
    this.options.repository.insertCollectionTree(
      {
        id,
        name: copyName(source.name),
        description: source.description,
        scope: storedScope(source.scope),
        cookieJar: source.cookieJar,
        createdAt: this.now(),
      },
      folders,
      requests,
    );
    return this.collection(id);
  }

  async deleteCollection(input: unknown): Promise<void> {
    const id = parseInput(HttpCollectionIdSchema, input);
    if (!this.options.repository.deleteCollection(id)) {
      throw new AtlasError('HTTP_COLLECTION_NOT_FOUND');
    }
    await this.options.cookies.clear(id);
  }

  createFolder(input: unknown): HttpFolder {
    const parsed = parseInput(CreateHttpFolderSchema, input);
    this.collection(parsed.collectionId);
    if (parsed.parentId !== null) this.folderIn(parsed.parentId, parsed.collectionId);
    return this.options.repository.createFolder(
      { id: this.options.generateId(), ...parsed },
      this.now(),
    );
  }

  renameFolder(input: unknown): void {
    const { id, name } = parseInput(RenameHttpItemSchema, input);
    if (!this.options.repository.renameFolder(id, name, this.now())) {
      throw new AtlasError('VALIDATION_FAILED', 'The folder could not be found.');
    }
  }

  deleteFolder(input: unknown): void {
    if (!this.options.repository.deleteFolder(parseInput(HttpFolderIdSchema, input))) {
      throw new AtlasError('VALIDATION_FAILED', 'The folder could not be found.');
    }
  }

  // --- Requests ----------------------------------------------------------

  getRequest(input: unknown): HttpSavedRequest {
    const request = this.options.repository.getRequest(parseInput(HttpRequestIdSchema, input));
    if (request === null) throw new AtlasError('HTTP_REQUEST_NOT_FOUND');
    return request;
  }

  /** Saves without secret values (PLAN-042 Q1); files must have been picked. */
  saveRequest(input: unknown, pickedFiles: readonly string[]): HttpSavedRequest {
    const parsed = parseInput(SaveHttpRequestSchema, input);
    this.collection(parsed.collectionId);
    if (parsed.folderId !== null) this.folderIn(parsed.folderId, parsed.collectionId);
    if (parsed.id !== undefined && this.options.repository.getRequest(parsed.id) === null) {
      throw new AtlasError('HTTP_REQUEST_NOT_FOUND');
    }
    this.authorizeFiles(parsed.definition, pickedFiles);
    return this.options.repository.saveRequest(
      {
        id: parsed.id ?? this.options.generateId(),
        collectionId: parsed.collectionId,
        folderId: parsed.folderId,
        name: parsed.name,
        definition: definitionForStorage(parsed.definition),
      },
      this.now(),
    );
  }

  duplicateRequest(input: unknown): HttpSavedRequest {
    const source = this.getRequest(input);
    return this.options.repository.saveRequest(
      {
        id: this.options.generateId(),
        collectionId: source.collectionId,
        folderId: source.folderId,
        name: copyName(source.name),
        definition: source.definition,
      },
      this.now(),
    );
  }

  deleteRequest(input: unknown): void {
    if (!this.options.repository.deleteRequest(parseInput(HttpRequestIdSchema, input))) {
      throw new AtlasError('HTTP_REQUEST_NOT_FOUND');
    }
  }

  move(input: unknown): void {
    const parsed = parseInput(MoveHttpItemSchema, input);
    this.collection(parsed.collectionId);
    if (parsed.folderId !== null) this.folderIn(parsed.folderId, parsed.collectionId);
    if (parsed.kind === 'request' && this.options.repository.getRequest(parsed.id) === null) {
      throw new AtlasError('HTTP_REQUEST_NOT_FOUND');
    }
    if (parsed.kind === 'folder' && this.options.repository.getFolder(parsed.id) === null) {
      throw new AtlasError('VALIDATION_FAILED', 'The folder could not be found.');
    }
    this.options.repository.move(parsed, this.now());
  }

  // --- Execution ---------------------------------------------------------

  /**
   * Sends a request and keeps its response for the window that sent it. An HTTP error
   * status is a response; only transport failures throw (FR-1407).
   */
  async send(
    subscriber: string,
    input: unknown,
    pickedFiles: readonly string[],
  ): Promise<HttpExecutionResult> {
    if (this.closed) throw new AtlasError('ENGINE_UNAVAILABLE');
    const request = parseInput(SendHttpRequestSchema, input);
    const { definition, executionId } = request;
    assertSendable(definition);
    const target = parseHttpTarget(definition.url);
    this.authorizeFiles(definition, pickedFiles);
    for (const file of filesOf(definition)) {
      if ((await this.options.transport.inspectFile(file)) === null) {
        throw new AtlasError('HTTP_FILE_UNAVAILABLE');
      }
    }
    if (this.running.has(executionId) || this.kept.has(executionId)) {
      throw new AtlasError('VALIDATION_FAILED', 'This execution already exists.');
    }
    const runningHere = [...this.running.values()].filter((r) => r.subscriber === subscriber);
    if (runningHere.length >= MAX_RUNNING_PER_WINDOW) throw new AtlasError('HTTP_BUSY');

    const collection =
      request.collectionId === null
        ? null
        : this.options.repository.getCollection(request.collectionId);
    const jarId = collection?.cookieJar ? collection.id : null;
    const requestId =
      request.requestId !== null && this.options.repository.getRequest(request.requestId)
        ? request.requestId
        : null;
    const controller = new AbortController();
    this.running.set(executionId, { subscriber, controller });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, definition.settings.timeoutMs);
    const started = performance.now();
    const shownUrl = urlForHistory(definition.url, definition);
    let file: string | null = null;
    try {
      file = await this.options.responses.allocate(executionId);
      const { response, redirects, last } = await this.exchange(
        definition,
        target,
        jarId,
        controller.signal,
        file,
      );
      const totalMs = Math.round(performance.now() - started);
      const header = (name: string) =>
        response.headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
      const setCookieValues = response.headers
        .filter(([key]) => key.toLowerCase() === 'set-cookie')
        .map(([, value]) => value);
      const contentType = header('content-type');
      const result: HttpExecutionResult = {
        executionId,
        status: response.status,
        statusText: response.statusText,
        httpVersion: response.httpVersion,
        headers: response.headers,
        requestHeaders: redactHeaders(response.sentHeaders, secretHeaderNames(definition)),
        requestUrl: urlForHistory(target.url, definition),
        finalUrl: urlForHistory(last.url, definition),
        redirects,
        timing: {
          totalMs,
          dnsMs: response.dnsMs,
          connectMs: response.connectMs,
          tlsMs: response.tlsMs,
          firstByteMs: response.firstByteMs,
          downloadMs: response.downloadMs,
        },
        bodyBytes: response.bodyBytes,
        transferredBytes: response.transferredBytes,
        contentType,
        bodyKind: bodyKindOf(contentType, response.head, response.bodyBytes),
        truncated: response.truncated,
        setCookies: setCookieValues
          .map((value) => this.options.cookies.parse(value, last.url))
          .filter((cookie): cookie is HttpCookie => cookie !== null),
        receivedAt: this.now(),
      };
      this.keep(executionId, {
        subscriber,
        file,
        result,
        method: definition.method,
        requestId,
        shownUrl,
        secretHeaders: secretHeaderNames(definition),
      });
      this.record({
        requestId,
        collectionId: collection?.id ?? null,
        method: definition.method,
        url: shownUrl,
        status: result.status,
        durationMs: totalMs,
        responseBytes: result.bodyBytes,
        errorCode: null,
        errorSummary: null,
      });
      return result;
    } catch (caught) {
      if (file !== null) await this.options.responses.remove(file).catch(() => undefined);
      const error = timedOut
        ? new AtlasError('HTTP_TIMEOUT', undefined, { cause: caught })
        : controller.signal.aborted
          ? new AtlasError('HTTP_CANCELLED', undefined, { cause: caught })
          : caught instanceof AtlasError
            ? caught
            : new AtlasError('HTTP_TRANSPORT_FAILED', undefined, { cause: caught });
      if (error.code === 'HTTP_TRANSPORT_FAILED') {
        // Only the kind of failure: messages may quote URLs or header names (FR-1429).
        const cause = error.cause ?? caught;
        this.options.logger.warn('HTTP request failed', {
          name: cause instanceof Error ? cause.name : typeof cause,
          code: (cause as { code?: unknown } | null)?.code ?? null,
        });
      }
      this.record({
        requestId,
        collectionId: collection?.id ?? null,
        method: definition.method,
        url: shownUrl,
        status: null,
        durationMs: Math.round(performance.now() - started),
        responseBytes: null,
        errorCode: error.code,
        errorSummary: error.userMessage,
      });
      throw error;
    } finally {
      clearTimeout(timer);
      this.running.delete(executionId);
    }
  }

  /** Exchanges until a response that is not a followed redirect. */
  private async exchange(
    definition: HttpRequestDefinition,
    first: HttpTarget,
    jarId: string | null,
    signal: AbortSignal,
    file: string,
  ): Promise<{ response: HttpExchangeResponse; redirects: HttpRedirectHop[]; last: HttpTarget }> {
    const { settings } = definition;
    const prepared = outgoing(definition.body);
    let headers = this.baseHeaders(definition, prepared.contentType);
    let body = prepared.body;
    let method = definition.method;
    let target = first;
    const redirects: HttpRedirectHop[] = [];
    const secretHeaders = secretHeaderNames(definition);
    for (;;) {
      const cookie = jarId ? await this.options.cookies.cookieHeader(jarId, target.url) : null;
      const response = await this.options.transport.exchange({
        method,
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        headers: withCookie(headers, cookie),
        body,
        verifyTls: settings.verifyTls,
        signal,
        maxBodyBytes: settings.maxResponseBytes,
        bodyFile: file,
      });
      if (jarId) {
        const setCookies = response.headers
          .filter(([key]) => key.toLowerCase() === 'set-cookie')
          .map(([, value]) => value);
        if (setCookies.length > 0) await this.options.cookies.store(jarId, target.url, setCookies);
      }
      const location = response.headers.find(([key]) => key.toLowerCase() === 'location')?.[1];
      if (!settings.followRedirects || !REDIRECT_STATUSES.has(response.status) || !location) {
        return { response, redirects, last: target };
      }
      if (redirects.length >= settings.maxRedirects) {
        throw new AtlasError('HTTP_TOO_MANY_REDIRECTS');
      }
      const plan = planRedirect({ method, target }, response.status, location);
      if (plan.removeCredentials) {
        headers = headers.filter(([name]) => {
          const lower = name.toLowerCase();
          return !CREDENTIAL_HEADERS.has(lower) && !secretHeaders.has(lower);
        });
      }
      if (!plan.keepBody) {
        body = { kind: 'none' };
        headers = headers.filter(([name]) => !/^content-/i.test(name));
      }
      method = plan.method;
      target = parseHttpTarget(plan.url);
      redirects.push({
        status: response.status,
        url: urlForHistory(target.url, definition),
        credentialsRemoved: plan.removeCredentials,
      });
    }
  }

  private baseHeaders(
    definition: HttpRequestDefinition,
    contentType: string | null,
  ): [string, string][] {
    const multipart = definition.body.type === 'multipart';
    const headers: [string, string][] = definition.headers
      .filter((header) => header.enabled && header.name !== '')
      // The multipart type carries the boundary ATLAS generates.
      .filter((header) => !(multipart && header.name.toLowerCase() === 'content-type'))
      .map((header) => [header.name, header.value]);
    const has = (name: string) => headers.some(([key]) => key.toLowerCase() === name);
    if (!has('user-agent')) headers.push(['User-Agent', this.options.userAgent]);
    if (!has('accept')) headers.push(['Accept', '*/*']);
    if (!has('accept-encoding')) headers.push(['Accept-Encoding', 'gzip, deflate, br']);
    if (contentType !== null && !has('content-type')) headers.push(['Content-Type', contentType]);
    return headers;
  }

  cancel(input: unknown): void {
    this.running.get(parseInput(HttpExecutionIdSchema, input))?.controller.abort();
  }

  /** A page of a kept text body; pages end on whole characters (FR-1414). */
  async readBody(input: unknown): Promise<HttpBodyPage> {
    const { executionId, offset, limit } = parseInput(ReadHttpBodySchema, input);
    const kept = this.keptExecution(executionId);
    const total = kept.result.bodyBytes;
    if (offset >= total) {
      return { text: '', offset, nextOffset: total, totalBytes: total, complete: true };
    }
    const bytes = await this.options.responses.read(kept.file, offset, limit);
    const whole = offset + bytes.length >= total ? bytes : trimIncompleteUtf8(bytes);
    const page = whole.length === 0 ? bytes : whole;
    const nextOffset = offset + page.length;
    return {
      text: new TextDecoder('utf-8').decode(page),
      offset,
      nextOffset,
      totalBytes: total,
      complete: nextOffset >= total,
    };
  }

  /** Copies a kept body to a file the user chose in the save dialog (FR-1411). */
  async saveResponse(input: unknown, destination: string): Promise<void> {
    const kept = this.keptExecution(parseInput(HttpExecutionIdSchema, input));
    if (!isAbsolute(destination)) throw new AtlasError('VALIDATION_FAILED');
    await this.options.responses.copyTo(kept.file, destination);
  }

  async release(input: unknown): Promise<void> {
    const executionId = parseInput(HttpExecutionIdSchema, input);
    const kept = this.kept.get(executionId);
    if (kept === undefined) return;
    this.kept.delete(executionId);
    await this.options.responses.remove(kept.file).catch(() => undefined);
  }

  /** The window went away: its requests stop and its responses are removed. */
  async detach(subscriber: string): Promise<void> {
    for (const running of this.running.values()) {
      if (running.subscriber === subscriber) running.controller.abort();
    }
    const removals = [...this.kept.entries()]
      .filter(([, kept]) => kept.subscriber === subscriber)
      .map(([id, kept]) => {
        this.kept.delete(id);
        return this.options.responses.remove(kept.file).catch(() => undefined);
      });
    await Promise.all(removals);
  }

  async cookies(input: unknown): Promise<HttpCookie[]> {
    return this.options.cookies.list(this.collection(parseInput(HttpCollectionIdSchema, input)).id);
  }

  async clearCookies(input: unknown): Promise<void> {
    await this.options.cookies.clear(parseInput(HttpCollectionIdSchema, input));
  }

  // --- History and snapshots ---------------------------------------------

  history(input: unknown): HttpHistoryPage {
    return this.options.repository.history(parseInput(HttpHistoryQuerySchema, input));
  }

  clearHistory(): void {
    this.options.repository.clearHistory();
  }

  recentUrls(): string[] {
    return this.options.repository.recentUrls(50);
  }

  /** Saved on request only, without credentials or cookies (FR-1419). */
  async saveSnapshot(input: unknown): Promise<HttpSnapshotSummary> {
    const parsed = parseInput(SaveHttpSnapshotSchema, input);
    const kept = this.keptExecution(parsed.executionId);
    if (this.options.repository.countSnapshots() >= MAX_SNAPSHOTS) {
      throw new AtlasError('HTTP_SNAPSHOT_LIMIT');
    }
    const requestId =
      parsed.requestId !== null && this.options.repository.getRequest(parsed.requestId)
        ? parsed.requestId
        : null;
    const { result } = kept;
    const textual = result.bodyKind !== 'binary';
    const bytes = textual
      ? await this.options.responses.read(kept.file, 0, HTTP_SNAPSHOT_BODY_MAX_BYTES)
      : new Uint8Array();
    const snapshot: HttpSnapshot = {
      id: this.options.generateId(),
      requestId,
      name: parsed.name,
      method: kept.method,
      url: result.finalUrl,
      status: result.status,
      statusText: result.statusText,
      headers: redactHeaders(result.headers, kept.secretHeaders),
      contentType: result.contentType,
      bodyKind: result.bodyKind,
      body: textual ? new TextDecoder('utf-8').decode(trimIncompleteUtf8(bytes)) : null,
      bodyTruncated: textual && (result.truncated || result.bodyBytes > bytes.length),
      createdAt: this.now(),
    };
    this.options.repository.saveSnapshot(snapshot);
    return {
      id: snapshot.id,
      requestId,
      name: snapshot.name,
      method: snapshot.method,
      url: snapshot.url,
      status: snapshot.status,
      createdAt: snapshot.createdAt,
    };
  }

  snapshots(input: unknown): HttpSnapshotSummary[] {
    return this.options.repository.listSnapshots(
      parseInput(HttpSnapshotListSchema, input).requestId,
    );
  }

  snapshot(input: unknown): HttpSnapshot {
    const snapshot = this.options.repository.getSnapshot(parseInput(HttpSnapshotIdSchema, input));
    if (snapshot === null) throw new AtlasError('HTTP_SNAPSHOT_NOT_FOUND');
    return snapshot;
  }

  deleteSnapshot(input: unknown): void {
    if (!this.options.repository.deleteSnapshot(parseInput(HttpSnapshotIdSchema, input))) {
      throw new AtlasError('HTTP_SNAPSHOT_NOT_FOUND');
    }
  }

  /** Stops running requests and removes every kept body (shutdown). */
  async close(): Promise<void> {
    this.closed = true;
    for (const running of this.running.values()) running.controller.abort();
    this.kept.clear();
    await this.options.responses.removeAll().catch((error: unknown) =>
      this.options.logger.warn('Could not remove HTTP response files', {
        error: describeError(error),
      }),
    );
  }

  // --- Helpers -------------------------------------------------------------

  private now(): string {
    return this.options.clock.now().toISOString();
  }

  private collection(id: string): HttpCollection {
    const collection = this.options.repository.getCollection(id);
    if (collection === null) throw new AtlasError('HTTP_COLLECTION_NOT_FOUND');
    return collection;
  }

  private folderIn(folderId: string, collectionId: string): HttpFolder {
    const folder = this.options.repository.getFolder(folderId);
    if (folder === null || folder.collectionId !== collectionId) {
      throw new AtlasError('VALIDATION_FAILED', 'The folder could not be found.', {
        issues: [{ field: 'folderId', message: 'The folder is not in this collection.' }],
      });
    }
    return folder;
  }

  private async assertProjects(scope: HttpCollectionScope): Promise<void> {
    const ids =
      scope.kind === 'project'
        ? [scope.projectId]
        : scope.kind === 'shared'
          ? scope.projectIds
          : [];
    for (const id of ids) {
      if (!(await this.options.projectExists(id))) throw new AtlasError('PROJECT_NOT_FOUND');
    }
  }

  /**
   * Files are read only when chosen in this window's picker or already part of a saved
   * request (PLAN-042 R5): a window cannot make the Engine upload any other file.
   */
  private authorizeFiles(definition: HttpRequestDefinition, pickedFiles: readonly string[]): void {
    for (const file of filesOf(definition)) {
      if (!isAbsolute(file)) throw new AtlasError('HTTP_FILE_UNAUTHORIZED');
      if (!pickedFiles.includes(file) && !this.options.repository.isStoredFile(file)) {
        throw new AtlasError('HTTP_FILE_UNAUTHORIZED');
      }
    }
  }

  private keep(executionId: string, kept: Kept): void {
    this.kept.set(executionId, kept);
    const mine = [...this.kept.entries()].filter(([, k]) => k.subscriber === kept.subscriber);
    for (const [id, old] of mine.slice(0, Math.max(0, mine.length - MAX_KEPT_RESPONSES))) {
      this.kept.delete(id);
      void this.options.responses.remove(old.file).catch(() => undefined);
    }
  }

  private keptExecution(executionId: string): Kept {
    const kept = this.kept.get(executionId);
    if (kept === undefined) throw new AtlasError('HTTP_EXECUTION_NOT_FOUND');
    return kept;
  }

  private record(entry: Omit<HttpHistoryEntry, 'id' | 'executedAt'>): void {
    try {
      this.options.repository.addHistory({ ...entry, executedAt: this.now() }, HISTORY_KEPT);
    } catch (error) {
      this.options.logger.warn('Could not record HTTP history', { error: describeError(error) });
    }
  }
}

function copyName(name: string): string {
  return `${name.slice(0, 114)} copy`;
}

/** A removed project's collection is copied as a global one. */
function storedScope(scope: HttpCollection['scope']): HttpCollectionScope {
  if (scope.kind === 'project') {
    return scope.projectId === null
      ? { kind: 'global' }
      : { kind: 'project', projectId: scope.projectId };
  }
  return scope;
}

function withCookie(headers: [string, string][], jarCookie: string | null): [string, string][] {
  if (jarCookie === null) return headers;
  const index = headers.findIndex(([name]) => name.toLowerCase() === 'cookie');
  if (index === -1) return [...headers, ['Cookie', jarCookie]];
  return headers.map((header, i) =>
    i === index ? [header[0], `${header[1]}; ${jarCookie}`] : header,
  );
}

type OutgoingPart = Extract<HttpOutgoingBody, { kind: 'multipart' }>['parts'][number];

const encoder = new TextEncoder();

/** The body to send and the type it implies (FR-1405). */
function outgoing(body: HttpBody): { body: HttpOutgoingBody; contentType: string | null } {
  switch (body.type) {
    case 'none':
      return { body: { kind: 'none' }, contentType: null };
    case 'text':
      return {
        body: { kind: 'bytes', data: encoder.encode(body.text) },
        contentType: 'text/plain; charset=utf-8',
      };
    case 'json':
      return {
        body: { kind: 'bytes', data: encoder.encode(body.text) },
        contentType: 'application/json',
      };
    case 'xml':
      return {
        body: { kind: 'bytes', data: encoder.encode(body.text) },
        contentType: 'application/xml',
      };
    case 'form': {
      const form = new URLSearchParams();
      for (const field of body.fields)
        if (field.enabled && field.name !== '') form.append(field.name, field.value);
      return {
        body: { kind: 'bytes', data: encoder.encode(form.toString()) },
        contentType: 'application/x-www-form-urlencoded',
      };
    }
    case 'multipart':
      return {
        body: {
          kind: 'multipart',
          parts: body.parts.flatMap((part): OutgoingPart[] => {
            if (!part.enabled || part.name === '') return [];
            if (part.kind === 'text')
              return [{ kind: 'text' as const, name: part.name, value: part.value }];
            return part.file
              ? [
                  {
                    kind: 'file' as const,
                    name: part.name,
                    path: part.file.path,
                    fileName: part.file.name,
                    contentType: part.contentType,
                  },
                ]
              : [];
          }),
        },
        contentType: null,
      };
    case 'binary':
      return {
        body: body.file ? { kind: 'file', path: body.file.path } : { kind: 'none' },
        contentType: body.contentType ?? 'application/octet-stream',
      };
  }
}
