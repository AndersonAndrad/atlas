import { createHash } from 'node:crypto';
import {
  ContributionsQuerySchema,
  ExtensionDetailsSchema,
  ExtensionIdSchema,
  ExtensionSearchSchema,
  ExtensionThemeKeySchema,
  GrammarRefSchema,
  IconRefSchema,
  InstallExtensionSchema,
  LanguageConfigurationRefSchema,
  ListExtensionsSchema,
  ReportExtensionProblemSchema,
  SetExtensionEnabledSchema,
  SnippetsRefSchema,
  extensionKey,
  parseInput,
  type ExtensionContributions,
  type ExtensionDiagnostic,
  type ExtensionSearchResult,
  type ExtensionUpdate,
  type ExtensionUpdateCheck,
  type GrammarSource,
  type InstalledExtension,
  type RegistryExtensionDetails,
  type ResolvedColorTheme,
  type ResolvedIconTheme,
  type ResolvedSnippets,
} from '@atlas/contracts';
import { AtlasError, describeError, type Logger } from '@atlas/shared';
import { evaluateCompatibility, type TestedExtension } from './compatibility.js';
import { declarationsOf } from './declarations.js';
import { manifestKey, parseManifest, type ExtensionManifest } from './manifest.js';
import type {
  ExtensionPackages,
  ExtensionRegistry,
  ExtensionRepository,
  RegistryExtension,
  StoredExtension,
} from './ports.js';
import {
  ICON_FILE_MAX_BYTES,
  iconDataUri,
  readGrammar,
  resolveColorTheme,
  resolveIconTheme,
  resolveLanguageConfiguration,
  resolveSnippets,
  type ExtensionFileReader,
  type IconThemeData,
} from './resolvers.js';
import { compareVersions } from './versions.js';

/** Largest VSIX downloaded (FR-1503). */
export const PACKAGE_MAX_BYTES = 100 * 1024 * 1024;
const MANIFEST_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024;
const DIAGNOSTICS_KEPT = 50;
const UPDATE_CHECKS_AT_ONCE = 4;
const ICON_THEMES_CACHED = 4;

export interface ExtensionsServiceOptions {
  repository: ExtensionRepository;
  registry: ExtensionRegistry;
  packages: ExtensionPackages;
  projectExists: (projectId: string) => Promise<boolean>;
  /** The Open VSX target platform of this machine, e.g. `darwin-arm64`. */
  platform: string;
  tested: readonly TestedExtension[];
  clock: { now(): Date };
  logger: Logger;
}

function splitId(id: string): [string, string] {
  const dot = id.indexOf('.');
  return [id.slice(0, dot), id.slice(dot + 1)];
}

function splitThemeKey(key: string): [string, string] {
  const slash = key.indexOf('/');
  return [extensionKey(key.slice(0, slash)), key.slice(slash + 1)];
}

const errorCode = (error: unknown) => (error instanceof AtlasError ? error.code : 'INTERNAL_ERROR');
const errorText = (error: unknown) =>
  error instanceof AtlasError ? error.userMessage : 'An unexpected error occurred.';

/**
 * Extensions Hub (SDD-015 Milestone A): discovery through Open VSX, safe installation of
 * VSIX packages, global and per-project enablement, and the declarative contributions of
 * enabled extensions. It never loads or runs extension code.
 */
export class ExtensionsService {
  /** Extensions with an install, update or removal running. */
  private readonly busy = new Set<string>();
  private readonly iconThemes = new Map<string, IconThemeData>();

  constructor(private readonly options: ExtensionsServiceOptions) {}

  private now(): string {
    return this.options.clock.now().toISOString();
  }

  async initialize(): Promise<void> {
    const installed = this.options.repository
      .list()
      .map((extension) => ({ key: extension.key, version: extension.version }));
    await this.options.packages.initialize(installed);
  }

  // --- Registry ------------------------------------------------------------

  async search(input: unknown): Promise<ExtensionSearchResult> {
    const query = parseInput(ExtensionSearchSchema, input);
    return this.options.registry.search(query);
  }

