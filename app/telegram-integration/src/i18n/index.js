import {
  LOCALES,
  formatDate,
  formatNumber,
  isRtl,
  normalizeLocale,
  registerCatalog,
  translate,
} from '../../../qbazz-core/src/i18n/index.js';
import { formatMoney } from '../../../qbazz-core/src/util/money.js';
import { en } from './en.js';
import { fa } from './fa.js';
import { ltr } from '../telegram/rtl.js';

/**
 * The bot's own strings live beside the core's in one translation engine, so
 * there is a single set of rules — placeholders, plurals, number formatting —
 * and a message that mixes both (an error from the core shown in a bot screen)
 * is worded consistently.
 */
registerCatalog('en', en);
registerCatalog('fa', fa);

/**
 * Everything a screen needs to speak one person's language: the translator,
 * number/money/date formatting in their script and calendar, and their text
 * direction. Built once per update and passed to every renderer.
 */
export function makeTx(locale, fallback = 'fa') {
  const loc = normalizeLocale(locale, fallback);
  const rtl = isRtl(loc);
  const t = (key, params) => translate(loc, key, params);

  return {
    locale: loc,
    rtl,
    info: LOCALES[loc],
    t,
    /** ۱۲٬۵۰۰ or 12,500 — digits and separators for the locale. */
    n: (value, options) => formatNumber(value, loc, options),
    /** "۱۵٬۰۰۰ تومان" / "15,000 Toman" — minor units in, display string out. */
    money: (minor, currency) => formatMoney(minor, currency, loc),
    /** Jalali for Persian, Gregorian for English. */
    date: (value, options) => formatDate(value, loc, options),
    /** A list marker: "۱." in Persian, "1." in English. */
    idx: (position) => `${formatNumber(position, loc)}.`,
    /** Keeps a code, number or handle left-to-right inside right-to-left text. */
    ltr: (text) => (rtl ? ltr(text) : String(text)),
    orderStatus: (status) => t(`enum.order.${status}`),
    payment: (method) => t(`enum.payment.${method}`),
    paymentStatus: (status) => t(`enum.paymentStatus.${status}`),
    fulfillment: (method) => t(`enum.fulfillment.${method}`),
    storeStatus: (status) => t(`enum.store.${status}`),
    productStatus: (status) => t(`enum.product.${status}`),
  };
}

export { LOCALES };
