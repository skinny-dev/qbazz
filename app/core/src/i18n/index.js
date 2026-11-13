import { en } from './en.js';
import { fa } from './fa.js';
import { formatMoney } from '../util/money.js';

/**
 * Translation for everything a person reads, on every surface.
 *
 * The catalogs are flat `key → template` maps so that a test can prove Persian
 * and English carry exactly the same keys and placeholders — the failure this
 * prevents is a Persian user hitting a screen that silently falls back to
 * English, or worse, shows a raw key.
 *
 * The core owns the catalog for text it produces (onboarding prompts,
 * notifications, errors, category names). Integrations register their own
 * strings alongside via `registerCatalog`, so the Telegram bot and the future
 * web app translate through the same engine and the same rules.
 */

export const LOCALES = {
  fa: {
    code: 'fa',
    name: 'فارسی',
    flag: '🇮🇷',
    dir: 'rtl',
    intl: 'fa-IR',
    // What we tell a language model to write in.
    aiName: 'Persian (Farsi), written for Iranian readers',
    // fa-IR uses the Jalali calendar and Persian digits by default in ICU.
    listSeparator: '، ',
  },
  en: {
    code: 'en',
    name: 'English',
    flag: '🇬🇧',
    dir: 'ltr',
    intl: 'en-US',
    aiName: 'English',
    listSeparator: ', ',
  },
};

export const SUPPORTED_LOCALES = Object.keys(LOCALES);

const catalogs = { en: { ...en }, fa: { ...fa } };

/** Integrations add their own strings; later registrations win. */
export function registerCatalog(locale, entries) {
  catalogs[locale] = { ...(catalogs[locale] || {}), ...entries };
}

export function getCatalog(locale) {
  return catalogs[locale] || {};
}

export const isSupported = (locale) => SUPPORTED_LOCALES.includes(locale);

/** "fa-IR" → "fa"; anything unsupported → the fallback. */
export function normalizeLocale(locale, fallback = 'en') {
  const base = String(locale || '').toLowerCase().split(/[-_]/)[0];
  return isSupported(base) ? base : fallback;
}

export const isRtl = (locale) => LOCALES[normalizeLocale(locale)]?.dir === 'rtl';

/**
 * The locale a person actually sees.
 *
 * A stored `locale` is only honoured once the person has chosen it
 * (`localeSource: 'user'`). Otherwise the platform default applies — which is
 * why an account created from a Telegram client set to English does not make an
 * Iranian shopper's bot English, and why changing the platform default takes
 * effect for everyone who never picked a language.
 */
export function effectiveLocale(account, defaultLocale = 'fa') {
  if (account?.localeSource === 'user' && isSupported(account.locale)) return account.locale;
  return normalizeLocale(defaultLocale, 'en');
}

export function hasKey(locale, key) {
  return Object.prototype.hasOwnProperty.call(catalogs[locale] || {}, key);
}

/**
 * `translate('fa', 'cart.items', { count: 3 })`
 *
 * Placeholders are `{name}`. A numeric value is formatted for the locale (so
 * Persian gets ۳, not 3); a `{ $t: 'key' }` value is itself translated, which
 * lets an error carry "the order status" as a reference instead of a string
 * that would be stuck in one language; an array is translated element by
 * element and joined with the locale's list separator.
 *
 * With `count`, plural forms are chosen from `key.one` / `key.other`.
 */
export function translate(locale, key, params = {}) {
  const loc = normalizeLocale(locale);
  let template = lookup(loc, key, params);
  if (template === undefined && loc !== 'en') template = lookup('en', key, params);
  if (template === undefined) return key;
  return interpolate(template, params, loc);
}

function lookup(locale, key, params) {
  const catalog = catalogs[locale];
  if (!catalog) return undefined;
  if (typeof params?.count === 'number') {
    const category = new Intl.PluralRules(LOCALES[locale].intl).select(params.count);
    if (catalog[`${key}.${category}`] !== undefined) return catalog[`${key}.${category}`];
    if (catalog[`${key}.other`] !== undefined) return catalog[`${key}.other`];
  }
  return catalog[key];
}

function interpolate(template, params, locale) {
  return String(template).replace(/\{(\w+)\}/g, (match, name) => {
    if (!(name in (params || {}))) return match;
    return renderValue(params[name], locale);
  });
}

function renderValue(value, locale) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return formatNumber(value, locale);
  if (Array.isArray(value)) return value.map((entry) => renderValue(entry, locale)).join(LOCALES[locale].listSeparator);
  if (typeof value === 'object' && value.$t) return translate(locale, value.$t, value.params);
  if (typeof value === 'object' && value.$money) return formatMoney(value.$money.minor, value.$money.currency, locale);
  return String(value);
}

/** A reference to a translatable string, resolved when the message is shown. */
export const ref = (key, params) => ({ $t: key, params });

/** An amount of money, formatted in the reader's locale when the message is shown. */
export const moneyRef = (minor, currency) => ({ $money: { minor, currency } });

/** `t = translator('fa')`, then `t('key', params)`. */
export const translator = (locale) => (key, params) => translate(locale, key, params);

// -- Formatting --------------------------------------------------------------

export function formatNumber(value, locale = 'en', options = {}) {
  const loc = LOCALES[normalizeLocale(locale)];
  return new Intl.NumberFormat(loc.intl, options).format(Number(value));
}

/**
 * Dates in the locale's own calendar: Persian speakers read Jalali dates
 * (۱۴۰۵/۰۶/۳۰), and `fa-IR` selects that calendar and the Persian digits.
 */
export function formatDate(value, locale = 'en', options = { dateStyle: 'medium', timeStyle: 'short' }) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(LOCALES[normalizeLocale(locale)].intl, options).format(date);
}

export { en, fa };
