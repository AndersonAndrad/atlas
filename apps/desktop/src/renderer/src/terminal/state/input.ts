/** Input chunk size, well below the 1,000,000-character IPC limit per message. */
export const INPUT_CHUNK_LENGTH = 64 * 1024;

/** Splits input into IPC-sized chunks without breaking UTF-16 surrogate pairs. */
export function splitInput(data: string, size = INPUT_CHUNK_LENGTH): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(offset + size, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
}

/** Characters that never need quoting in a POSIX shell word. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quotes a path as one POSIX shell word, e.g. `/tmp/my file.png` → `'/tmp/my file.png'`. */
export function quoteShellPath(path: string): string {
  if (SHELL_SAFE.test(path)) return path;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * Text typed for files dropped on a terminal: quoted paths separated by spaces,
 * plus a trailing space, like other terminals. Never ends with a newline, so
 * nothing runs by itself. Returns '' when there is no path.
 */
export function droppedPathsInput(paths: readonly string[]): string {
  const words = paths.filter((path) => path !== '').map(quoteShellPath);
  return words.length === 0 ? '' : `${words.join(' ')} `;
}

export type ClipboardShortcut = 'copy' | 'paste' | 'selectAll';

/** Windows/Linux terminal clipboard shortcuts: Ctrl+Shift+C/V/A and Shift+Insert. */
export function clipboardShortcut(
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
): ClipboardShortcut | null {
  if (event.altKey || event.metaKey || !event.shiftKey) return null;
  if (!event.ctrlKey) return event.code === 'Insert' ? 'paste' : null;
  if (event.code === 'KeyC') return 'copy';
  if (event.code === 'KeyV') return 'paste';
  if (event.code === 'KeyA') return 'selectAll';
  return null;
}
