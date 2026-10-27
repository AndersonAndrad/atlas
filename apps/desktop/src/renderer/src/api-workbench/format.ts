import type { HttpBodyKind, HttpBodyType } from '@atlas/contracts';

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Colour of a status code: success, redirect, client or server error. */
export function statusClass(status: number | null): string {
  if (status === null) return 'bg-destructive/15 text-destructive';
  if (status < 300) return 'bg-success/15 text-success';
  if (status < 400) return 'bg-sky-500/15 text-sky-600 dark:text-sky-300';
  if (status < 500) return 'bg-warning/15 text-warning';
  return 'bg-destructive/15 text-destructive';
}

export const METHOD_CLASSES: Record<string, string> = {
  GET: 'text-success',
  POST: 'text-warning',
  PUT: 'text-sky-600 dark:text-sky-300',
  PATCH: 'text-violet-600 dark:text-violet-300',
  DELETE: 'text-destructive',
  HEAD: 'text-muted-foreground',
  OPTIONS: 'text-muted-foreground',
};

export function methodClass(method: string): string {
  return METHOD_CLASSES[method.toUpperCase()] ?? 'text-foreground';
}

export const BODY_TYPE_LABELS: Record<HttpBodyType, string> = {
  none: 'None',
  json: 'JSON',
  text: 'Text',
  xml: 'XML',
  form: 'Form URL encoded',
  multipart: 'Multipart form',
  binary: 'Binary file',
};

/** Monaco language of a body. */
export function languageOf(kind: HttpBodyKind | HttpBodyType): string {
  switch (kind) {
    case 'json':
      return 'json';
    case 'xml':
      return 'xml';
    case 'html':
      return 'html';
    default:
      return 'plaintext';
  }
}

/** Pretty JSON when the text parses; otherwise the text as received. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