  /** The registry description for this machine's platform, or the universal package. */
  private async forPlatform(
    namespace: string,
    name: string,
    version: string | null,
    fresh = false,
  ): Promise<{ info: RegistryExtension; platform: string | null }> {
    const { registry, platform } = this.options;
    const info = await registry.extension(namespace, name, version, null, fresh);
    const chosen = info.platforms.includes(platform)
      ? platform
      : info.platforms.includes('universal') || info.platforms.length === 0
        ? 'universal'
        : null;
    if (chosen === null || chosen === info.targetPlatform) return { info, platform: chosen };
    return {
      info: await registry.extension(namespace, name, info.version, chosen, fresh),
      platform: chosen,
    };
  }

  private async publishedManifest(info: RegistryExtension): Promise<ExtensionManifest | null> {
    if (info.files.manifest === null) return null;
    try {
      return parseManifest(
        await this.options.registry.text(info.files.manifest, MANIFEST_DOWNLOAD_MAX_BYTES),
      );
    } catch (error) {
      if (error instanceof AtlasError && error.code === 'EXTENSION_PACKAGE_INVALID') return null;
      throw error;
    }
  }

  async details(input: unknown): Promise<RegistryExtensionDetails> {
    const { id, version } = parseInput(ExtensionDetailsSchema, input);
    const [namespace, name] = splitId(id);
    const { info, platform } = await this.forPlatform(namespace, name, version);
    const manifest = await this.publishedManifest(info);
    const installedKeys = new Set(this.options.repository.list().map((item) => item.key));
    const installed = this.options.repository.find(extensionKey(id));
    const dependency = (dependencyId: string) => ({
      id: dependencyId,
      installed: installedKeys.has(extensionKey(dependencyId)),
    });
    return {
      id: `${info.namespace}.${info.name}`,
      namespace: info.namespace,
      name: info.name,
      displayName: info.displayName,
      description: info.description,
      version: info.version,
      verified: info.verified,
      deprecated: info.deprecated,
      publishedAt: info.publishedAt,
      versions: info.versions,
      categories: info.categories,
      license: info.license,
      homepage: info.homepage,
      repository: info.repository,
      platforms: info.platforms,
      platform,
      dependencies: info.dependencies.map(dependency),
      packMembers: info.packMembers.map(dependency),
      preRelease: info.preRelease,
      compatibility:
        manifest === null
          ? {
              level: 'UNTESTED',
              executable: false,
              working: [],
              unsupported: [],
              notes: ['The registry did not publish this version’s manifest.'],
              tested: null,
            }
          : evaluateCompatibility(manifest, this.options.tested, this.options.platform),
      installed:
        installed === null ? null : { version: installed.version, enabled: installed.enabled },
    };
  }

  // --- Lifecycle -----------------------------------------------------------

