/**
 * Reads a pile of channel posts as products, offline and for free (no AI, no credits), the way a person skims them:
 * what every post repeats (a header, a phone number, an address) is not about any one product, the first real line is
 * its name, "قیمت ۱۲۸/۰۰۰" is its price, "جنس: …" lines are its facts. It would rather leave a field empty than guess:
 * the seller reviews every product before it goes live.
 */
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
export const toLatin = (s) => String(s).replace(/[۰-۹]/g, (d) => String(PERSIAN.indexOf(d))).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/(\d)️?⃣/g, '$1');
export const toPersian = (s) => String(s).replace(/\d/g, (d) => PERSIAN[d]);
const arabicLetters = (s) => String(s).replace(/ي/g, 'ی').replace(/ى/g, 'ی').replace(/ك/g, 'ک');
const DECOR = /[^\p{L}\p{N}\s\-+&/().،:×٪%.؟!]/gu;
const tidy = (s) => arabicLetters(s).replace(DECOR, ' ').replace(/[ \t]+/g, ' ').replace(/\s*&\s*/g, '×').trim();
const key = (line) => toLatin(tidy(line)).replace(/\s+/g, ' ').toLowerCase();

const SEPARATOR = /^[\s_\-=•·.*~]+$/;
// Lines that are about the shop, not the product, even when only one post has them.
const CONTACT = /(تلفن|شماره\s*تماس|تماس\s*بگیرید|آدرس|ادرس|واتس\s*اپ|whatsapp|wa\.me|instagram|اینستاگرام|ثبت\s*سفارش|جهت\s*سفارش|برای\s*سفارش|آیدی|https?:|t\.me|@\w{3,})/i;
const PHONE = /(?:\+?98|0)?9\d{9}|0\d{2}[\s-]?\d{8}/;

/** Lines repeated by a quarter of the posts (at least three) - the channel's own header, footer, slogan. */
export function boilerplate(texts) {
  const seen = new Map();
  for (const text of texts) {
    for (const k of new Set(String(text || '').split('\n').map(key).filter((k) => k.length >= 4))) seen.set(k, (seen.get(k) || 0) + 1);
  }
  const floor = Math.max(3, Math.ceil(texts.length * 0.25));
  return new Set([...seen].filter(([, n]) => n >= floor).map(([k]) => k));
}

/** One amount from a line: "۱۲۸/۰۰۰", "۲۵۰ هزار تومان", "۱.۵ میلیون", "82000 تومان". Null when it is not a believable price. */
export function amountIn(line) {
  const text = toLatin(line);
  const m = text.match(/(\d{1,3}(?:[\/٬,،.]\d{3})+|\d+(?:\.\d+)?)/);
  if (!m) return null;
  let n;
  if (/[\/٬,،]/.test(m[1]) || /\.\d{3}(?!\d)/.test(m[1])) n = Number(m[1].replace(/[\/٬,،.]/g, ''));
  else n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (/میلیون/.test(text)) n *= 1_000_000;
  else if (/هزار/.test(text)) n *= 1000;
  return n >= 1000 && n <= 500_000_000 ? Math.round(n) : null;
}

const SOLD_OUT = /(نا\s*موجود|تمام\s*(شد|شده)|تموم\s*شد|اتمام\s*(موجودی|شد)|موجود\s*نیست|فروخته\s*شد|sold\s*out)/i;
const BACK = /(شارژ(\s*مجدد)?\s*شد|موجود\s*شد)/;
const AVAILABILITY = /(نا\s*موجود|تمام\s*(شد|شده)|تموم\s*شد|اتمام\s*(موجودی|شد)|موجود\s*نیست|فروخته\s*شد|شارژ(\s*مجدد)?\s*شد|موجود\s*شد|sold\s*out)/i;

/**
 * `{ usable, reason?, title, description, price, compareAtPrice, properties, tags, soldOut, confidence }`.
 * `boiler` is what `boilerplate()` found across all of the channel's posts.
 */
