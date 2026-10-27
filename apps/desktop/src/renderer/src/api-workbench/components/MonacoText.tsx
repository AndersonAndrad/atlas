import type { EditorPreferences } from '@atlas/contracts';
import type * as MonacoApi from 'monaco-editor';
import { extensionRuntime } from '@/extensions/runtime/runtime';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEditorPreferences } from '@/editor/hooks/useEditorPreferences';
import { loadMonaco, type Monaco } from '@/editor/monaco/monaco';
import { cn } from '@/lib/utils';

/** The editor's own Monaco, loaded on first use (SDD-014 FR-1405, FR-1411). */
function useMonaco(): { monaco: Monaco | null; error: boolean } {
  const [monaco, setMonaco] = useState<Monaco | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadMonaco().then(
      (loaded) => !cancelled && setMonaco(loaded),
      () => !cancelled && setError(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return { monaco, error };
}

function baseOptions(preferences: EditorPreferences) {
  return {
    automaticLayout: true,
    fixedOverflowWidgets: true,
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    fontSize: preferences.fontSize,
    tabSize: preferences.tabSize,
    insertSpaces: preferences.insertSpaces,
    wordWrap: 'on' as const,
    // Links in responses are never opened by a click: nothing leaves the app (§18).
    links: false,
    lineNumbers: 'on' as const,
  };
}

interface MonacoTextProps {
  value: string;
  language: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  ariaLabel: string;
  className?: string;
  testId?: string;
  /** Runs the find widget when this number changes. */
  findRequest?: number;
}

/** A text or JSON editor for request bodies, or a read-only view of a response. */
export function MonacoText({
  value,
  language,
  readOnly = false,
  onChange,
  ariaLabel,
  className,
  testId,
  findRequest,
}: MonacoTextProps) {
  const { monaco, error } = useMonaco();
  const { preferences } = useEditorPreferences();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | null>(null);
  const changeRef = useRef(onChange);
  const applying = useRef(false);
  useEffect(() => {
    changeRef.current = onChange;
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (monaco === null || host === null) return;
    const model = monaco.editor.createModel('', language);
    const editor = monaco.editor.create(host, {
      ...baseOptions(preferences),
      model,
      readOnly,
      ariaLabel,
      theme: extensionRuntime.currentThemeName(),
    });
    editorRef.current = editor;
    const subscription = editor.onDidChangeModelContent(() => {
      if (!applying.current) changeRef.current?.(model.getValue());
    });
    return () => {
      subscription.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
    // Created once per Monaco instance; later changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !monaco) return;
    if (model.getValue() !== value) {
      applying.current = true;
      model.setValue(value);
      applying.current = false;
    }
    monaco.editor.setModelLanguage(model, language);
    editor.updateOptions({ ...baseOptions(preferences), readOnly, ariaLabel });
    extensionRuntime.attach(monaco);
    extensionRuntime.setPreferences(preferences);
  }, [monaco, value, language, readOnly, ariaLabel, preferences]);

  useEffect(() => {
    if (findRequest) editorRef.current?.getAction('actions.find')?.run();
  }, [findRequest]);

  if (error) {
    return <p className="text-destructive p-2 text-sm">The text editor could not be loaded.</p>;
  }
  return (
    <div
      ref={hostRef}
      className={cn('min-h-0 overflow-hidden rounded-md border', className)}
      data-testid={testId}
    >
      {monaco === null && <p className="text-muted-foreground p-2 text-sm">Loading editor…</p>}
    </div>
  );
}

interface MonacoDiffProps {
  original: string;
  modified: string;
  language: string;
  className?: string;
  testId?: string;
}

/** Side-by-side comparison of two saved responses (FR-1415). */
export function MonacoDiff({ original, modified, language, className, testId }: MonacoDiffProps) {
  const { monaco, error } = useMonaco();
  const { preferences } = useEditorPreferences();
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (monaco === null || host === null) return;
    const left = monaco.editor.createModel(original, language);
    const right = monaco.editor.createModel(modified, language);
    const diff = monaco.editor.createDiffEditor(host, {
      ...baseOptions(preferences),
      readOnly: true,
      originalEditable: false,
      renderSideBySide: host.clientWidth > 700,
      theme: extensionRuntime.currentThemeName(),
    });
    diff.setModel({ original: left, modified: right });
    return () => {
      diff.dispose();
      left.dispose();
      right.dispose();
    };
  }, [monaco, original, modified, language, preferences]);

  if (error) {
    return <p className="text-destructive p-2 text-sm">The comparison could not be loaded.</p>;
  }
  return (
    <div
      ref={hostRef}
      className={cn('min-h-0 overflow-hidden rounded-md border', className)}
      data-testid={testId}
    >
      {monaco === null && <p className="text-muted-foreground p-2 text-sm">Loading…</p>}
    </div>
  );
}