  private async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) throw new AtlasError('EXTENSION_BUSY');
    this.busy.add(key);
    try {
      return await action();
    } finally {
      this.busy.delete(key);
    }
  }

  private recordFailure(key: string, operation: string, error: unknown): void {
    this.options.logger.warn(`Extension ${operation} failed`, {
      extension: key,
      code: errorCode(error),
      error: error instanceof AtlasError ? undefined : describeError(error),
    });
    try {
      this.options.repository.addDiagnostic(
        {
          extensionId: key,
          level: 'error',
          code: errorCode(error),
          message: `${operation[0]?.toUpperCase()}${operation.slice(1)} failed: ${errorText(error)}`,
          createdAt: this.now(),
        },
        DIAGNOSTICS_KEPT,
      );
    } catch (caught) {
      this.options.logger.warn('Could not record an extension diagnostic', {
        error: describeError(caught),
      });
    }
  }

  /**
   * Installs a version (null: the latest), or updates to it. The previous version stays
   * until the new one is extracted, checked and recorded (FR-1503, FR-1504).
   */
  async install(input: unknown): Promise<InstalledExtension> {
    const { id, version } = parseInput(InstallExtensionSchema, input);
    const key = extensionKey(id);
    return this.exclusive(key, async () => {
      try {
        return await this.installNow(key, id, version);
      } catch (error) {
        this.recordFailure(key, 'installation', error);
        throw error;
      }
    });
  }

  private async installNow(
    key: string,
    id: string,
    version: string | null,
  ): Promise<InstalledExtension> {
    const { registry, packages, repository } = this.options;
    const [namespace, name] = splitId(id);
    const { info, platform } = await this.forPlatform(namespace, name, version, true);
    if (platform === null) throw new AtlasError('EXTENSION_PLATFORM_UNSUPPORTED');
    const published = await this.publishedManifest(info);
    if (
      published !== null &&
      evaluateCompatibility(published, this.options.tested, this.options.platform).level ===
        'UNSUPPORTED'
    ) {
      throw new AtlasError('EXTENSION_UNSUPPORTED');
    }

    const download = await packages.stagingFile();
    let folder: string | null = null;
    try {
      const { sha256 } = await registry.download(info.files.download, download, PACKAGE_MAX_BYTES);
      const expected =
        info.files.sha256 === null ? null : await registry.checksum(info.files.sha256);
      if (expected !== null && expected !== sha256) {
        throw new AtlasError('EXTENSION_CHECKSUM_MISMATCH');
      }
      const extracted = await packages.extract(download);
      folder = extracted.folder;
      const manifest = parseManifest(extracted.manifest);
      if (manifestKey(manifest) !== key || manifest.version !== info.version) {
        throw new AtlasError('EXTENSION_IDENTITY_MISMATCH', 'The package identity differs.', {
          details: { expected: `${key}@${info.version}` },
        });
      }
      const compatibility = evaluateCompatibility(
        manifest,
        this.options.tested,
        this.options.platform,
      );
      if (compatibility.level === 'UNSUPPORTED') throw new AtlasError('EXTENSION_UNSUPPORTED');

      const previous = repository.find(key);
      await packages.commit(folder, key, manifest.version);
      folder = null;
      const now = this.now();
      repository.save({
        key,
        namespace: manifest.publisher,
        name: manifest.name,
        displayName: manifest.displayName,
        description: manifest.description,
        version: manifest.version,
        platform,
        license: manifest.license ?? info.license,
        manifest,
        compatibility,
        enabled: previous?.enabled ?? true,
        sha256,
        installedAt: previous?.installedAt ?? now,
        updatedAt: now,
      });
      this.iconThemes.clear();
      if (expected === null) {
        repository.addDiagnostic(
          {
            extensionId: key,
            level: 'warning',
            code: 'NO_CHECKSUM',
            message: 'The registry published no checksum for this package.',
            createdAt: now,
          },
          DIAGNOSTICS_KEPT,
        );
      }
      if (previous !== null && previous.version !== manifest.version) {
        await packages.remove(key, previous.version).catch((error: unknown) =>
          this.options.logger.warn('Could not remove the previous extension version', {
            extension: key,
            error: describeError(error),
          }),
        );
      }
      this.options.logger.info('Extension installed', {
        extension: key,
        version: manifest.version,
        platform,
        previous: previous?.version ?? null,
      });
      return this.describe(key, null);
    } finally {
      await packages.discard(download).catch(() => undefined);
      if (folder !== null) await packages.discard(folder).catch(() => undefined);
    }
  }

  async uninstall(input: unknown): Promise<void> {
    const key = extensionKey(parseInput(ExtensionIdSchema, input));
    await this.exclusive(key, async () => {
      const { repository, packages } = this.options;
      const extension = repository.find(key);
      if (extension === null) throw new AtlasError('EXTENSION_NOT_INSTALLED');
      const dependents = repository
        .list()
        .filter((item) =>
          item.manifest.extensionDependencies.some(
            (dependency) => extensionKey(dependency) === key,
          ),
        );
      if (dependents.length > 0) {
        throw new AtlasError('EXTENSION_REQUIRED_BY_OTHERS', 'Other extensions depend on it.', {
          issues: dependents.map((item) => ({ field: 'dependents', message: item.displayName })),
        });
      }
      repository.remove(key);
      repository.clearDiagnostics(key);
      this.iconThemes.clear();
      try {
        await packages.remove(key, extension.version);
      } catch (error) {
        // Recorded as gone; the leftover folder is removed at the next start.
        this.options.logger.warn('Could not remove extension files', {
          extension: key,
          error: describeError(error),
        });
      }
      this.options.logger.info('Extension uninstalled', { extension: key });
    });
  }

  async setEnabled(input: unknown): Promise<InstalledExtension> {
    const { id, projectId, enabled } = parseInput(SetExtensionEnabledSchema, input);
    const key = extensionKey(id);
    const { repository } = this.options;
    if (repository.find(key) === null) throw new AtlasError('EXTENSION_NOT_INSTALLED');
    if (projectId === null) {
      repository.setEnabled(key, enabled as boolean, this.now());
    } else {
      if (!(await this.options.projectExists(projectId))) {
        throw new AtlasError('PROJECT_NOT_FOUND');
      }
      repository.setProjectState(key, projectId, enabled);
    }
    return this.describe(key, projectId);
  }

  // --- Installed extensions ------------------------------------------------

  private async describeAll(projectId: string | null): Promise<InstalledExtension[]> {
    const { repository, packages } = this.options;
    const extensions = repository.list();
    const keys = new Set(extensions.map((item) => item.key));
    const states = repository.projectStates();
    const counts = repository.diagnosticCounts();
    return Promise.all(
      extensions.map(async (extension) => {
        const projects = states
          .filter((state) => state.key === extension.key)
          .map(({ projectId: id, enabled }) => ({ projectId: id, enabled }));
        const override = projects.find((state) => state.projectId === projectId);
        const declared = declarationsOf(extension.manifest);
        return {
          id: `${extension.namespace}.${extension.name}`,
          namespace: extension.namespace,
          name: extension.name,
          displayName: extension.displayName,
          description: extension.description,
          version: extension.version,
          platform: extension.platform,
          license: extension.license,
          compatibility: extension.compatibility,
          enabled: extension.enabled,
          projects,
          activeHere: override?.enabled ?? extension.enabled,
          contributes: {
            themes: declared.themes.length,
            iconThemes: declared.iconThemes.length,
            grammars: declared.grammars.length,
            languages: declared.languages.length,
            snippets: declared.snippets.length,
          },
          dependencies: extension.manifest.extensionDependencies,
          missingDependencies: extension.manifest.extensionDependencies.filter(
            (dependency) => !keys.has(extensionKey(dependency)),
          ),
          broken: !(await packages.exists(extension.key, extension.version)),
          problems: counts.get(extension.key) ?? 0,
          installedAt: extension.installedAt,
          updatedAt: extension.updatedAt,
        };
      }),
    );
  }

  private async describe(key: string, projectId: string | null): Promise<InstalledExtension> {
    const found = (await this.describeAll(projectId)).find((item) => extensionKey(item.id) === key);
    if (found === undefined) throw new AtlasError('EXTENSION_NOT_INSTALLED');
    return found;
  }

  async list(input: unknown): Promise<InstalledExtension[]> {
    const { projectId } = parseInput(ListExtensionsSchema, input);
    const extensions = await this.describeAll(projectId);
    return extensions.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** Asked by the user only; ATLAS never polls the registry (§18, FR-1535). */
  async checkUpdates(): Promise<ExtensionUpdateCheck> {
    const installed = this.options.repository.list();
    const updates: ExtensionUpdate[] = [];
    const failed: string[] = [];
    const queue = [...installed];
    const worker = async () => {
      for (let extension = queue.shift(); extension; extension = queue.shift()) {
        const id = `${extension.namespace}.${extension.name}`;
        try {
          const { info, platform } = await this.forPlatform(
            extension.namespace,
            extension.name,
            null,
            true,
          );
          if (platform === null || compareVersions(info.version, extension.version) <= 0) continue;
          const manifest = await this.publishedManifest(info);
          updates.push({
            id,
            installedVersion: extension.version,
            latestVersion: info.version,
            compatibility:
              manifest === null
                ? { ...extension.compatibility, level: 'UNTESTED', tested: null }
                : evaluateCompatibility(manifest, this.options.tested, this.options.platform),
          });
        } catch (error) {
          failed.push(id);
          this.options.logger.warn('Extension update check failed', {
            extension: extension.key,
            code: errorCode(error),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: UPDATE_CHECKS_AT_ONCE }, worker));
    updates.sort((a, b) => a.id.localeCompare(b.id));
    return { updates, failed: failed.sort(), checkedAt: this.now() };
  }

  // --- Contributions -------------------------------------------------------

  /** Installed, enabled for the project (or globally) and with its files present. */
  private async active(projectId: string | null): Promise<StoredExtension[]> {
    const { repository, packages } = this.options;
    const overrides = new Map(
      repository
        .projectStates()
        .filter((state) => state.projectId === projectId)
        .map((state) => [state.key, state.enabled]),
    );
    const enabled = repository
      .list()
      .filter((extension) => overrides.get(extension.key) ?? extension.enabled);
    const present = await Promise.all(
      enabled.map((extension) => packages.exists(extension.key, extension.version)),
    );
    return enabled.filter((_, index) => present[index]);
  }

  async contributions(input: unknown): Promise<ExtensionContributions> {
    const { projectId } = parseInput(ContributionsQuerySchema, input);
    const active = await this.active(projectId);
    const result: Omit<ExtensionContributions, 'revision'> = {
      languages: [],
      grammars: [],
      themes: [],
      iconThemes: [],
      snippets: [],
    };
    for (const extension of active) {
      const declared = declarationsOf(extension.manifest);
      const extensionId = extension.key;
      for (const language of declared.languages) {
        const { configuration, ...rest } = language;
        result.languages.push({ extensionId, ...rest, hasConfiguration: configuration !== null });
      }
      for (const grammar of declared.grammars) {
        result.grammars.push({
          extensionId,
          language: grammar.language,
          scopeName: grammar.scopeName,
          embeddedLanguages: grammar.embeddedLanguages,
          tokenTypes: grammar.tokenTypes,
          injectTo: grammar.injectTo,
        });
      }
      for (const theme of declared.themes) {
        if (/\.(tmTheme|plist|xml)$/i.test(theme.path)) continue;
        result.themes.push({
          key: `${extensionId}/${theme.id}`,
          extensionId,
          label: theme.label,
          base: theme.base,
        });
      }
      for (const theme of declared.iconThemes) {
        result.iconThemes.push({
          key: `${extensionId}/${theme.id}`,
          extensionId,
          label: theme.label,
        });
      }
      for (const file of declared.snippets) {
        result.snippets.push({ extensionId, index: file.index, language: file.language });
      }
    }
    const revision = createHash('sha256')
      .update(JSON.stringify(active.map((extension) => [extension.key, extension.version])))
      .digest('hex')
      .slice(0, 16);
    return { revision, ...result };
  }

  private installed(key: string): StoredExtension {
    const extension = this.options.repository.find(key);
    if (extension === null) throw new AtlasError('EXTENSION_NOT_INSTALLED');
    return extension;
  }

  private reader(extension: StoredExtension): ExtensionFileReader {
    return (relativePath, maxBytes) =>
      this.options.packages.read(extension.key, extension.version, relativePath, maxBytes);
  }

  async grammar(input: unknown): Promise<GrammarSource> {
    const ref = parseInput(GrammarRefSchema, input);
    const extension = this.installed(extensionKey(ref.extensionId));
    const grammar = declarationsOf(extension.manifest).grammars.find(
      (item) => item.scopeName === ref.scopeName,
    );
    if (grammar === undefined) throw new AtlasError('EXTENSION_CONTRIBUTION_UNAVAILABLE');
    return readGrammar(this.reader(extension), grammar.path);
  }

  async theme(input: unknown): Promise<ResolvedColorTheme> {
    const key = parseInput(ExtensionThemeKeySchema, input);
    const [extensionId, themeId] = splitThemeKey(key);
    const extension = this.installed(extensionId);
    const theme = declarationsOf(extension.manifest).themes.find((item) => item.id === themeId);
    if (theme === undefined) throw new AtlasError('EXTENSION_CONTRIBUTION_UNAVAILABLE');
    return resolveColorTheme(this.reader(extension), {
      key: `${extensionId}/${theme.id}`,
      label: theme.label,
      base: theme.base,
      path: theme.path,
    });
  }

  async snippets(input: unknown): Promise<ResolvedSnippets> {
    const ref = parseInput(SnippetsRefSchema, input);
    const extension = this.installed(extensionKey(ref.extensionId));
    const file = declarationsOf(extension.manifest).snippets.find(
      (item) => item.index === ref.index,
    );
    if (file === undefined) throw new AtlasError('EXTENSION_CONTRIBUTION_UNAVAILABLE');
    return resolveSnippets(this.reader(extension), file);
  }

  async languageConfiguration(input: unknown): Promise<Record<string, unknown>> {
    const ref = parseInput(LanguageConfigurationRefSchema, input);
    const extension = this.installed(extensionKey(ref.extensionId));
    const language = declarationsOf(extension.manifest).languages.find(
      (item) => item.id === ref.language && item.configuration !== null,
    );
    if (language?.configuration == null) {
      throw new AtlasError('EXTENSION_CONTRIBUTION_UNAVAILABLE');
    }
    return resolveLanguageConfiguration(this.reader(extension), language.configuration);
  }

  private async iconThemeData(key: string): Promise<IconThemeData> {
    const [extensionId, themeId] = splitThemeKey(key);
    const extension = this.installed(extensionId);
    const cacheKey = `${extensionId}@${extension.version}/${themeId}`;
    const cached = this.iconThemes.get(cacheKey);
    if (cached !== undefined) return cached;
    const theme = declarationsOf(extension.manifest).iconThemes.find((item) => item.id === themeId);
    if (theme === undefined) throw new AtlasError('EXTENSION_CONTRIBUTION_UNAVAILABLE');
    const data = await resolveIconTheme(this.reader(extension), {
      key: `${extensionId}/${theme.id}`,
      label: theme.label,
      path: theme.path,
    });
    if (this.iconThemes.size >= ICON_THEMES_CACHED) this.iconThemes.clear();
    this.iconThemes.set(cacheKey, data);
    return data;
  }

  async iconTheme(input: unknown): Promise<ResolvedIconTheme> {
    return (await this.iconThemeData(parseInput(ExtensionThemeKeySchema, input))).theme;
  }

  async icon(input: unknown): Promise<string> {
    const ref = parseInput(IconRefSchema, input);
    const data = await this.iconThemeData(ref.theme);
    const path = data.imagePaths.get(ref.iconId);
    if (path === undefined) throw new AtlasError('EXTENSION_CONTRIBUTION_UNAVAILABLE');
    const extension = this.installed(splitThemeKey(ref.theme)[0]);
    return iconDataUri(path, await this.reader(extension)(path, ICON_FILE_MAX_BYTES));
  }

  // --- Diagnostics (FR-1515) -------------------------------------------------

  diagnostics(input: unknown): ExtensionDiagnostic[] {
    const key = extensionKey(parseInput(ExtensionIdSchema, input));
    return this.options.repository.diagnostics(key, DIAGNOSTICS_KEPT);
  }

  clearDiagnostics(input: unknown): void {
    const key = extensionKey(parseInput(ExtensionIdSchema, input));
    this.options.repository.clearDiagnostics(key);
  }

  /** A contribution the editor could not apply. Repeats of the latest problem are dropped. */
  reportProblem(input: unknown): void {
    const problem = parseInput(ReportExtensionProblemSchema, input);
    const key = extensionKey(problem.extensionId);
    this.installed(key);
    // eslint-disable-next-line no-control-regex
    const message = problem.message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    const latest = this.options.repository.diagnostics(key, 1)[0];
    if (latest?.code === problem.code && latest.message === message) return;
    this.options.repository.addDiagnostic(
      {
        extensionId: key,
        level: 'warning',
        code: problem.code,
        message: message || 'The editor could not apply this contribution.',
        createdAt: this.now(),
      },
      DIAGNOSTICS_KEPT,
    );
  }
}
