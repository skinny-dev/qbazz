import { ValidationError, fieldLabel, localizeError } from '../errors.js';
import { translate, hasKey } from '../i18n/index.js';
import { normalizeNumberInput, toLatinDigits } from './digits.js';

/**
 * Tiny declarative validator — no dependencies, shared by the HTTP layer and
 * the bot flows so a field rejected on Telegram is rejected identically on web.
 *
 *   validate(input, {
 *     title: { type: 'string', required: true, min: 2, max: 120 },
 *     price: { type: 'int', min: 0 },
 *     status: { type: 'enum', values: ['draft', 'active'], default: 'draft' },
 *   })
 *
 * Failures carry a translation key per field (see ValidationError.fields), so
 * the same failure reads correctly in Persian on Telegram and in English in an
 * API log. Numeric input accepts Persian and Arabic-Indic digits: ۱۲۵۰۰ is
 * 12500 to anyone typing on a Persian keyboard.
 */
class FieldError extends Error {
  constructor(key, params = {}, text = null) {
    super(text ?? translate('en', key, params));
    this.key = text === null ? key : null;
    this.params = params;
    this.text = text;
  }
}

export function validate(input, schema, { partial = false } = {}) {
  const out = {};
  const errors = {};
  const fields = {};
  const source = input && typeof input === 'object' ? input : {};

  for (const [field, rule] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(source, field);
    let value = source[field];

    if (!present || value === undefined || value === null || value === '') {
      if (partial && !present) continue;
      if (rule.default !== undefined) {
        out[field] = typeof rule.default === 'function' ? rule.default() : rule.default;
        continue;
      }
      if (rule.required && !partial) {
        const error = new FieldError('validation.required', { field: label(field, rule) });
        errors[field] = error.message;
        fields[field] = { key: error.key, params: error.params, label: rule.label };
      } else if (present && value === null && rule.nullable) out[field] = null;
      continue;
    }

    try {
      value = coerce(value, rule, field);
      checkRule(value, rule, field);
      if (rule.transform) value = rule.transform(value);
      out[field] = value;
    } catch (err) {
      if (err instanceof ValidationError && err.fields) {
        // A nested object failed: surface each inner field under a dotted name.
        for (const [inner, info] of Object.entries(err.fields)) {
          errors[`${field}.${inner}`] = err.details[inner];
          fields[`${field}.${inner}`] = info;
        }
      } else {
        errors[field] = err.message;
        fields[field] = err instanceof FieldError
          ? { key: err.key, params: err.params, text: err.text, label: rule.label }
          : { key: 'validation.invalid', params: { field: label(field, rule) }, label: rule.label };
      }
    }
  }

  if (Object.keys(errors).length) throw new ValidationError(errors, null, fields);
  return out;
}

/** The English label, used to build the English message. */
function label(field, rule) {
  return fieldLabel('en', field, rule.label);
}

const persianize = (text) => text.replace(/ي/g, 'ی').replace(/ك/g, 'ک');