export function readPost(text, { boiler = new Set(), hasPhoto = true } = {}) {
  const all = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const kept = all.filter((l) => !boiler.has(key(l)) && !SEPARATOR.test(l));
  // a stock note ("❌ناموجود❌", "شارژ شد") is a note about the product, not its name
  const isNote = (l) => AVAILABILITY.test(arabicLetters(tidy(l))) && tidy(l).length <= 32;
  const notes = kept.filter(isNote);
  const lines = kept.filter((l) => !isNote(l));
  const noted = arabicLetters(notes.join(' '));
  const soldOut = SOLD_OUT.test(noted) && !BACK.test(noted);
  const none = (reason) => ({ usable: false, reason });
  if (!hasPhoto) return none('no_photo');
  if (!lines.length) return none('empty');
  if (notes.length && lines.length <= 1) return none('availability_note');

  const hashtags = [...String(text).matchAll(/#([^\s#]+)/g)].map((m) => m[1].replace(/_/g, ' ')).slice(0, 5);
  const content = lines.filter((l) => !/^(?:#[^\s#]+\s*)+$/.test(l) && !CONTACT.test(l) && !PHONE.test(toLatin(l).replace(/[\s-]/g, '')));

  let price = null;
  let compareAtPrice = null;
  const priceLines = new Set();
  for (const line of content) {
    const plain = arabicLetters(line);
    if (!/(قیمت|تومان|تومن|هزار|میلیون|ریال)/.test(plain)) continue;
    const amount = amountIn(line);
    if (amount == null) continue;
    if (/(قبل|اصلی|بدون\s*تخفیف|حراج\s*نشده)/.test(plain)) compareAtPrice = compareAtPrice ?? amount;
    else if (price == null || /(حال\s*حاضر|فعلی|جدید|با\s*تخفیف)/.test(plain)) price = amount;
    priceLines.add(line);
  }
  if (compareAtPrice != null && price != null && compareAtPrice <= price) compareAtPrice = null;
  if (compareAtPrice != null && price == null) { price = compareAtPrice; compareAtPrice = null; }

  // The name: the first line that says what it is. A model code ("کد ۴۳۷ بامبر چرم") keeps the code at the end.
  const isFact = (l) => /^[^:：]{1,24}[:：]\s*\S/.test(tidy(l)) && !/کد\s*[\d۰-۹٠-٩]/.test(l);
  const codeLine = content.find((l) => /(?:^|\s|[:：])کد\s*[,،:.]?\s*[\d۰-۹٠-٩]{1,5}/.test(l) && !priceLines.has(l));
  const pool = content.filter((l) => !priceLines.has(l));
  const first = codeLine || pool.find((l) => !isFact(l) && tidy(l).replace(/[\d\s]/g, '').length >= 3) || pool[0];
  if (!first) return none('no_title');
  let title = tidy(first).replace(/^(?:مدل|جدید|کالکشن[^\s]*)\s*[:：]?\s*/g, '').trim();
  const code = toLatin(title).match(/کد\s*[,،:.]?\s*(\d{1,5})/);
  if (code) {
    const rest = tidy(title.replace(/.*?کد\s*[,،:.]?\s*[\d۰-۹٠-٩]{1,5}/, '')).replace(/^[\s:،.\-–—]+/, '').replace(/[\s:،.\-–—]+$/, '').trim();
    title = rest ? `${rest} — کد ${toPersian(code[1])}` : `مدل کد ${toPersian(code[1])}`;
  }
  title = toPersian(title.replace(/\s+/g, ' ')).slice(0, 90).trim();
  if (title.length < 3) return none('no_title');

  const properties = [];
  const rest = [];
  for (const line of content) {
    if (line === first || priceLines.has(line)) continue;
    const m = isFact(line) ? tidy(line).match(/^([^:：]{1,24})[:：]\s*(.{1,140})$/) : null;
    if (m && properties.length < 10 && !properties.some((p) => p.name === m[1].trim())) properties.push({ name: m[1].trim(), value: toPersian(m[2].trim()) });
    else rest.push(tidy(line));
  }
  if (code && !properties.some((p) => p.name === 'کد')) properties.push({ name: 'کد', value: toPersian(code[1]) });
  const description = toPersian(rest.filter(Boolean).join('\n')).slice(0, 1500);

  const words = title.split(/\s+/).filter((w) => w.length >= 3 && !/^[\d۰-۹—]+$/.test(w)).slice(0, 3);
  const tags = [...new Set([...hashtags, ...words])].slice(0, 6);
  const confidence = price != null && properties.length >= 1 ? 'high' : price != null || properties.length >= 2 ? 'medium' : 'low';
  return { usable: true, title, description, price, compareAtPrice, properties, tags, soldOut, confidence };
}
