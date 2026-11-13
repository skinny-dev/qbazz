import { COLLECTIONS } from '../models/schemas.js';
import { ConflictError, UnauthorizedError } from '../errors.js';
import { newId } from '../util/ids.js';
import { validate } from '../util/validate.js';
import { canonicalPhone } from '../util/phone.js';

/**
 * Phone login codes. One active code per phone number — asking again just
 * overwrites it, so a seller who mistyped and re-requested is never stuck
 * juggling two valid codes.
 *
 * SMS delivery is pluggable and degrades the same way every other optional
 * provider in this app does: no key configured, and the code is written to
 * the server log instead of sent, so the whole login flow is testable from a
 * fresh checkout with zero setup.
 */
export function createOtpService(ctx) {
  const { store, config, log } = ctx;
  const codes = store.collection(COLLECTIONS.otpCodes);

  // No gateway is usable yet (no key, or a generic gateway without its address): codes go to the log instead.
  const gatewayReady = () => config.sms.provider !== 'console' && Boolean(config.sms.apiKey) && !(config.sms.provider === 'http' && !config.sms.url);

  function normalizePhone(phone) {
    return canonicalPhone(validate({ phone }, { phone: { type: 'phone', required: true } }).phone);
  }

  async function requestCode(phone) {
    const normalized = normalizePhone(phone);
    const existing = await codes.findOne({ phone: normalized });
    const now = Date.now();

    if (existing) {
      const sinceLastSend = now - new Date(existing.lastSentAt).getTime();
      const cooldownMs = config.auth.otpResendCooldownSec * 1000;
      if (sinceLastSend < cooldownMs) {
        throw new ConflictError('err.otp_cooldown', { retryInSec: Math.ceil((cooldownMs - sinceLastSend) / 1000) });
      }
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const record = {
      phone: normalized,
      code,
      attempts: 0,
      expiresAt: new Date(now + config.auth.otpTtlSec * 1000).toISOString(),
      lastSentAt: new Date().toISOString(),
    };
    if (existing) await codes.update(existing.id, record);
    else await codes.insert({ id: newId('otp'), ...record });

    await sendSms(normalized, code);
    // Dev convenience only: with no real SMS gateway the code goes to the server log
    // anyway, so echo it to the caller too — never once a gateway is configured or in production.
    const devEcho = config.env !== 'production' && !gatewayReady();
    return { phone: normalized, expiresInSec: config.auth.otpTtlSec, ...(devEcho ? { devCode: code } : {}) };
  }

  /** Consumes the code on success; a wrong guess just counts against the limit. */
  async function verifyCode(phone, code) {
    const normalized = normalizePhone(phone);
    const record = await codes.findOne({ phone: normalized });
    if (!record) throw new UnauthorizedError('err.otp_not_requested');

    if (new Date(record.expiresAt) < new Date()) {
      await codes.delete(record.id);
      throw new UnauthorizedError('err.otp_expired');
    }
    if (record.attempts >= config.auth.otpMaxAttempts) {
      await codes.delete(record.id);
      throw new UnauthorizedError('err.otp_too_many_attempts');
    }
    if (String(code || '').trim() !== record.code) {
      await codes.update(record.id, { attempts: record.attempts + 1 });
      throw new UnauthorizedError('err.otp_invalid');
    }

    await codes.delete(record.id);
    return normalized;
  }

  async function sendSms(phone, code) {
    const text = (config.sms.provider === 'http' ? config.sms.text : 'Qbazz verification code: {code}').replace('{code}', code);
    if (!gatewayReady()) {
      log.info(`[sms → ${phone}] ${text}`);
      return;
    }
    // A real provider plugs in here — Kavenegar's REST API, or whichever
    // gateway is actually configured. Wired once real credentials are given;
    // failing to send must never throw past this point silently losing the
    // code the caller already committed to, so a provider failure logs and
    // still lets the (already-generated, already-stored) code work if the
    // seller somehow received it another way. In practice: fix the provider.
    try {
      await deliver(config.sms, phone, text, code);
    } catch (err) {
      log.warn(`SMS delivery failed for ${phone} (${err.message}) — code is still valid if the seller has it another way`);
    }
  }

  async function deliver(sms, phone, text, code) {
    if (sms.provider === 'kavenegar') {
      const url = `https://api.kavenegar.com/v1/${sms.apiKey}/sms/send.json`;
      const params = new URLSearchParams({ receptor: phone, message: text, ...(sms.sender ? { sender: sms.sender } : {}) });
      const res = await fetch(`${url}?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.return?.status >= 300) throw new Error(data.return?.message || `Kavenegar request failed (${res.status})`);
      return;
    }
    if (sms.provider === 'http') return deliverHttp(sms, phone, code, text);
    throw new Error(`Unknown SMS provider: ${sms.provider}`);
  }

  /**
   * A gateway reached by a plain JSON request - the address, body and header come from the environment, so a provider
   * whose documentation says "POST this JSON with a Bearer key" needs no code. `{phone}` is +98912…, `{phoneLocal}`
   * 0912…, `{phoneIntl}` 98912…; a body value that is exactly `{code}` stays a string, `{codeNumber}` becomes a number.
   */
  async function deliverHttp(sms, phone, code, text) {
    if (!sms.url) throw new Error('QBAZZ_SMS_URL is not set');
    const digits = phone.replace(/\D/g, '');
    const vars = { phone, phoneIntl: digits, phoneLocal: digits.startsWith('98') ? `0${digits.slice(2)}` : digits, code, text };
    const fill = (value) => {
      if (typeof value === 'string') {
        if (value === '{codeNumber}') return Number(code);
        return value.replace(/\{(phone|phoneIntl|phoneLocal|code|text)\}/g, (_, k) => vars[k]);
      }
      if (Array.isArray(value)) return value.map(fill);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
      return value;
    };
    const headers = { 'content-type': 'application/json', accept: 'application/json', ...(sms.headers ? JSON.parse(sms.headers) : {}) };
    if (sms.auth === 'bearer') headers.authorization = `Bearer ${sms.apiKey}`;
    else if (sms.auth.startsWith('header:')) headers[sms.auth.slice(7)] = sms.apiKey;
    const method = String(sms.method || 'POST').toUpperCase();
    const body = fill(JSON.parse(sms.body));
    const url = method === 'GET' ? `${sms.url}${sms.url.includes('?') ? '&' : '?'}${new URLSearchParams(body)}` : sms.url;
    const res = await (sms.fetch || fetch)(url, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`SMS gateway answered ${res.status}`);
    // api.ir and similar gateways answer 200 with { success, message } - the body decides
    const answer = typeof res.json === 'function' ? await res.json().catch(() => null) : null;
    if (answer && typeof answer === 'object' && answer.success === false) throw new Error(`SMS gateway refused: ${answer.message || answer.code || 'unknown'}`);
  }

  return { requestCode, verifyCode };
}
