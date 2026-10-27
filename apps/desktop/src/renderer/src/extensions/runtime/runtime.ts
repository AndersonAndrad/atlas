import type {
  ContributedGrammar,
  EditorPreferences,
  ExtensionContributions,
  ResolvedColorTheme,
  ResolvedIconTheme,
} from '@atlas/contracts';
import type * as MonacoApi from 'monaco-editor';
import { api, errorMessage, unwrap } from '@/api';
import { subscribeEditorPreferences } from '@/editor/hooks/useEditorPreferences';
import type { Monaco } from '@/editor/monaco/monaco';
import { toLanguageConfiguration } from './language-configuration';
import { registerSnippets, type SnippetSource } from './snippets';
import { TextMateSupport } from './textmate';
import { BUILT_IN_THEMES, builtInRawTheme, contributedRawTheme, monacoTheme } from './themes';

type ThemePreferences = Pick<EditorPreferences, 'theme' | 'colorTheme' | 'iconTheme'>;
type ProblemCode =
  | 'GRAMMAR_FAILED'
  | 'THEME_FAILED'
  | 'SNIPPETS_FAILED'
  | 'LANGUAGE_CONFIGURATION_FAILED'
  | 'ICON_THEME_FAILED';

export interface RuntimeSnapshot {
  contributions: ExtensionContributions | null;
  /** The file icon theme in use, or null for ATLAS's own icons. */
  iconTheme: ResolvedIconTheme | null;
  /** Contributions revision the icon theme was loaded for; it keys cached icons. */
  iconRevision: string | null;
}

const describe = (error: unknown) =>
  error instanceof Error && !('code' in error) ? error.message : errorMessage(error);

/**
 * Applies the declarative contributions of the extensions enabled for the current project
 * to Monaco (SDD-015 FR-1507–FR-1511): languages, language configuration, snippets,
 * TextMate grammars and color themes; and keeps the file icon theme for the explorer.
 * Registrations are global to Monaco, so they follow the project shown in the editor.
 */
class ExtensionRuntime {
  private monaco: Monaco | null = null;
  private projectId: string | null | undefined;
  private contributions: ExtensionContributions | null = null;
  private appliedRevision: string | null = null;
  private registrations: MonacoApi.IDisposable[] = [];
  private grammarProviders: MonacoApi.IDisposable[] = [];
  private readonly registeredLanguages = new Set<string>();
  private textmate: TextMateSupport | null = null;
  private readonly themes = new Map<string, Promise<ResolvedColorTheme>>();
  private preferences: ThemePreferences = { theme: 'dark', colorTheme: null, iconTheme: null };
  private themeName: string = BUILT_IN_THEMES.dark.name;
  private themeGeneration = 0;
  private snapshot: RuntimeSnapshot = { contributions: null, iconTheme: null, iconRevision: null };
  private readonly listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private unsubscribePreferences: (() => void) | null = null;

  // --- React bindings ------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RuntimeSnapshot => this.snapshot;

  private publish(changes: Partial<RuntimeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }

  /** The Monaco theme to create editors with. */
  currentThemeName(): string {
    return this.themeName;
  }

