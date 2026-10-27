import type { ContributedGrammar, GrammarSource } from '@atlas/contracts';
import type * as MonacoApi from 'monaco-editor';
import type * as TextMate from 'vscode-textmate';
import type { IGrammar, IRawTheme, Registry, StateStack } from 'vscode-textmate';
import type { Monaco } from '@/editor/monaco/monaco';
import { colorMapRules, tokenName } from './textmate-colors';

/** Time one line may take to tokenize before the rest of it stays uncolored (PLAN-043 R3). */
const LINE_TIME_LIMIT_MS = 50;

const STANDARD_TOKEN_TYPES: Record<string, number> = { other: 0, comment: 1, string: 2, regex: 3 };

let engine: Promise<typeof TextMate> | null = null;

/**
 * Loads vscode-textmate and the Oniguruma regex engine (WebAssembly, PLAN-043 Q1) the
 * first time a contributed grammar is used. The WASM is bundled inline: nothing is fetched.
 */
function loadEngine(): Promise<typeof TextMate> {
  engine ??= (async () => {
    const [textmate, oniguruma, wasm] = await Promise.all([
      import('vscode-textmate'),
      import('vscode-oniguruma'),
      import('vscode-oniguruma/release/onig.wasm?base64'),
    ]);
    const bytes = Uint8Array.from(atob(wasm.default), (char) => char.charCodeAt(0));
    await oniguruma.loadWASM(bytes.buffer);
    return textmate;
  })().catch((error: unknown) => {
    engine = null;
    throw error;
  });
  return engine;
}

class TokenizerState implements MonacoApi.languages.IState {
  constructor(readonly stack: StateStack) {}

  clone(): TokenizerState {
    return new TokenizerState(this.stack.clone());
  }

  equals(other: MonacoApi.languages.IState): boolean {
    return other instanceof TokenizerState && other.stack.equals(this.stack);
  }
}

export interface TextMateOptions {
  monaco: Monaco;
  grammars: readonly ContributedGrammar[];
  /** Monaco language ids, in a stable order, to number embedded languages. */
  languageIds: () => string[];
  loadGrammar: (grammar: ContributedGrammar) => Promise<GrammarSource>;
  onError: (grammar: ContributedGrammar, error: unknown) => void;
}

/**
 * Syntax highlighting from contributed TextMate grammars (FR-1509). Each language gets a
 * lazy tokens provider: the grammar loads when a file of that language is first shown.
 */
export class TextMateSupport {
  private registry: Registry | null = null;
  private theme: IRawTheme | null = null;
  private readonly grammars = new Map<string, Promise<IGrammar | null>>();

  constructor(private readonly options: TextMateOptions) {}

  private async ensureRegistry(): Promise<Registry> {
    if (this.registry !== null) return this.registry;
    const textmate = await loadEngine();
    const oniguruma = await import('vscode-oniguruma');
    const { grammars } = this.options;
    this.registry = new textmate.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
        createOnigString: (text: string) => new oniguruma.OnigString(text),
      }),
      loadGrammar: async (scopeName) => {
        const grammar = grammars.find((item) => item.scopeName === scopeName);
        if (grammar === undefined) return null;
        try {
          const source = await this.options.loadGrammar(grammar);
          return textmate.parseRawGrammar(
            source.content,
            source.format === 'json' ? `${scopeName}.json` : `${scopeName}.tmLanguage`,
          );
        } catch (error) {
          this.options.onError(grammar, error);
          return null;
        }
      },
      getInjections: (scopeName) =>
        grammars.filter((item) => item.injectTo.includes(scopeName)).map((item) => item.scopeName),
    });
    if (this.theme !== null) this.registry.setTheme(this.theme);
    return this.registry;
  }

  /** Sets the token colors; returns the Monaco rules that show them. */
  async setTheme(theme: IRawTheme): Promise<MonacoApi.editor.ITokenThemeRule[]> {
    this.theme = theme;
    const registry = await this.ensureRegistry();
    registry.setTheme(theme);
    return colorMapRules(registry.getColorMap());
  }

  private grammarFor(grammar: ContributedGrammar): Promise<IGrammar | null> {
    let loading = this.grammars.get(grammar.scopeName);
    if (loading === undefined) {
      loading = (async () => {
        const registry = await this.ensureRegistry();
        const ids = this.options.languageIds();
        const number = (language: string) => Math.max(ids.indexOf(language), 0) + 1;
        const embeddedLanguages: Record<string, number> = {};
        for (const [scope, language] of Object.entries(grammar.embeddedLanguages)) {
          embeddedLanguages[scope] = number(language);
        }
        const tokenTypes: Record<string, number> = {};
        for (const [selector, type] of Object.entries(grammar.tokenTypes)) {
          const value = STANDARD_TOKEN_TYPES[type];
          if (value !== undefined) tokenTypes[selector] = value;
        }
        return registry.loadGrammarWithConfiguration(
          grammar.scopeName,
          number(grammar.language ?? ''),
          { embeddedLanguages, tokenTypes },
        );
      })().catch((error: unknown) => {
        this.options.onError(grammar, error);
        return null;
      });
      this.grammars.set(grammar.scopeName, loading);
    }
    return loading;
  }

  /** Registers the tokens providers; disposing them restores Monaco's own tokenizers. */
  register(): MonacoApi.IDisposable[] {
    const { monaco } = this.options;
    const byLanguage = new Map<string, ContributedGrammar>();
    for (const grammar of this.options.grammars) {
      if (grammar.language !== null) byLanguage.set(grammar.language, grammar);
    }
    return [...byLanguage].map(([language, grammar]) =>
      monaco.languages.registerTokensProviderFactory(language, {
        create: async () => {
          const loaded = await this.grammarFor(grammar);
          if (loaded === null) return null;
          const textmate = await loadEngine();
          return {
            getInitialState: () => new TokenizerState(textmate.INITIAL),
            tokenize: (line: string, state: MonacoApi.languages.IState) => {
              const result = loaded.tokenizeLine2(
                line,
                (state as TokenizerState).stack,
                LINE_TIME_LIMIT_MS,
              );
              const tokens: MonacoApi.languages.IToken[] = [];
              for (let index = 0; index < result.tokens.length; index += 2) {
                tokens.push({
                  startIndex: result.tokens[index] ?? 0,
                  scopes: tokenName(result.tokens[index + 1] ?? 0),
                });
              }
              return { tokens, endState: new TokenizerState(result.ruleStack) };
            },
          };
        },
      }),
    );
  }
}
