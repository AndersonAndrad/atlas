import type { ExtensionCompatibilityLevel } from '@atlas/contracts';

export const COMPATIBILITY_LABELS: Record<ExtensionCompatibilityLevel, string> = {
  SUPPORTED: 'Supported',
  PARTIALLY_SUPPORTED: 'Partially supported',
  UNSUPPORTED: 'Not supported',
  UNTESTED: 'Untested',
};

export const COMPATIBILITY_HINTS: Record<ExtensionCompatibilityLevel, string> = {
  SUPPORTED: 'This exact version was tested with ATLAS.',
  PARTIALLY_SUPPORTED: 'Some of what it provides works in ATLAS; the rest is listed below.',
  UNSUPPORTED: 'ATLAS cannot use anything this extension provides.',
  UNTESTED: 'Everything it declares is supported, but this version was not tested with ATLAS.',
};

export function compatibilityClass(level: ExtensionCompatibilityLevel): string {
  switch (level) {
    case 'SUPPORTED':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
    case 'PARTIALLY_SUPPORTED':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
    case 'UNSUPPORTED':
      return 'border-red-500/40 bg-red-500/10 text-red-300';
    case 'UNTESTED':
      return 'border-sky-500/40 bg-sky-500/10 text-sky-300';
  }
}

/** Registry failures that mean "try again later", not "this extension is wrong". */
export const REGISTRY_ERRORS = new Set([
  'EXTENSION_REGISTRY_UNAVAILABLE',
  'EXTENSION_REGISTRY_INVALID_RESPONSE',
]);

export function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}
