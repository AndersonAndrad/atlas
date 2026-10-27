import type { ResolvedSnippet } from '@atlas/contracts';
import type * as MonacoApi from 'monaco-editor';
import type { Monaco } from '@/editor/monaco/monaco';

export interface SnippetSource {
  extensionLabel: string;
  snippet: ResolvedSnippet;
}

/**
 * Contributed snippets as completions (FR-1510). Monaco expands VS Code snippet syntax,
 * including placeholders and Tab navigation between them. `*` covers every language.
 */
export function registerSnippets(
  monaco: Monaco,
  byLanguage: ReadonlyMap<string, readonly SnippetSource[]>,
): MonacoApi.IDisposable[] {
  return [...byLanguage].map(([language, sources]) =>
    monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );
        const suggestions = sources.flatMap(({ extensionLabel, snippet }) =>
          snippet.prefixes.map((prefix) => ({
            label: { label: prefix, description: snippet.name },
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: snippet.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: `${snippet.name} — ${extensionLabel}`,
            documentation: snippet.description ?? snippet.body,
            range,
          })),
        );
        return { suggestions };
      },
    }),
  );
}
