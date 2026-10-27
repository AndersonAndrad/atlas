import { createHash } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';

// Test-only helpers for SDD-015: a minimal ZIP writer to build VSIX packages (including
// hostile ones) and a local stand-in for the Open VSX API. Nothing reaches the internet.

export interface ZipEntry {
  name: string;
  data?: string | Buffer;
  /** Deflate instead of store. */
  deflate?: boolean;
  /** Unix mode stored in the external attributes, e.g. 0o120777 for a symbolic link. */
  mode?: number;
}

/** A ZIP archive with the given entries (UTF-8 names, no comments). */
export function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const stored = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw);
    const method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export interface FixtureExtension {
  namespace: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  categories?: string[];
  /** The manifest the registry publishes and the package contains. */
  manifest: Record<string, unknown>;
  /** Files below `extension/`, besides package.json. */
  files?: Record<string, string | Buffer>;
  /** Replaces the whole package (hostile cases). */
  vsix?: Buffer;
  /** Published checksum; defaults to the real one. Null publishes none. */
  sha256?: string | null;
  dependencies?: string[];
}

/** A VSIX with `extension/package.json` and the extension's files. */
export function vsixOf(extension: FixtureExtension): Buffer {
  return (
    extension.vsix ??
    zip([
      { name: 'extension.vsixmanifest', data: '<PackageManifest/>' },
      { name: 'extension/package.json', data: JSON.stringify(extension.manifest), deflate: true },
      ...Object.entries(extension.files ?? {}).map(([name, data]) => ({
        name: `extension/${name}`,
        data,
        deflate: true,
      })),
    ])
  );
}

export function fixtureManifest(
  namespace: string,
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { publisher: namespace, name, version, engines: { vscode: '^1.80.0' }, ...extra };
}

export interface FakeRegistry {
  url: string;
  /** Versions by `namespace.name`, newest last. */
  extensions: Map<string, FixtureExtension[]>;
  add(extension: FixtureExtension): void;
  /** Answers every request with 503 while true. */
  down: boolean;
  requests: string[];
  close(): Promise<void>;
}

/** The parts of the Open VSX API ATLAS uses, served from memory on 127.0.0.1. */
export async function startFakeRegistry(): Promise<FakeRegistry> {
  const extensions = new Map<string, FixtureExtension[]>();
  const registry: FakeRegistry = {
    url: '',
    extensions,
    down: false,
    requests: [],
    add(extension) {
      const key = `${extension.namespace}.${extension.name}`;
      extensions.set(key, [...(extensions.get(key) ?? []), extension]);
    },
    close: async () => undefined,
  };
  const base = () => registry.url;
  const describe = (extension: FixtureExtension) => {
    const versions = extensions.get(`${extension.namespace}.${extension.name}`) ?? [];
    const file = (name: string) =>
      `${base()}/api/${extension.namespace}/${extension.name}/${extension.version}/file/${name}`;
    return {
      namespace: extension.namespace,
      name: extension.name,
      version: extension.version,
      displayName: extension.displayName ?? extension.name,
      description: extension.description ?? '',
      verified: true,
      deprecated: false,
      preRelease: false,
      timestamp: '2026-10-01T00:00:00Z',
      categories: extension.categories ?? [],
      license: 'MIT',
      homepage: 'https://example.com/extension',
      targetPlatform: 'universal',
      downloads: { universal: file('package.vsix') },
      allVersions: Object.fromEntries(
        [...versions].reverse().map((item) => [item.version, `${base()}/x`]),
      ),
      dependencies: (extension.dependencies ?? []).map((id) => {
        const [namespace, name] = id.split('.');
        return { namespace, extension: name };
      }),
      bundledExtensions: [],
      files: {
        download: file('package.vsix'),
        manifest: file('package.json'),
        sha256: file('package.sha256'),
      },
    };
  };
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    registry.requests.push(url.pathname + url.search);
    if (registry.down) {
      response.writeHead(503);
      response.end();
      return;
    }
    const all = [...extensions.values()].map((versions) => versions[versions.length - 1]!);
    if (url.pathname === '/api/-/search' || url.pathname === '/api/-/query') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      const category = url.searchParams.get('category');
      const namespace = url.searchParams.get('namespaceName');
      const found = all.filter(
        (item) =>
          (namespace === null || item.namespace === namespace) &&
          (category === null || (item.categories ?? []).includes(category)) &&
          (query === '' ||
            `${item.name} ${item.displayName ?? ''} ${item.description ?? ''}`
              .toLowerCase()
              .includes(query)),
      );
      json(response, 200, { offset: 0, totalSize: found.length, extensions: found.map(describe) });
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts.length < 3) return json(response, 404, { error: 'none' });
    const [, namespace, name] = parts;
    const versions = extensions.get(`${namespace}.${name}`) ?? [];
    const fileIndex = parts.indexOf('file');
    if (fileIndex > 0) {
      const version = parts[fileIndex - 1];
      const extension = versions.find((item) => item.version === version);
      if (!extension) return json(response, 404, { error: 'none' });
      const vsix = vsixOf(extension);
      switch (parts[fileIndex + 1]) {
        case 'package.vsix':
          response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          return response.end(vsix);
        case 'package.json':
          return json(response, 200, extension.manifest);
        case 'package.sha256': {
          if (extension.sha256 === null) return json(response, 404, { error: 'none' });
          const hash = extension.sha256 ?? createHash('sha256').update(vsix).digest('hex');
          response.writeHead(200, { 'Content-Type': 'text/plain' });
          return response.end(`${hash}  package.vsix\n`);
        }
        default:
          return json(response, 404, { error: 'none' });
      }
    }
    // /api/ns/name[/platform][/version]
    const rest = parts.slice(3).filter((part) => part !== 'universal');
    const extension =
      rest.length === 0
        ? versions[versions.length - 1]
        : versions.find((item) => item.version === rest[0]);
    if (!extension) return json(response, 404, { error: 'Extension not found' });
    json(response, 200, describe(extension));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registry.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  registry.close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return registry;
}
