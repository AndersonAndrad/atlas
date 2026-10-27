import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ExtensionPackages } from '@atlas/extensions';
import { AtlasError } from '@atlas/shared';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

/** Limits of one extracted package (FR-1503, PLAN-043 R1). */
export interface ExtractionLimits {
  entries: number;
  totalBytes: number;
  fileBytes: number;
  /** Largest uncompressed/compressed ratio for entries over 1 MB (zip bombs). */
  ratio: number;
}

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  entries: 20_000,
  totalBytes: 256 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  ratio: 100,
};

const STAGING = '.staging';
const PREFIX = 'extension/';
const KEY = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const invalid = (reason: string) =>
  new AtlasError('EXTENSION_PACKAGE_INVALID', 'Unsafe or damaged package.', {
    details: { reason },
  });

function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      file,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true, decodeStrings: true },
      (error, zip) => (error || !zip ? reject(invalid('not a zip archive')) : resolve(zip)),
    );
  });
}

/** The path below `extension/` when the entry name is safe, else null. */
function entryPath(name: string): string | null {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  if (rest === '' || rest.endsWith('/')) return '';
  if (rest.includes('\\') || rest.includes('\0') || /^[A-Za-z]:/.test(rest)) {
    throw invalid('unsafe entry name');
  }
  const segments = rest.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalid('unsafe entry name');
  }
  return rest;
}

/**
 * Package files of installed extensions under `<data>/extensions/<id>/<version>`
 * (FR-1506). Packages are extracted into a staging folder and moved into place only
 * after every entry was checked, so a failed install never leaves a partial version.
 */
export class FileExtensionPackages implements ExtensionPackages {
  constructor(
    private readonly root: string,
    private readonly limits: ExtractionLimits = DEFAULT_EXTRACTION_LIMITS,
  ) {}

  private get staging(): string {
    return path.join(this.root, STAGING);
  }

  private folder(key: string, version: string): string {
    if (!KEY.test(key) || !VERSION.test(version)) throw invalid('invalid identity');
    return path.join(this.root, key, version);
  }

  async initialize(installed: readonly { key: string; version: string }[]): Promise<void> {
    await rm(this.staging, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const versions = new Map<string, string>(installed.map((item) => [item.key, item.version]));
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !KEY.test(entry.name)) continue;
      const kept = versions.get(entry.name);
      const folder = path.join(this.root, entry.name);
      if (kept === undefined) {
        await rm(folder, { recursive: true, force: true });
        continue;
      }
      for (const version of await readdir(folder)) {
        if (version !== kept && VERSION.test(version)) {
          await rm(path.join(folder, version), { recursive: true, force: true });
        }
      }
    }
  }

  async stagingFile(): Promise<string> {
    await mkdir(this.staging, { recursive: true, mode: 0o700 });
    return path.join(this.staging, `${randomUUID()}.vsix`);
  }

  async extract(vsix: string): Promise<{ folder: string; manifest: string }> {
    const folder = path.join(this.staging, randomUUID());
    await mkdir(folder, { recursive: true, mode: 0o700 });
    try {
      await this.unzip(vsix, folder);
      const manifest = await readFile(path.join(folder, 'package.json'), 'utf8').catch(() => {
        throw invalid('no extension/package.json');
      });
      return { folder, manifest };
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
  }

  private async unzip(vsix: string, folder: string): Promise<void> {
    const zip = await openZip(vsix);
    const { limits } = this;
    let entries = 0;
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => {
        try {
          zip.close();
        } catch {
          // Already closed.
        }
        reject(error instanceof AtlasError ? error : invalid('unreadable entry'));
      };
      zip.on('error', fail);
      zip.on('end', resolve);
      zip.on('entry', (entry: Entry) => {
        entries += 1;
        if (entries > limits.entries) {
          fail(invalid('too many entries'));
          return;
        }
        void this.writeEntry(
          zip,
          entry,
          folder,
          () => {
            if (entry.uncompressedSize > limits.fileBytes) {
              throw new AtlasError('EXTENSION_PACKAGE_TOO_LARGE');
            }
            if (
              entry.uncompressedSize > 1024 * 1024 &&
              entry.uncompressedSize > entry.compressedSize * limits.ratio
            ) {
              throw invalid('suspicious compression ratio');
            }
          },
          (bytes) => {
            total += bytes;
            if (total > limits.totalBytes) throw new AtlasError('EXTENSION_PACKAGE_TOO_LARGE');
          },
        ).then(() => zip.readEntry(), fail);
      });
      zip.readEntry();
    });
  }

  private async writeEntry(
    zip: ZipFile,
    entry: Entry,
    folder: string,
    check: () => void,
    count: (bytes: number) => void,
  ): Promise<void> {
    const relative = entryPath(entry.fileName);
    if (relative === null || relative === '') return; // outside extension/ or a folder
    check();
    if (((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK) {
      throw invalid('symbolic link');
    }
    if (entry.isEncrypted()) throw invalid('encrypted entry');
    const target = path.resolve(folder, relative);
    if (!target.startsWith(folder + path.sep)) throw invalid('entry outside the package');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
      zip.openReadStream(entry, (error, readable) =>
        error || !readable ? reject(invalid('unreadable entry')) : resolve(readable),
      ),
    );
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          count(chunk.length);
          callback(null, chunk);
        } catch (error) {
          callback(error as Error);
        }
      },
    });
    // `wx`: two entries that name the same file (or differ only in case) are refused.
    const handle = await open(target, 'wx', 0o600).catch(() => {
      throw invalid('duplicate entry');
    });
    await pipeline(stream, counter, handle.createWriteStream());
  }

  async commit(folder: string, key: string, version: string): Promise<void> {
    const target = this.folder(key, version);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const replaced = path.join(this.staging, `${randomUUID()}-replaced`);
    const existed = await stat(target).then(
      () => true,
      () => false,
    );
    if (existed) await rename(target, replaced);
    try {
      await rename(folder, target);
    } catch (error) {
      if (existed) await rename(replaced, target).catch(() => undefined);
      throw error;
    }
    if (existed) await rm(replaced, { recursive: true, force: true });
  }

  async remove(key: string, version: string): Promise<void> {
    await rm(this.folder(key, version), { recursive: true, force: true });
    // The extension folder goes when its last version does.
    await rmdir(path.join(this.root, key)).catch(() => undefined);
  }

  async discard(target: string): Promise<void> {
    if (!path.resolve(target).startsWith(this.staging + path.sep)) return;
    await rm(target, { recursive: true, force: true });
  }

  async exists(key: string, version: string): Promise<boolean> {
    try {
      return (await stat(path.join(this.folder(key, version), 'package.json'))).isFile();
    } catch {
      return false;
    }
  }

  async read(
    key: string,
    version: string,
    relativePath: string,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const unavailable = () => new AtlasError('EXTENSION_CONTRIBUTION_UNAVAILABLE');
    const base = this.folder(key, version);
    let real: string;
    let realBase: string;
    try {
      realBase = await realpath(base);
      real = await realpath(path.resolve(base, relativePath));
    } catch {
      throw unavailable();
    }
    if (!real.startsWith(realBase + path.sep)) throw unavailable();
    const info = await stat(real).catch(() => null);
    if (info === null || !info.isFile() || info.size > maxBytes) throw unavailable();
    return readFile(real);
  }
}
