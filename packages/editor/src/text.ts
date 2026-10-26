import { createHash } from 'node:crypto';
import type { FileEncoding, FileEol } from '@atlas/contracts';

/** Bytes inspected for NUL characters when telling text from binary content. */
const BINARY_SNIFF_BYTES = 8000;

const DECODER_LABELS: Record<FileEncoding, string> = {
  utf8: 'utf-8',
  utf8bom: 'utf-8',
  utf16le: 'utf-16le',
  utf16be: 'utf-16be',
};

export interface DecodedText {
  content: string;
  encoding: FileEncoding;
  eol: FileEol;
  mixedEol: boolean;
}

export function contentVersion(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Decodes UTF-8 (with or without BOM) and UTF-16 with BOM. Null for binary content and
 * other encodings: the editor never shows arbitrary bytes as text.
 */
export function decodeText(bytes: Uint8Array): DecodedText | null {
  let encoding: FileEncoding;
  let body: Uint8Array;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf8bom';
    body = bytes.subarray(3);
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf16le';
    body = bytes.subarray(2);
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf16be';
    body = bytes.subarray(2);
  } else {
    encoding = 'utf8';
    body = bytes;
    if (body.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  }
  let content: string;
  try {
    content = new TextDecoder(DECODER_LABELS[encoding], {
      fatal: true,
      ignoreBOM: true,
    }).decode(body);
  } catch {
    return null;
  }
  if (encoding.startsWith('utf16') && content.includes('\0')) return null;
  return { content, encoding, ...lineEndings(content) };
}

/** The most frequent line ending (LF when there are none) and whether both occur. */
export function lineEndings(content: string): { eol: FileEol; mixedEol: boolean } {
  let crlf = 0;
  let lf = 0;
  for (let index = content.indexOf('\n'); index !== -1; index = content.indexOf('\n', index + 1)) {
    if (index > 0 && content.charCodeAt(index - 1) === 13) crlf += 1;
    else lf += 1;
  }
  return { eol: crlf > lf ? 'CRLF' : 'LF', mixedEol: crlf > 0 && lf > 0 };
}

/** Encodes `content` as it was read, so saving keeps the file's encoding and BOM. */
export function encodeText(content: string, encoding: FileEncoding): Uint8Array {
  switch (encoding) {
    case 'utf8':
      return Buffer.from(content, 'utf8');
    case 'utf8bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
    case 'utf16be': {
      const body = Buffer.from(content, 'utf16le');
      body.swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    }
  }
}
