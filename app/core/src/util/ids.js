import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I/L/O/U

/**
 * Sortable, prefixed id: `ord_01J8Z...`. Time-ordered so "newest first"
 * listings work without an index, and readable enough to paste into support chat.
 */
export function newId(prefix) {
  const time = Date.now();
  let ts = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    ts = ALPHABET[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(8);
  let suffix = '';
  for (const byte of rand) suffix += ALPHABET[byte % 32];
  return prefix ? `${prefix}_${ts}${suffix}` : ts + suffix;
}

export const uuid = () => randomUUID();

/** Short human-facing code: order numbers, store claim codes, link codes. */
export function humanCode(length = 6, prefix = '') {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32];
  return prefix ? `${prefix}-${out}` : out;
}

export function numericCode(length = 6) {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += String(b % 10);
  return out;
}
