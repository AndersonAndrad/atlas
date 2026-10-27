import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { ExtensionSearchResult, RegistryExtensionSummary } from '@atlas/contracts';
import {
  compareVersions,
  type ExtensionRegistry,
  type RegistryExtension,
  type RegistrySearchQuery,
} from '@atlas/extensions';
import { AtlasError } from '@atlas/shared';
import { z } from 'zod';

export const OPEN_VSX_URL = 'https://open-vsx.org';

const JSON_MAX_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const VERSIONS_MAX = 100;

const Text = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value ?? '').slice(0, max));
const Url = z.string().max(2048).nullish();
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const ReferenceSchema = z.object({ namespace: z.string(), extension: z.string() });

const SummarySchema = z.object({
  namespace: z.string().regex(NAME),
  name: z.string().regex(NAME),
  version: z.string().regex(VERSION),
  displayName: Text(200),
  description: Text(2000),
  verified: z.boolean().nullish(),
  deprecated: z.boolean().nullish(),
  timestamp: z.string().max(64).nullish(),
});

const SearchSchema = z.object({
  extensions: z.array(z.unknown()).max(100),
  offset: z.number().int().nullish(),
  totalSize: z.number().int().nullish(),
});

const ExtensionSchema = SummarySchema.extend({
  preRelease: z.boolean().nullish(),
  allVersions: z.record(z.string(), z.unknown()).nullish(),
  categories: z.array(z.string().max(100)).max(50).nullish(),
  license: z.string().max(200).nullish(),
  homepage: Url,
  repository: Url,
  targetPlatform: z.string().max(32).nullish(),
  downloads: z.record(z.string(), z.unknown()).nullish(),
  dependencies: z.array(ReferenceSchema).max(200).nullish(),
  bundledExtensions: z.array(ReferenceSchema).max(500).nullish(),
  files: z.object({ download: z.string().max(2048), manifest: Url, sha256: Url }),
});

