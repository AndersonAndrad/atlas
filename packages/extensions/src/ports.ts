import type {
  ExtensionCompatibility,
  ExtensionDiagnostic,
  ExtensionSearchResult,
} from '@atlas/contracts';
import type { ExtensionManifest } from './manifest.js';

export interface RegistrySearchQuery {
  query: string;
  category: string | null;
  publisher: string | null;
  offset: number;
  size: number;
}

/** One extension version as the registry describes it, already checked and bounded. */
export interface RegistryExtension {
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  verified: boolean;
  deprecated: boolean;
  preRelease: boolean;
  publishedAt: string | null;
  /** Newest first. */
  versions: string[];
  categories: string[];
  license: string | null;
  homepage: string | null;
  repository: string | null;
  /** Platform of this description's files. */
  targetPlatform: string;
  /** Platforms with a package of this version. */
  platforms: string[];
  dependencies: string[];
  packMembers: string[];
  files: { download: string; manifest: string | null; sha256: string | null };
}

/** Open VSX (FR-1501). Failures are EXTENSION_REGISTRY_* or EXTENSION_NOT_FOUND errors. */
export interface ExtensionRegistry {
  search(query: RegistrySearchQuery): Promise<ExtensionSearchResult>;
  /**
   * A version (null: latest) for a platform (null: the registry's default). `fresh` skips
   * the metadata cache, for installs and update checks the user asked for.
   */
  extension(
    namespace: string,
    name: string,
    version: string | null,
    platform: string | null,
    fresh?: boolean,
  ): Promise<RegistryExtension>;
  /** A small text file of the registry, such as a published `package.json`. */
  text(url: string, maxBytes: number): Promise<string>;
  /** The published SHA-256 of a package, or null when the registry has none. */
  checksum(url: string): Promise<string | null>;
  /** Downloads a package to `destination`; returns its SHA-256 (hex). */
  download(url: string, destination: string, maxBytes: number): Promise<{ sha256: string }>;
}

/** Package files under the application data folder (FR-1503, FR-1506). */
export interface ExtensionPackages {
  /** Removes leftovers of interrupted installs and versions nothing refers to. */
  initialize(installed: readonly { key: string; version: string }[]): Promise<void>;
  /** A new path in the staging folder for a download. */
  stagingFile(): Promise<string>;
  /**
   * Extracts the `extension/` folder of a VSIX into a new staging folder, refusing unsafe
   * paths, links and oversized content. Runs no extension code.
   */
  extract(vsix: string): Promise<{ folder: string; manifest: string }>;
  /** Moves an extracted folder to `<key>/<version>`, replacing that version if present. */
  commit(folder: string, key: string, version: string): Promise<void>;
  remove(key: string, version: string): Promise<void>;
  /** Removes a staging file or folder. */
  discard(path: string): Promise<void>;
  exists(key: string, version: string): Promise<boolean>;
  /** A file of an installed version, which must stay inside its folder. */
  read(key: string, version: string, relativePath: string, maxBytes: number): Promise<Uint8Array>;
}

export interface StoredExtension {
  key: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  platform: string;
  license: string | null;
  manifest: ExtensionManifest;
  compatibility: ExtensionCompatibility;
  enabled: boolean;
  sha256: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface ProjectExtensionState {
  key: string;
  projectId: string;
  enabled: boolean;
}

export type NewExtensionDiagnostic = Omit<ExtensionDiagnostic, 'id'>;

/** SQLite storage (migration v15). */
export interface ExtensionRepository {
  list(): StoredExtension[];
  find(key: string): StoredExtension | null;
  /** Inserts or replaces; project overrides are kept. */
  save(extension: StoredExtension): void;
  remove(key: string): void;
  setEnabled(key: string, enabled: boolean, at: string): void;
  projectStates(): ProjectExtensionState[];
  /** A null `enabled` removes the override. */
  setProjectState(key: string, projectId: string, enabled: boolean | null): void;
  /** Appends and keeps only the newest `keep` diagnostics of that extension. */
  addDiagnostic(diagnostic: NewExtensionDiagnostic, keep: number): void;
  /** Newest first. */
  diagnostics(key: string, limit: number): ExtensionDiagnostic[];
  diagnosticCounts(): Map<string, number>;
  clearDiagnostics(key: string): void;
}
