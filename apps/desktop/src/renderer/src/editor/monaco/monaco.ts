import type * as MonacoApi from 'monaco-editor';

export type Monaco = typeof MonacoApi;

let loading: Promise<Monaco> | null = null;

/**
 * Loads Monaco on first use only (SDD-011 §11): the terminal-only workspace never
 * downloads or starts it. Workers are bundled with the app; nothing comes from a CDN.
 */
export function loadMonaco(): Promise<Monaco> {
  loading ??= load().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

async function load(): Promise<Monaco> {
  const [monaco, editorWorker, tsWorker, jsonWorker, cssWorker, htmlWorker] = await Promise.all([
    import('monaco-editor'),
    import('monaco-editor/editor/editor.worker?worker'),
    import('monaco-editor/language/typescript/ts.worker?worker'),
    import('monaco-editor/language/json/json.worker?worker'),
    import('monaco-editor/language/css/css.worker?worker'),
    import('monaco-editor/language/html/html.worker?worker'),
  ]);
  const workers: Record<string, new () => Worker> = {
    typescript: tsWorker.default,
    javascript: tsWorker.default,
    json: jsonWorker.default,
    css: cssWorker.default,
    scss: cssWorker.default,
    less: cssWorker.default,
    html: htmlWorker.default,
    handlebars: htmlWorker.default,
    razor: htmlWorker.default,
  };
  (globalThis as { MonacoEnvironment?: MonacoApi.Environment }).MonacoEnvironment = {
    getWorker: (_id, label) => new (workers[label] ?? editorWorker.default)(),
  };
  // The TypeScript worker sees one file at a time, so it cannot resolve imports: only
  // syntax errors are shown until a language server provides real diagnostics (PLAN-033 R7).
  for (const defaults of [
    monaco.typescript.typescriptDefaults,
    monaco.typescript.javascriptDefaults,
  ]) {
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  }
  monaco.editor.defineTheme('atlas-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#0a0a0a' },
  });
  return monaco;
}