/** Only absolute http(s) links are shown or opened. */
function webLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.replace(/^git\+/, '').replace(/\.git$/, ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function summary(value: z.infer<typeof SummarySchema>): RegistryExtensionSummary {
  return {
    id: `${value.namespace}.${value.name}`,
    namespace: value.namespace,
    name: value.name,
    displayName: value.displayName || value.name,
    description: value.description,
    version: value.version,
    verified: value.verified ?? false,
    deprecated: value.deprecated ?? false,
    publishedAt: value.timestamp ?? null,
  };
}

const referenceId = (reference: z.infer<typeof ReferenceSchema>) =>
  `${reference.namespace}.${reference.extension}`;

interface FetchOptions {
  maxBytes: number;
  timeoutMs: number;
  /** Receives the body; resolves when it was consumed. */
  consume: (response: IncomingMessage) => Promise<void>;
}

/**
 * Open VSX over Node's HTTP client in the Engine (FR-1501). JSON answers are checked,
 * bounded and cached for a few minutes; ATLAS never polls the registry on its own.
 */
export class OpenVsxRegistry implements ExtensionRegistry {
  private readonly base: URL;
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    baseUrl: string,
    private readonly userAgent: string,
    private readonly now: () => number = Date.now,
  ) {
    this.base = new URL(baseUrl);
    if (this.base.protocol !== 'https:' && this.base.protocol !== 'http:') {
      throw new Error('The extension registry must be an http(s) URL.');
    }
  }

  /** https only, unless the configured registry itself is plain http (tests). */
  private allowed(url: URL): boolean {
    return (
      url.protocol === 'https:' || (this.base.protocol === 'http:' && url.protocol === 'http:')
    );
  }

  private url(path: string, params: Record<string, string | number | null> = {}): URL {
    const url = new URL(path, this.base);
    for (const [name, value] of Object.entries(params)) {
      if (value !== null && value !== '') url.searchParams.set(name, String(value));
    }
    return url;
  }

  private request(target: URL, options: FetchOptions, redirects = 0): Promise<void> {
    if (!this.allowed(target)) {
      return Promise.reject(new AtlasError('EXTENSION_REGISTRY_INVALID_RESPONSE'));
    }
    const client = target.protocol === 'https:' ? https : http;
    return new Promise<void>((resolve, reject) => {
      const request = client.get(
        target,
        { headers: { 'User-Agent': this.userAgent, Accept: '*/*' }, timeout: options.timeoutMs },
        (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;
          if (status >= 300 && status < 400 && location) {
            response.resume();
            if (redirects >= MAX_REDIRECTS) {
              reject(new AtlasError('EXTENSION_REGISTRY_INVALID_RESPONSE'));
              return;
            }
            this.request(new URL(location, target), options, redirects + 1).then(resolve, reject);
            return;
          }
          if (status !== 200) {
            response.resume();
            reject(
              new AtlasError(
                status === 404
                  ? 'EXTENSION_NOT_FOUND'
                  : status === 429 || status >= 500
                    ? 'EXTENSION_REGISTRY_UNAVAILABLE'
                    : 'EXTENSION_REGISTRY_INVALID_RESPONSE',
                `Registry answered ${status}.`,
              ),
            );
            return;
          }
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > options.maxBytes) {
            response.destroy();
            reject(new AtlasError('EXTENSION_PACKAGE_TOO_LARGE'));
            return;
          }
          // A transfer that stalls or breaks midway is an unavailable registry, not a bug.
          options.consume(response).then(resolve, (error: unknown) =>
            reject(
              error instanceof AtlasError
                ? error
                : new AtlasError('EXTENSION_REGISTRY_UNAVAILABLE', 'Transfer failed.', {
                    cause: error,
                  }),
            ),
          );
        },
      );
      const deadline = setTimeout(
        () => request.destroy(new AtlasError('EXTENSION_REGISTRY_UNAVAILABLE', 'Timed out.')),
        options.timeoutMs,
      );
      request.on('close', () => clearTimeout(deadline));
      request.on('timeout', () =>
        request.destroy(new AtlasError('EXTENSION_REGISTRY_UNAVAILABLE', 'Timed out.')),
      );
      request.on('error', (error) =>
        reject(
          error instanceof AtlasError
            ? error
            : new AtlasError('EXTENSION_REGISTRY_UNAVAILABLE', 'Registry request failed.', {
                details: { code: (error as NodeJS.ErrnoException).code },
              }),
        ),
      );
    });
  }

  private async buffer(target: URL, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    await this.request(target, {
      maxBytes,
      timeoutMs: REQUEST_TIMEOUT_MS,
      consume: async (response) => {
        for await (const chunk of response) {
          size += (chunk as Buffer).length;
          if (size > maxBytes) {
            response.destroy();
            throw new AtlasError('EXTENSION_REGISTRY_INVALID_RESPONSE', 'Answer too large.');
          }
          chunks.push(chunk as Buffer);
        }
      },
    });
    return Buffer.concat(chunks);
  }

  private async json(target: URL, fresh = false): Promise<unknown> {
    const key = target.toString();
    const cached = this.cache.get(key);
    if (!fresh && cached !== undefined && this.now() - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }
    let value: unknown;
    try {
      value = JSON.parse((await this.buffer(target, JSON_MAX_BYTES)).toString('utf8'));
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      throw new AtlasError('EXTENSION_REGISTRY_INVALID_RESPONSE', 'Invalid JSON.');
    }
    if (typeof value === 'object' && value !== null && 'error' in value) {
      throw new AtlasError('EXTENSION_NOT_FOUND', 'Registry reported an error.');
    }
    if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new AtlasError('EXTENSION_REGISTRY_INVALID_RESPONSE', 'Unexpected registry answer.');
    }
    return result.data;
  }

  async search(query: RegistrySearchQuery): Promise<ExtensionSearchResult> {
    const target =
      query.publisher === null
        ? this.url('/api/-/search', {
            query: query.query,
            category: query.category,
            offset: query.offset,
            size: query.size,
            sortBy: 'relevance',
            sortOrder: 'desc',
          })
        : this.url('/api/-/query', {
            namespaceName: query.publisher,
            offset: query.offset,
            size: query.size,
          });
    const page = this.parse(SearchSchema, await this.json(target));
    const needle = query.publisher === null ? '' : query.query.toLowerCase();
    const extensions: RegistryExtensionSummary[] = [];
    for (const item of page.extensions) {
      const parsed = SummarySchema.safeParse(item);
      if (!parsed.success) continue;
      const found = summary(parsed.data);
      if (
        needle &&
        ![found.name, found.displayName, found.description].some((text) =>
          text.toLowerCase().includes(needle),
        )
      ) {
        continue;
      }
      extensions.push(found);
    }
    return {
      extensions,
      total: Math.max(page.totalSize ?? extensions.length, 0),
      offset: page.offset ?? query.offset,
    };
  }

  async extension(
    namespace: string,
    name: string,
    version: string | null,
    platform: string | null,
    fresh = false,
  ): Promise<RegistryExtension> {
    const parts = ['api', namespace, name, platform, version].filter(
      (part): part is string => part !== null,
    );
    const value = this.parse(
      ExtensionSchema,
      await this.json(this.url(`/${parts.map(encodeURIComponent).join('/')}`), fresh),
    );
    const versions = Object.keys(value.allVersions ?? {})
      .filter((item) => VERSION.test(item))
      .sort((a, b) => compareVersions(b, a))
      .slice(0, VERSIONS_MAX);
    const platforms = Object.keys(value.downloads ?? {}).filter((item) =>
      /^[a-z0-9-]{1,32}$/.test(item),
    );
    const targetPlatform = value.targetPlatform ?? 'universal';
    return {
      ...summary(value),
      preRelease: value.preRelease ?? false,
      versions: versions.length > 0 ? versions : [value.version],
      categories: value.categories ?? [],
      license: value.license ?? null,
      homepage: webLink(value.homepage),
      repository: webLink(value.repository),
      targetPlatform,
      platforms: platforms.length > 0 ? platforms : [targetPlatform],
      dependencies: (value.dependencies ?? []).map(referenceId),
      packMembers: (value.bundledExtensions ?? []).map(referenceId),
      files: {
        download: value.files.download,
        manifest: value.files.manifest ?? null,
        sha256: value.files.sha256 ?? null,
      },
    };
  }

  private absolute(url: string): URL {
    let target: URL;
    try {
      target = new URL(url, this.base);
    } catch {
      throw new AtlasError('EXTENSION_REGISTRY_INVALID_RESPONSE', 'Invalid file link.');
    }
    if (!this.allowed(target)) {
      throw new AtlasError('EXTENSION_REGISTRY_INVALID_RESPONSE', 'Insecure file link.');
    }
    return target;
  }

  async text(url: string, maxBytes: number): Promise<string> {
    return (await this.buffer(this.absolute(url), maxBytes)).toString('utf8');
  }

  async checksum(url: string): Promise<string | null> {
    try {
      const text = await this.text(url, 4096);
      const hash = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        throw new AtlasError('EXTENSION_REGISTRY_INVALID_RESPONSE', 'Invalid checksum file.');
      }
      return hash;
    } catch (error) {
      if (error instanceof AtlasError && error.code === 'EXTENSION_NOT_FOUND') return null;
      throw error;
    }
  }

  async download(url: string, destination: string, maxBytes: number): Promise<{ sha256: string }> {
    const hash = createHash('sha256');
    await this.request(this.absolute(url), {
      maxBytes,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      consume: async (response) => {
        let size = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > maxBytes) {
              callback(new AtlasError('EXTENSION_PACKAGE_TOO_LARGE'));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(response, limit, createWriteStream(destination, { mode: 0o600 }));
      },
    });
    return { sha256: hash.digest('hex') };
  }
}
