import type { FileEol } from '@atlas/contracts';
import type * as MonacoApi from 'monaco-editor';
import type { Monaco } from '../monaco/monaco';

interface Buffer {
  model: MonacoApi.editor.ITextModel;
  /** Alternative version id of the saved text: undoing back to it is not a change. */
  savedVersionId: number;
  /** Last value reported to `onDirtyChange`. */
  dirty: boolean;
  listener: MonacoApi.IDisposable;
}

/**
 * Text of the open files, as Monaco models of one project (FR-1105). Contents stay in
 * memory only: they are never persisted (FR-1110, FR-1129).
 */
export class EditorBuffers {
  private readonly buffers = new Map<string, Buffer>();

  constructor(
    private readonly monaco: Monaco,
    private readonly projectId: string,
    /** Called when a buffer becomes modified or returns to its saved text. */
    private readonly onDirtyChange: (path: string, dirty: boolean) => void,
  ) {}

  private onEdit: (path: string) => void = () => undefined;

  /** Called on every edit, e.g. for auto save. */
  setEditListener(listener: (path: string) => void): void {
    this.onEdit = listener;
  }

  has(path: string): boolean {
    return this.buffers.has(path);
  }

  model(path: string): MonacoApi.editor.ITextModel | null {
    return this.buffers.get(path)?.model ?? null;
  }

  /** Creates the buffer of a file just read from disk (unmodified). */
  create(path: string, content: string, eol: FileEol): MonacoApi.editor.ITextModel {
    this.dispose(path);
    const model = this.monaco.editor.createModel(content, undefined, this.uri(path));
    this.applyEol(model, eol);
    const listener = model.onDidChangeContent(() => {
      this.sync(path);
      this.onEdit(path);
    });
    this.buffers.set(path, {
      model,
      savedVersionId: model.getAlternativeVersionId(),
      dirty: false,
      listener,
    });
    return model;
  }

  isDirty(path: string): boolean {
    const buffer = this.buffers.get(path);
    return buffer !== undefined && buffer.model.getAlternativeVersionId() !== buffer.savedVersionId;
  }

  /** The text to save and the version it corresponds to (edits made during the save stay modified). */
  snapshot(path: string): { content: string; versionId: number } | null {
    const buffer = this.buffers.get(path);
    if (buffer === undefined) return null;
    return { content: buffer.model.getValue(), versionId: buffer.model.getAlternativeVersionId() };
  }

  markSaved(path: string, versionId: number): void {
    const buffer = this.buffers.get(path);
    if (buffer === undefined) return;
    buffer.savedVersionId = versionId;
    this.sync(path);
  }

  /** Replaces the text with the file's current content; it can still be undone. */
  reload(path: string, content: string, eol: FileEol): void {
    const buffer = this.buffers.get(path);
    if (buffer === undefined) return;
    const { model } = buffer;
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
    model.pushStackElement();
    this.applyEol(model, eol);
    this.markSaved(path, model.getAlternativeVersionId());
  }

  /** Follows a rename or move; a modified buffer stays modified. */
  rename(from: string, to: string): void {
    const buffer = this.buffers.get(from);
    if (buffer === undefined) return;
    const dirty = this.isDirty(from);
    const eol = buffer.model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
    const content = buffer.model.getValue();
    this.dispose(from);
    this.create(to, content, eol);
    if (dirty) this.markSaved(to, -1);
  }

  dirtyPaths(): string[] {
    return [...this.buffers.keys()].filter((path) => this.isDirty(path));
  }

  dispose(path: string): void {
    const buffer = this.buffers.get(path);
    if (buffer === undefined) return;
    buffer.listener.dispose();
    buffer.model.dispose();
    this.buffers.delete(path);
  }

  disposeAll(): void {
    for (const path of [...this.buffers.keys()]) this.dispose(path);
  }

  private sync(path: string): void {
    const buffer = this.buffers.get(path);
    if (buffer === undefined) return;
    const dirty = this.isDirty(path);
    if (dirty === buffer.dirty) return;
    buffer.dirty = dirty;
    this.onDirtyChange(path, dirty);
  }

  private applyEol(model: MonacoApi.editor.ITextModel, eol: FileEol): void {
    model.setEOL(
      eol === 'CRLF'
        ? this.monaco.editor.EndOfLineSequence.CRLF
        : this.monaco.editor.EndOfLineSequence.LF,
    );
  }

  /** One URI per project file, so Monaco picks the language from the extension. */
  private uri(path: string): MonacoApi.Uri {
    return this.monaco.Uri.from({ scheme: 'file', path: `/${this.projectId}/${path}` });
  }
}
