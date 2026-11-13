import { toLatinDigits } from './digits.js';

/**
 * Slugs are ASCII on purpose: they appear in URLs and in Telegram deep links
 * (`t.me/bot?start=s_<slug>`), and Telegram only allows A-Z a-z 0-9 _ - in
 * that parameter. A Persian shop name therefore needs a Latin spelling.
 *
 * This is a plain transliteration, not a translation, and Persian is written
 * without its short vowels, so "نانوایی" comes out as "nanoii" rather than
 * "nanvaei". That is fine for an identifier — it only has to be stable,
 * readable-ish and unique — and shops can pick their own address later.
 */
const LETTERS = {
  ا: 'a', آ: 'a', أ: 'a', إ: 'e', ب: 'b', پ: 'p', ت: 't', ث: 's', ج: 'j', چ: 'ch',
  ح: 'h', خ: 'kh', د: 'd', ذ: 'z', ر: 'r', ز: 'z', ژ: 'zh', س: 's', ش: 'sh',
  ص: 's', ض: 'z', ط: 't', ظ: 'z', ع: 'a', غ: 'gh', ف: 'f', ق: 'gh', ک: 'k',
  ك: 'k', گ: 'g', ل: 'l', م: 'm', ن: 'n', ه: 'h', ة: 'h', ئ: 'i', ؤ: 'o', ء: '',
};

function transliterateWord(word) {
  const chars = [...word];
  let out = '';
  chars.forEach((ch, index) => {
    const first = index === 0;
    const last = index === chars.length - 1;
    const previous = chars[index - 1];
    if (ch === 'و') out += first ? 'v' : 'o';
    else if (ch === 'ی' || ch === 'ي' || ch === 'ى') out += first ? 'y' : 'i';
    // A word-final ه after a consonant is the vowel "e" (خانه → khane), but
    // after ا it is the consonant "h" (فروشگاه → forushgah).
    else if (ch === 'ه' && last && index > 0 && previous !== 'ا') out += 'e';
    else out += LETTERS[ch] ?? '';
  });
  return out;
}

/** Persian/Arabic script → Latin. Everything that is not Persian passes through. */
export function transliterate(input) {
  return toLatinDigits(String(input ?? ''))
    // Marks and joiners carry no letters of their own.
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/‌/g, '')
    .replace(/[؀-ۿ]+/g, (word) => transliterateWord(word));
}

export function slugify(input, { maxLength = 48 } = {}) {
  const base = transliterate(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return base || 'item';
}

/** Appends -2, -3 ... until `isTaken(slug)` says the slug is free. */
export async function uniqueSlug(base, isTaken) {
  const root = slugify(base);
  let candidate = root;
  let n = 1;
  while (await isTaken(candidate)) {
    n += 1;
    candidate = `${root}-${n}`;
  }
  return candidate;
}
