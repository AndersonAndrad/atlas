import type { EditorPreferences } from '@atlas/contracts';
import type * as MonacoApi from 'monaco-editor';
import { extensionRuntime } from '@/extensions/runtime/runtime';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Monaco } from '../monaco/monaco';
import type { ViewState } from '../state/tabs';

export interface CodeEditorHandle {
  focus(): void;
  /** Runs a Monaco action, e.g. `actions.find`. */
  run(actionId: string): void;
}

interface CodeEditorProps {
  monaco: Monaco;
  model: MonacoApi.editor.ITextModel | null;
  path: string | null;
  preferences: EditorPreferences;
  readOnly: boolean;
  /** Position to restore when a model is shown for the first time. */
  initialViewState: (path: string) => ViewState | undefined;
  onViewState: (path: string, state: ViewState) => void;
  onBlur: () => void;
  registerHandle: (handle: CodeEditorHandle | null) => void;
}

/**
 * One Monaco editor showing the active tab's model. Switching tabs swaps models and
 * keeps each tab's cursor, selection and scroll (FR-1105).
 */
export function CodeEditor(props: CodeEditorProps) {
  const { monaco, model, path, preferences, readOnly } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, MonacoApi.editor.ICodeEditorViewState>());
  const shownPath = useRef<string | null>(null);
  const callbacks = useRef(props);
  useEffect(() => {
    callbacks.current = props;
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const editor = monaco.editor.create(host, {
      model: null,
      automaticLayout: true,
      fixedOverflowWidgets: true,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      matchBrackets: 'always',
      folding: true,
      lineNumbers: 'on',
      // Links in code are not opened by Monaco: nothing leaves the app by a click.
      links: false,
      ariaLabel: 'Code editor',
    });
    editorRef.current = editor;
    const report = () => {
      const current = shownPath.current;
      const position = editor.getPosition();
      if (current === null || position === null) return;
      callbacks.current.onViewState(current, {
        line: position.lineNumber,
        column: position.column,
        scrollTop: editor.getScrollTop(),
      });
    };
    const subscriptions = [
      editor.onDidChangeCursorPosition(report),
      editor.onDidScrollChange(report),
      editor.onDidBlurEditorText(() => callbacks.current.onBlur()),
    ];
    callbacks.current.registerHandle({
      focus: () => editor.focus(),
      run: (actionId) => void editor.getAction(actionId)?.run(),
    });
    return () => {
      callbacks.current.registerHandle(null);
      for (const subscription of subscriptions) subscription.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [monaco]);

  // Swaps the model, keeping the view state of the tab being left.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    const previous = shownPath.current;
    if (previous !== null && editor.getModel() !== null) {
      const state = editor.saveViewState();
      if (state !== null) viewStates.current.set(previous, state);
    }
    editor.setModel(model);
    shownPath.current = model === null ? null : path;
    if (model === null || path === null) return;
    const saved = viewStates.current.get(path);
    if (saved !== undefined) {
      editor.restoreViewState(saved);
    } else {
      const initial = callbacks.current.initialViewState(path);
      if (initial?.line !== undefined) {
        editor.setPosition({ lineNumber: initial.line, column: initial.column ?? 1 });
        editor.revealPositionInCenterIfOutsideViewport({
          lineNumber: initial.line,
          column: initial.column ?? 1,
        });
      }
      if (initial?.scrollTop !== undefined) editor.setScrollTop(initial.scrollTop);
    }
    editor.focus();
  }, [model, path]);

  useEffect(() => {
    extensionRuntime.attach(monaco);
    extensionRuntime.setPreferences(preferences);
    editorRef.current?.updateOptions({
      fontSize: preferences.fontSize,
      wordWrap: preferences.wordWrap ? 'on' : 'off',
      minimap: { enabled: preferences.minimap },
      readOnly,
      readOnlyMessage: { value: 'ATLAS cannot write this file.' },
    });
  }, [monaco, preferences, readOnly]);

  useEffect(() => {
    model?.updateOptions({ tabSize: preferences.tabSize, insertSpaces: preferences.insertSpaces });
  }, [model, preferences.tabSize, preferences.insertSpaces]);

  return <div ref={hostRef} className="h-full min-h-0 w-full" data-testid="code-editor" />;
}