function coerce(value, rule, field) {
  const name = label(field, rule);
  const fail = (key, params = {}) => new FieldError(key, { field: name, ...params });

  switch (rule.type) {
    case 'string': {
      if (typeof value === 'number') value = String(value);
      if (typeof value !== 'string') throw fail('validation.text');
      // Arabic keyboards type ي and ك where a Persian text has ی and ک. Store
      // the Persian forms so names and searches agree with each other.
      return persianize(rule.trim === false ? value : value.trim());
    }
    case 'int': {
      const n = typeof value === 'string' ? Number(normalizeNumberInput(value)) : Number(value);
      if (!Number.isFinite(n)) throw fail('validation.number');
      return Math.trunc(n);
    }
    case 'number': {
      const n = typeof value === 'string' ? Number(normalizeNumberInput(value)) : Number(value);
      if (!Number.isFinite(n)) throw fail('validation.number');
      return n;
    }
    case 'bool': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return /^(1|true|yes|on)$/i.test(value);
      return Boolean(value);
    }
    case 'enum': {
      const v = String(value);
      if (!rule.values.includes(v)) throw fail('validation.one_of', { values: rule.values.join(', ') });
      return v;
    }
    case 'array': {
      let arr = value;
      if (typeof arr === 'string') arr = arr.split(/[,،]/).map((s) => s.trim()).filter(Boolean);
      if (!Array.isArray(arr)) throw fail('validation.list');
      if (rule.of) arr = arr.map((item) => coerce(item, rule.of, field));
      return arr;
    }
    case 'object': {
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          throw fail('validation.object');
        }
      }
      if (typeof value !== 'object' || Array.isArray(value)) throw fail('validation.object');
      return rule.schema ? validate(value, rule.schema, { partial: rule.partial }) : value;
    }
    case 'email': {
      const v = String(value).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v)) throw fail('validation.email');
      return v;
    }
    case 'phone': {
      const v = toLatinDigits(value).replace(/[^\d+]/g, '');
      if (!/^\+?\d{7,15}$/.test(v)) throw fail('validation.phone');
      return v;
    }
    case 'url': {
      const v = String(value).trim();
      try {
        new URL(v);
      } catch {
        throw fail('validation.url');
      }
      return v;
    }
    case 'date': {
      const d = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(d.getTime())) throw fail('validation.date');
      return d.toISOString();
    }
    /**
     * A place, from either kind of picker. Telegram's "share location" button
     * and a browser's geolocation both give coordinates; typing gives a name.
     * Both normalise to the same shape so nothing downstream has to care which
     * surface the answer came from.
     */
    case 'location': {
      let input = value;
      if (typeof input === 'string') {
        const text = toLatinDigits(input).trim();
        // "6.5244,3.3792" — some clients send a bare coordinate pair.
        const pair = text.match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
        if (pair) input = { lat: Number(pair[1]), lng: Number(pair[2]) };
        else if (text.startsWith('{')) {
          try {
            input = JSON.parse(text);
          } catch {
            input = { city: persianize(input.trim()) };
          }
        } else input = { city: persianize(input.trim()) };
      }
      if (!input || typeof input !== 'object') throw fail('validation.place');

      const hasCoords = input.lat !== undefined && input.lat !== null && input.lng !== undefined && input.lng !== null;
      const city = input.city ? String(input.city).trim() : null;

      if (hasCoords) {
        const lat = Number(input.lat);
        const lng = Number(input.lng);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw fail('validation.lat');
        if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw fail('validation.lng');
        return { city, country: input.country || null, address: input.address || null, label: input.label || null, lat, lng };
      }

      if (!city || city.length < 2) throw fail('validation.city_short');
      if (city.length > 80) throw fail('validation.max_chars', { max: 80 });
      return { city, country: input.country || null, address: input.address || null, label: input.label || city, lat: null, lng: null };
    }
    default:
      return value;
  }
}

function checkRule(value, rule, field) {
  const name = label(field, rule);
  const fail = (key, params = {}) => new FieldError(key, { field: name, ...params });
  const isSized = typeof value === 'string' || Array.isArray(value);
  const size = isSized ? value.length : value;

  if (rule.min !== undefined && size < rule.min) {
    throw fail(isSized ? 'validation.min_chars' : 'validation.min_value', { min: rule.min });
  }
  if (rule.max !== undefined && size > rule.max) {
    throw fail(isSized ? 'validation.max_chars' : 'validation.max_value', { max: rule.max });
  }
  if (rule.pattern && !rule.pattern.test(String(value))) {
    throw rule.message ? new FieldError(null, {}, rule.message) : fail('validation.format');
  }
  if (rule.check) {
    const result = rule.check(value);
    if (result === true) return;
    // A check may answer with a catalog key, a literal message, or just "no".
    if (typeof result === 'string' && result.startsWith('err.') && hasKey('en', result)) throw new FieldError(result, {});
    if (typeof result === 'string') throw new FieldError(null, {}, result);
    throw fail('validation.invalid');
  }
}

/**
 * Convenience for bot flows: returns `{ ok, value, error }` instead of throwing,
 * with `error` already worded for `locale`.
 */
export function tryValidateField(value, rule, field = 'value', { locale = 'en' } = {}) {
  try {
    const out = validate({ [field]: value }, { [field]: rule });
    return { ok: true, value: out[field] };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: localizeError(err, locale) };
    return { ok: false, error: err.message };
  }
}
