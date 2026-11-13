/**
 * Persian and Arabic-Indic digits.
 *
 * A Persian keyboard types ۱۲۵۰۰ for 12500, and Telegram passes it through
 * verbatim. Every place that parses a number, a price or a phone number has to
 * accept both scripts, or a seller typing a price on their own keyboard gets
 * "that is not a number" for a perfectly good answer.
 */
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';

/** ۱۲۳ and ١٢٣ → 123. Leaves everything else alone. */
export function toLatinDigits(value) {
  return String(value ?? '').replace(/[۰-۹٠-٩]/g, (digit) => {
    const persian = PERSIAN.indexOf(digit);
    return String(persian !== -1 ? persian : ARABIC_INDIC.indexOf(digit));
  });
}

/**
 * Cleans a typed number: Persian digits, the Persian thousands separator (٬),
 * the Arabic comma (،), plain commas and spaces are dropped, and the Persian
 * decimal separator (٫) becomes a dot. "۱٬۲۵۰٫۵" → "1250.5".
 */
export function normalizeNumberInput(value) {
  return toLatinDigits(value)
    .replace(/[٬،,\s‌‎‏]/g, '')
    .replace(/٫/g, '.');
}

export function toPersianDigits(value) {
  return String(value ?? '').replace(/[0-9]/g, (digit) => PERSIAN[Number(digit)]);
}
