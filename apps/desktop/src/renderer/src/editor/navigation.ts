/**
 * Lets any view open a project file in the code editor (SDD-026: evidence of audit
 * findings) without passing callbacks through every component in between. The App
 * listens once and switches to the editor.
 */
export interface EditorOpenTarget {
  projectId: string;
  /** Relative to the project folder, `/` separators; absent: only show the project. */
  path?: string;
  /** Shown when the file is opened for the first time. */
  line?: number;
}

type Listener = (target: EditorOpenTarget) => void;

const listeners = new Set<Listener>();

export function openInEditor(target: EditorOpenTarget): void {
  for (const listener of listeners) listener(target);
}

export function onOpenInEditor(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
