/**
 * Text normalization for retrieval. Pure and dependency-free: the package is also
 * bundled into the desktop renderer.
 */

/** Frequent English and Portuguese words that carry no meaning for retrieval. */
const STOPWORDS = new Set(
  // English
  (
    'the and for with that this from into are was were has have had not but all any can ' +
    'will should would when what which who how why where then than them they their there ' +
    'its our your you use using used also only more some such each other about after before ' +
    'over under out yes via per ' +
    // Portuguese
    'que com para por uma umas uns dos das nos nas pelo pela pelos pelas como mais mas ' +
    'quando onde qual quais isso isto esse essa este esta aquele aquela ser sao foi tem ter ' +
    'sem sobre entre tambem muito deve pode seu sua seus suas nao sim ate depois antes cada ' +
    'outro outra todo toda'
  ).split(' '),
);

const MIN_TERM_LENGTH = 3;

/** Lowercase, without diacritics, camelCase split: "SharedContext é" → "shared context e". */
export function normalizeText(text: string): string {
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/** Meaningful words of a text, in order of appearance, without duplicates. */
export function terms(text: string): string[] {
  const seen = new Set<string>();
  for (const word of normalizeText(text).split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < MIN_TERM_LENGTH || STOPWORDS.has(word)) continue;
    seen.add(word);
  }
  return [...seen];
}

/** A word matches a query term when equal, or when it extends a term of 4+ characters. */
function matches(word: string, term: string): boolean {
  return word === term || (term.length >= 4 && word.startsWith(term));
}

/** Query terms found in the words of a text. */
export function matchedTerms(queryTerms: readonly string[], words: readonly string[]): string[] {
  return queryTerms.filter((term) => words.some((word) => matches(word, term)));
}

/** Jaccard similarity of two word sets (0..1). */
export function jaccard(
  a: readonly string[] | ReadonlySet<string>,
  b: readonly string[] | ReadonlySet<string>,
): number {
  const left = a instanceof Set ? a : new Set(a);
  const right = b instanceof Set ? b : new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Stable 64-bit FNV-1a fingerprint as hex; identifies content, not a security hash. */
export function fingerprint(text: string): string {
  let low = 0x84222325;
  let high = 0xcbf29ce4;
  for (let index = 0; index < text.length; index += 1) {
    low = (low ^ text.charCodeAt(index)) >>> 0;
    // Multiply the 64-bit value by the FNV prime 0x100000001b3.
    const lowProduct = low * 0x1b3;
    const carry = Math.floor(lowProduct / 0x100000000);
    high = (high * 0x1b3 + low * 0x100 + carry) >>> 0;
    low = lowProduct >>> 0;
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
