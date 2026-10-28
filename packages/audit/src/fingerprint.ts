import { createHash } from 'node:crypto';
import type { AuditCategory, AuditFindingLocation } from '@atlas/contracts';

/** Words that carry no meaning about the issue itself. */
const STOP_WORDS = new Set([
  'the',
  'and',
  'that',
  'this',
  'with',
  'from',
  'which',
  'when',
  'where',
  'there',
  'their',
  'have',
  'been',
  'into',
  'only',
  'also',
  'could',
  'would',
  'should',
  'does',
  'not',
  'are',
  'for',
  'can',
  'may',
  'its',
  'any',
  'all',
  'but',
  'was',
  'were',
  'will',
]);

/** Distinct words of four letters or more, sorted: independent of wording order and numbers. */
function descriptionTerms(description: string): string {
  const words = description
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\s_]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  return [...new Set(words)].sort().slice(0, 24).join(' ');
}

const normalizeExcerpt = (excerpt: string) => excerpt.replace(/\s+/g, ' ').trim().toLowerCase();

export interface FingerprintInput {
  projectId: string;
  category: AuditCategory;
  description: string;
  excerpt: string | null;
  locations: readonly Pick<AuditFindingLocation, 'path' | 'symbol'>[];
}

/**
 * A stable identity for a finding across audits (FR-010): project, category, the files
 * and symbols it points at, and the quoted code; the description's terms only when no
 * code was quoted. Titles and line numbers are left out: they change between runs.
 */
export function auditFingerprint(input: FingerprintInput): string {
  const files = [...new Set(input.locations.map((location) => location.path))].sort();
  const symbols = [
    ...new Set(
      input.locations
        .map((location) => location.symbol?.trim().toLowerCase() ?? '')
        .filter((symbol) => symbol !== ''),
    ),
  ].sort();
  const evidence =
    input.excerpt === null || normalizeExcerpt(input.excerpt) === ''
      ? `terms:${descriptionTerms(input.description)}`
      : `code:${normalizeExcerpt(input.excerpt)}`;
  return createHash('sha256')
    .update(
      JSON.stringify(['v1', input.projectId, input.category, files, symbols, evidence]),
      'utf8',
    )
    .digest('hex');
}
