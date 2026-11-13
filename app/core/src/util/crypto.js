import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function hmac(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Compact signed payload (`<base64url json>.<sig>`). Used for WebApp deep links
 * and one-shot magic links, where a full session token is too much to hand out.
 */
export function signPayload(secret, data, ttlSec = 900) {
  const body = { ...data, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${encoded}.${hmac(secret, encoded)}`;
}

export function verifyPayload(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  const expected = hmac(secret, encoded);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
