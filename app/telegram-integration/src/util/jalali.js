/**
 * Solar Hijri (Persian) dates: what sellers think in ("۳ مهر ۱۴۰۵"), converted to the Gregorian ISO dates the
 * database stores. Algorithm: jalaali-js (public domain), kept here so no package is needed.
 */
const div = (a, b) => Math.trunc(a / b);
const mod = (a, b) => a - Math.trunc(a / b) * b;
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

function jalCal(jy) {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  let jump = 0;
  for (let i = 1; i < bl; i += 1) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function j2d(jy, jm, jd) {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

function d2j(jdn) {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

export const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

export function jalaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return jalCal(jy).leap === 0 ? 30 : 29;
}

/** Jalali y/m/d -> "YYYY-MM-DD" (Gregorian), or null when the date does not exist. */
export function jalaliToIso(jy, jm, jd) {
  if (![jy, jm, jd].every(Number.isInteger) || jm < 1 || jm > 12 || jd < 1 || jd > jalaliMonthLength(jy, jm)) return null;
  const { gy, gm, gd } = d2g(j2d(jy, jm, jd));
  return `${String(gy).padStart(4, '0')}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
}

/** "YYYY-MM-DD" (Gregorian) -> { jy, jm, jd }. */
export function isoToJalali(iso) {
  const [gy, gm, gd] = String(iso).slice(0, 10).split('-').map(Number);
  return d2j(g2d(gy, gm, gd));
}

const DIGITS = { '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9, '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9 };

/**
 * A range as it is written: "۳ مهر تا ۷ مهر", "1405/07/03 - 1405/07/07", "از ۳ مهر" (until now), "تا ۷ مهر" (from the start),
 * or one day ("۳ مهر"). Returns { from, to } as ISO dates (either may be null), or null when it cannot be read.
 */
export function parseDateRange(text, { now = new Date() } = {}) {
  const t = String(text || '').replace(/\u200c/g, ' ').trim();
  if (!t) return null;
  const one = (s) => parseDateInput(s.replace(/^(از|تا)\s+/, ''), { now });
  const both = t.split(/\s+(?:تا|to)\s+|\s*[–—]\s*|\s+-\s+/i);
  if (both.length === 2) {
    const [a, b] = [one(both[0].trim()), one(both[1].trim())];
    return a && b ? (a <= b ? { from: a, to: b } : { from: b, to: a }) : null;
  }
  if (/^از\s/.test(t)) { const a = one(t); return a ? { from: a, to: null } : null; }
  if (/^تا\s/.test(t)) { const b = one(t); return b ? { from: null, to: b } : null; }
  const day = one(t);
  return day ? { from: day, to: day } : null;
}

/**
 * What a seller types: "1405/07/03", "۱۴۰۵-۷-۳", "۳ مهر ۱۴۰۵", "3 مهر" (this year), or a Gregorian "2026-09-25".
 * Returns "YYYY-MM-DD" or null. `now` decides which year a bare "۳ مهر" means.
 */
export function parseDateInput(text, { now = new Date() } = {}) {
  const t = String(text || '').trim().replace(/[۰-۹٠-٩]/g, (d) => String(DIGITS[d]));
  if (!t) return null;
  const thisYear = isoToJalali(now.toISOString()).jy;

  let m = t.match(/^(\d{4})[\/\-.\s](\d{1,2})[\/\-.\s](\d{1,2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y >= 1700) return /^\d{4}-\d{2}-\d{2}$/.test(t) && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
    return jalaliToIso(y, mo, d);
  }
  const names = JALALI_MONTHS.map((n) => n.replace(/\s/g, ''));
  m = t.replace(/‌/g, '').match(/^(\d{1,2})\s*([^\d\s]+)(?:\s*(\d{4}))?$/);
  if (m) {
    const month = names.indexOf(m[2]) + 1;
    if (month) return jalaliToIso(m[3] ? Number(m[3]) : thisYear, month, Number(m[1]));
  }
  return null;
}
