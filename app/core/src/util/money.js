import { formatNumber, normalizeLocale } from '../i18n/index.js';
import { normalizeNumberInput } from './digits.js';

/**
 * Money is stored as integer minor units (cents) plus a currency code.
 * Never float. Formatting lives here so the bot, the storefront and the
 * dashboard all render the same string.
 *
 * Currencies with no minor unit (Rial, Yen, Won…) store whole units: 15,000
 * Toman is the integer 15000, not 1,500,000. Getting this wrong is a silent
 * hundred-fold price error, which is why it is decided in exactly one place.
 *
 * IRT (Toman) is not an ISO currency — the ISO code is IRR (Rial) — but it is
 * the unit Iranian shops actually price in (1 Toman = 10 Rial), so it is
 * supported as a first-class code.
 */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'IRR', 'IRT', 'CLP', 'UGX']);

/** Currencies Intl cannot format for us, with their name in each locale. */
const LOCAL_UNITS = {
  IRT: { fa: 'تومان', en: 'Toman' },
  IRR: { fa: 'ریال', en: 'IRR' },
};

export function minorUnitsFor(currency) {
  return ZERO_DECIMAL.has(String(currency).toUpperCase()) ? 0 : 2;
}

/** "12.50" | 12.5 | "۱۲٫۵" → 1250 (or 12 for a zero-decimal currency). */
export function toMinor(amount, currency = 'USD') {
  const digits = minorUnitsFor(currency);
  let n;
  if (typeof amount === 'string') {
    // Allow a currency symbol or code around the number ("$12.50", "15000 تومان"),
    // but there has to be a number in there: stripping "expensive" down to ""
    // and reading that as 0 would turn a typo into a free product.
    const cleaned = normalizeNumberInput(amount).replace(/[^0-9.\-]/g, '');
    if (!/\d/.test(cleaned)) return null;
    n = Number(cleaned);
  } else {
    n = Number(amount);
  }
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10 ** digits);
}

export function fromMinor(minor, currency = 'USD') {
  const digits = minorUnitsFor(currency);
  return Number(minor) / 10 ** digits;
}

/** `locale` is "fa", "en", or a full tag such as "fa-IR". */
export function formatMoney(minor, currency = 'USD', locale = 'en') {
  const code = String(currency).toUpperCase();
  const loc = normalizeLocale(locale);
  const digits = minorUnitsFor(code);
  const amount = fromMinor(minor, code);

  const unit = LOCAL_UNITS[code];
  if (unit) return `${formatNumber(amount, loc, { maximumFractionDigits: 0 })} ${unit[loc] || unit.en}`;

  try {
    return new Intl.NumberFormat(loc === 'fa' ? 'fa-IR' : 'en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${formatNumber(amount, loc, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${code}`;
  }
}

export function money(amountMinor, currency, locale = 'en') {
  return { amount: amountMinor, currency, formatted: formatMoney(amountMinor, currency, locale) };
}

/** basis points: 500 bps of 10000 = 500 */
export function applyBps(minor, bps) {
  return Math.round((Number(minor) * Number(bps)) / 10000);
}