  // --- Inputs --------------------------------------------------------------

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch(() => undefined);
    return this.queue;
  }

  attach(monaco: Monaco): void {
    if (this.monaco === monaco) return;
    this.monaco = monaco;
    this.unsubscribePreferences ??= subscribeEditorPreferences((next) => this.setPreferences(next));
    if (this.projectId === undefined) void this.setProject(null);
    else void this.enqueue(() => this.apply());
  }

  /** The project whose enabled extensions apply (null: only globally enabled ones). */
  setProject(projectId: string | null): Promise<void> {
    if (projectId === this.projectId && this.contributions !== null) return this.queue;
    this.projectId = projectId;
    return this.refresh();
  }

  /** Reloads after extensions were installed, removed, enabled or disabled. */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      this.themes.clear();
      try {
        this.contributions = await unwrap(
          api().extensions.contributions({ projectId: this.projectId ?? null }),
        );
      } catch {
        // Extensions are optional: without them the editor keeps its own features.
        this.contributions = null;
      }
      this.publish({ contributions: this.contributions });
      await this.loadIconTheme();
      await this.apply();
    });
  }

  setPreferences(preferences: ThemePreferences): void {
    const previous = this.preferences;
    this.preferences = {
      theme: preferences.theme,
      colorTheme: preferences.colorTheme,
      iconTheme: preferences.iconTheme,
    };
    if (previous.iconTheme !== preferences.iconTheme) void this.enqueue(() => this.loadIconTheme());
    if (previous.theme !== preferences.theme || previous.colorTheme !== preferences.colorTheme) {
      void this.enqueue(() => this.applyTheme());
    }
  }

  // --- Application ---------------------------------------------------------

  private report(extensionId: string, code: ProblemCode, error: unknown): void {
    void api()
      .extensions.reportProblem({ extensionId, code, message: describe(error).slice(0, 300) })
      .catch(() => undefined);
  }

  private async loadIconTheme(): Promise<void> {
    const key = this.preferences.iconTheme;
    const available =
      key !== null && this.contributions?.iconThemes.some((item) => item.key === key);
    if (!available) {
      if (this.snapshot.iconTheme !== null) this.publish({ iconTheme: null, iconRevision: null });
      return;
    }
    // An update of the icon extension changes the revision, so its icons load again.
    const revision = this.contributions?.revision ?? null;
    if (this.snapshot.iconTheme?.key === key && this.snapshot.iconRevision === revision) return;
    try {
      this.publish({
        iconTheme: await unwrap(api().extensions.iconTheme(key)),
        iconRevision: revision,
      });
    } catch (error) {
      this.report(key.slice(0, key.indexOf('/')), 'ICON_THEME_FAILED', error);
      this.publish({ iconTheme: null, iconRevision: null });
    }
  }

  private async apply(): Promise<void> {
    const { monaco, contributions } = this;
    if (monaco === null) return;
    const revision = contributions?.revision ?? 'none';
    if (revision === this.appliedRevision) {
      await this.applyTheme();
      return;
    }
    for (const disposable of [...this.registrations, ...this.grammarProviders])
      disposable.dispose();
    this.registrations = [];
    this.grammarProviders = [];
    this.textmate = null;
    this.appliedRevision = revision;
    if (contributions !== null) {
      this.registerLanguages(monaco, contributions);
      await this.registerLanguageConfigurations(monaco, contributions);
      await this.registerSnippets(monaco, contributions);
      if (contributions.grammars.some((grammar) => grammar.language !== null)) {
        this.textmate = new TextMateSupport({
          monaco,
          grammars: contributions.grammars,
          languageIds: () => monaco.languages.getLanguages().map((language) => language.id),
          loadGrammar: (grammar: ContributedGrammar) =>
            unwrap(
              api().extensions.grammar({
                extensionId: grammar.extensionId,
                scopeName: grammar.scopeName,
              }),
            ),
          onError: (grammar, error) => this.report(grammar.extensionId, 'GRAMMAR_FAILED', error),
        });
      }
    }
    await this.applyTheme();
    this.assignLanguages(monaco, contributions);
  }

  /** Monaco cannot unregister languages: each one is added once per session. */
  private registerLanguages(monaco: Monaco, contributions: ExtensionContributions): void {
    for (const language of contributions.languages) {
      const key = `${language.extensionId}:${language.id}`;
      if (this.registeredLanguages.has(key)) continue;
      this.registeredLanguages.add(key);
      monaco.languages.register({
        id: language.id,
        aliases: language.aliases,
        extensions: language.extensions,
        filenames: language.filenames,
        filenamePatterns: language.filenamePatterns,
        mimetypes: language.mimetypes,
        ...(language.firstLine !== null ? { firstLine: language.firstLine } : {}),
      });
    }
  }

  private async registerLanguageConfigurations(
    monaco: Monaco,
    contributions: ExtensionContributions,
  ): Promise<void> {
    for (const language of contributions.languages.filter((item) => item.hasConfiguration)) {
      try {
        const raw = await unwrap(
          api().extensions.languageConfiguration({
            extensionId: language.extensionId,
            language: language.id,
          }),
        );
        this.registrations.push(
          monaco.languages.setLanguageConfiguration(
            language.id,
            toLanguageConfiguration(raw, monaco),
          ),
        );
      } catch (error) {
        this.report(language.extensionId, 'LANGUAGE_CONFIGURATION_FAILED', error);
      }
    }
  }

  private async registerSnippets(
    monaco: Monaco,
    contributions: ExtensionContributions,
  ): Promise<void> {
    const byLanguage = new Map<string, SnippetSource[]>();
    for (const file of contributions.snippets) {
      try {
        const resolved = await unwrap(
          api().extensions.snippets({ extensionId: file.extensionId, index: file.index }),
        );
        for (const snippet of resolved.snippets) {
          const languages = file.language !== null ? [file.language] : (snippet.scopes ?? ['*']);
          for (const language of languages) {
            const list = byLanguage.get(language) ?? [];
            list.push({ extensionLabel: file.extensionId, snippet });
            byLanguage.set(language, list);
          }
        }
        if (resolved.skipped > 0) {
          this.report(
            file.extensionId,
            'SNIPPETS_FAILED',
            new Error(`${resolved.skipped} snippets use syntax ATLAS does not support.`),
          );
        }
      } catch (error) {
        this.report(file.extensionId, 'SNIPPETS_FAILED', error);
      }
    }
    this.registrations.push(...registerSnippets(monaco, byLanguage));
  }

  private loadTheme(key: string): Promise<ResolvedColorTheme> {
    let theme = this.themes.get(key);
    if (theme === undefined) {
      theme = unwrap(api().extensions.theme(key));
      this.themes.set(key, theme);
      theme.catch(() => this.themes.delete(key));
    }
    return theme;
  }

  private async applyTheme(): Promise<void> {
    const { monaco, contributions, preferences } = this;
    if (monaco === null) return;
    const builtIn = BUILT_IN_THEMES[preferences.theme];
    let contributed: ResolvedColorTheme | null = null;
    const key = preferences.colorTheme;
    if (key !== null && contributions?.themes.some((theme) => theme.key === key)) {
      try {
        contributed = await this.loadTheme(key);
      } catch (error) {
        this.report(key.slice(0, key.indexOf('/')), 'THEME_FAILED', error);
      }
    }
    let textMateRules: MonacoApi.editor.ITokenThemeRule[] = [];
    if (this.textmate !== null) {
      try {
        textMateRules = await this.textmate.setTheme(
          contributed === null
            ? builtInRawTheme(preferences.theme)
            : contributedRawTheme(contributed),
        );
        // Color numbers changed: tokenize again with the new ones.
        for (const disposable of this.grammarProviders) disposable.dispose();
        this.grammarProviders = this.textmate.register();
      } catch (error) {
        const grammar = contributions?.grammars[0];
        if (grammar) this.report(grammar.extensionId, 'GRAMMAR_FAILED', error);
      }
    }
    // Alternating names make Monaco apply a redefined theme.
    this.themeGeneration += 1;
    const family = contributed === null ? builtIn.name : 'atlas-extension-theme';
    const name = `${family}-${this.themeGeneration % 2}`;
    monaco.editor.defineTheme(
      name,
      contributed === null
        ? {
            base: builtIn.base,
            inherit: true,
            rules: textMateRules,
            colors: preferences.theme === 'dark' ? { 'editor.background': builtIn.background } : {},
          }
        : monacoTheme(contributed, textMateRules),
    );
    monaco.editor.setTheme(name);
    this.themeName = name;
  }

  /** Files opened before their language was registered get it now. */
  private assignLanguages(monaco: Monaco, contributions: ExtensionContributions | null): void {
    if (contributions === null || contributions.languages.length === 0) return;
    for (const model of monaco.editor.getModels()) {
      if (model.getLanguageId() !== 'plaintext') continue;
      const name = model.uri.path.slice(model.uri.path.lastIndexOf('/') + 1).toLowerCase();
      const language = contributions.languages.find(
        (item) =>
          item.filenames.some((file) => file.toLowerCase() === name) ||
          item.extensions.some((extension) => name.endsWith(extension.toLowerCase())),
      );
      if (language !== undefined) monaco.editor.setModelLanguage(model, language.id);
    }
  }
}

export const extensionRuntime = new ExtensionRuntime();
