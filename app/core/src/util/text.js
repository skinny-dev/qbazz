import { toLatinDigits } from './digits.js';

/**
 * Text normalisation for matching, not for display.
 *
 * Persian text arrives in several spellings of the same word: a Persian
 * keyboard produces ی and ک, an Arabic one produces ي and ك; people type
 * "کیف‌پول" with the invisible half-space (ZWNJ) or as "کیف پول" or "کیفپول".
 * Search that treats these as different words silently fails to find a shop
 * for half of its customers, so both the index and the query go through this.
 */
export function normalizeText(value) {
  return toLatinDigits(String(value ?? ''))
    .normalize('NFKC')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ةۀ]/g, 'ه')
    // ZWNJ, ZWJ, tatweel and the harakat (short-vowel marks) carry no meaning here.
    .replace(/[‌‍ـً-ٰٟ]/g, '')
    .toLowerCase();
}
