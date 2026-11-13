import { translate, hasKey, ref, effectiveLocale, LOCALES } from './i18n/index.js';

/**
 * Error taxonomy. Every service throws these; the HTTP layer is the only place
 * that knows how to turn them into status codes, so the same errors work
 * in-process (bot importing the core directly) and over REST.
 *
 * Errors are also *translatable*. A message can be given as a catalog key
 * (`new ConflictError('err.cart_empty')`): the English text becomes `.message`
 * — so logs and API clients that never asked for a language still read
 * sensibly — while `.key` and `.params` let a surface render it in the
 * reader's language with `localizeError(err, locale)`. A plain string still
 * works, and is simply not translated.
 */
export class AppError extends Error {
  constructor(messageOrKey, { status = 500, code = 'internal_error', details = null, params = null, key = null } = {}) {
    const keyed = typeof messageOrKey === 'string' && messageOrKey.startsWith('err.') && hasKey('en', messageOrKey);
    const resolvedKey = keyed ? messageOrKey : key;
    const resolvedParams = params || (keyed ? details : null);

    super(resolvedKey ? translate('en', resolvedKey, resolvedParams || {}) : messageOrKey);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.key = resolvedKey;
    this.params = resolvedParams;
    this.expose = status < 500;
  }

  /** `locale` is optional: without it the English message is returned. */
  toJSON(locale = null) {
    return {
      error: {
        code: this.code,
        message: locale ? localizeError(this, locale) : this.message,
        details: this.details,
      },
    };
  }
}

export class ValidationError extends AppError {
  /**
   * `details` is `{ field: message }`. `fields` (optional) is the same map as
   * `{ field: { key, params } }`, which is what lets a validation failure be
   * shown in the user's language instead of only in English.
   *
   * With a single failing field, that field's message *is* the message: the web
   * form shows `details` per input, but a chat surface has one line to work
   * with, and "Validation failed" tells nobody anything.
   */
  constructor(details, message = null, fields = null) {
    const only = details && typeof details === 'object' ? Object.values(details) : [];
    const resolved = message || (only.length === 1 && typeof only[0] === 'string' ? only[0] : translate('en', 'validation.failed'));
    super(resolved, { status: 422, code: 'validation_failed', details });
    this.fields = fields;
  }

  /** A failure on one field, with a translatable message. */
  static of(field, key, params = {}) {
    return new ValidationError(
      { [field]: translate('en', key, params) },
      null,
      { [field]: { key, params } },
    );
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Resource', id) {
    // Translate the noun as well: "Cart" is a thing the reader has a word for.
    const entityKey = `entity.${String(what).toLowerCase().replace(/\s+/g, '_')}`;
    const noun = hasKey('en', entityKey) ? ref(entityKey) : what;
    const key = id ? 'err.not_found' : 'err.not_found_plain';
    super(null, {
      status: 404,
      code: 'not_found',
      details: { resource: what, id: id ?? null },
      key,
      params: { what: noun, id },
    });
  }
}

export class ConflictError extends AppError {
  /**
   * `details` is what API clients receive; `params` (optional) is what the
   * message is built from, when that differs — e.g. `details.from` is the raw
   * status code while `params.from` is a reference that reads "Confirmed" or
   * "تأیید شد" depending on who is looking.
   */
  constructor(messageOrKey, details = null, params = null) {
    super(messageOrKey, { status: 409, code: 'conflict', details, params });
  }
}

export class UnauthorizedError extends AppError {
  constructor(messageOrKey = 'err.unauthorized') {
    super(messageOrKey, { status: 401, code: 'unauthorized' });
  }
}

export class ForbiddenError extends AppError {
  constructor(messageOrKey = 'err.forbidden', params = null) {
    super(messageOrKey, { status: 403, code: 'forbidden', params, details: null });
    if (params && !this.params) this.params = params;
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSec = 30) {
    super('Too many requests', { status: 429, code: 'rate_limited', details: { retryAfterSec } });
  }
}

export function isAppError(err) {
  return err instanceof AppError;
}

// ---------------------------------------------------------------------------

/**
 * The message for a reader in `locale`.
 *
 * Resolution order: a validation failure's per-field messages, then a keyed
 * error, then whatever message the error was constructed with. Nothing here
 * throws, so it is safe to call from any catch block.
 */
export function localizeError(err, locale = 'en') {
  if (!err) return '';
  try {
    if (err.fields && Object.keys(err.fields).length) {
      const separator = LOCALES[locale]?.listSeparator || ', ';
      return Object.entries(err.fields)
        .map(([name, info]) => {
          // A check that returned a plain sentence has no key to translate.
          if (!info.key) return info.text || '';
          // Nested failures are named "outer.inner"; the label is the inner field.
          const label = fieldLabel(locale, String(name).split('.').pop(), info.label);
          return translate(locale, info.key, { ...info.params, field: label });
        })
        .join(separator);
    }
    if (err.key) return translate(locale, err.key, err.params || {});
  } catch {
    // Fall through to the English message.
  }
  return err.message || '';
}

/** "Shop name" / "نام فروشگاه" for a field, falling back to a readable guess. */
export function fieldLabel(locale, name, fallback = null) {
  const key = `field.${name}`;
  if (hasKey(locale, key) || hasKey('en', key)) return translate(locale, key);
  if (fallback) return fallback;
  return String(name).replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/** For callers that hold an account rather than a locale string. */
export function localizeErrorFor(err, account, defaultLocale) {
  return localizeError(err, effectiveLocale(account, defaultLocale));
}
