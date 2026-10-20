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
