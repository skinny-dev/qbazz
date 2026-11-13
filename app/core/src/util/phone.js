import { toLatinDigits } from './digits.js';

/**
 * One spelling per phone number.
 *
 * The same Iranian mobile arrives as `09121234567` (typed on the website),
 * `989121234567` (what Telegram sends for a shared contact), `+989121234567`
 * and `0098…`. If each of those were stored as written, a person who signs in
 * on the web and later shares their number in Telegram would look like two
 * strangers. Everything that compares or stores a phone number goes through
 * here first; the canonical form is `+98912…`. Numbers from elsewhere are kept
 * as `+<digits>` when they carry a country code, otherwise left as typed.
 */
export function canonicalPhone(raw) {
  let text = toLatinDigits(String(raw ?? '')).replace(/[\s\-().]/g, '');
  if (!text) return '';
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  const plus = text.startsWith('+');
  const digits = text.replace(/\D/g, '');

  if (plus) return /^989\d{9}$/.test(digits) ? `+${digits}` : `+${digits}`;
  if (/^09\d{9}$/.test(digits)) return `+98${digits.slice(1)}`;
  if (/^9\d{9}$/.test(digits)) return `+98${digits}`;
  if (/^989\d{9}$/.test(digits)) return `+${digits}`;
  return digits;
}

/** Every way an already-stored number may have been written — for finding rows that predate canonicalising. */
export function phoneVariants(raw) {
  const canon = canonicalPhone(raw);
  if (/^\+989\d{9}$/.test(canon)) {
    const national = canon.slice(3);
    return [canon, `98${national}`, `0${national}`, national];
  }
  return canon.startsWith('+') ? [canon, canon.slice(1)] : [canon];
}
