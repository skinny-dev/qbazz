import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Turns Telegram Desktop channel exports (HTML) into live demo shops: one shop per channel, one product per
 * listing post, photos copied into the app's own uploads, products filed in the platform's categories.
 *
 *   npm run import:telegram -- "C:/path/ChatExport_2026-10-10" "C:/path/ChatExport_2026-10-10 (1)"
 *   npm run import:telegram -- --replace <dirs...>      remove an earlier import of the same shops first
 *
 * The posts are real; everything the channel does not say (stock, the owner account) is a demo value.
 * Phone numbers written in the posts are deliberately not copied: nobody should receive a call because of a demo.
 * Stop the core server first when the database is a JSON file; the server holds it in memory.
 */
process.env.QBAZZ_UPLOADS_PER_ACCOUNT ??= '20000'; // a whole catalogue of photos, not one person adding a few

const { createCore } = await import('../src/index.js');
const { COLLECTIONS } = await import('../src/models/schemas.js');

// What the exports do not carry: who the shop is. Matched to an export by the name of the channel in its header.
const PROFILES = [
  {
    match: /sarvin/i,
    owner: { telegram: '900000200', displayName: 'مدیر سروین' },
    store: {
      name: 'شال و روسری سروین',
      slug: 'sarvin-scarf',
      tagline: 'تولید و پخش عمدهٔ شال و روسری',
      description: 'تولید و پخش عمدهٔ شال و روسری سروین؛ شال و روسری نخی، مجلسی، توری و پاییزه با پارچهٔ وارداتی و درجه‌یک. فروش فقط به‌صورت عمده و ارسال به سراسر کشور.',
      group: 'scarves',
      location: { city: 'تهران', country: 'ایران', address: 'تهران، بازار بزرگ، پاساژ چهارسوق، طبقهٔ منفی ۲، پلاک ۲۱۳' },
      contact: { telegram: '@v_n303', instagram: 'sarvin_scarf__' },
    },
    intro: (title) => `${title}؛ تولید و پخش عمده توسط سروین. فروش فقط به‌صورت عمده و ارسال به سراسر کشور.`,
    // First rule that matches the title wins.
    categories: [
      [/مینی|سه\s*گوش/, 'mini-scarf'],
      [/^ست\s/, 'scarf-set'],
      [/روسری/, 'headscarf'],
      [/گردنی|بیگ\s*اسکارف|بافت|تدی/, 'neck-scarf'],
      [/شال/, 'shawl'],
    ],
    fallback: 'shawl',
    featured: true,
  },
  {
    match: /heski/i,
    owner: { telegram: '900000201', displayName: 'مدیر حسکی' },
    store: {
      name: 'حِسکی',
      slug: 'heski',
      tagline: 'تولید و پخش عمدهٔ تیشرت، دورس و هودی',
      description: 'تولید و پخش حِسکی؛ تیشرت پنبهٔ سوپر، دورس، هودی داخل‌کرکی و ست‌های زنانه و مردانه با قیمت عمده. خرید حضوری از بازار تهران.',
      group: 'upper-body',
      location: { city: 'تهران', country: 'ایران', address: 'تهران، بازار، کوچه حمام، چال‌سرای ملی، گذر ۴، همکف، پلاک ۳.۹۳' },
      contact: { telegram: '@Heskiadmin2' },
    },
    intro: (title) => `${title}؛ تولید و پخش حِسکی با قیمت عمده.`,
    categories: [
      [/هودی/, 'hoodie'],
      [/^ست\s|\sست\s/, 'lounge-set'],
      [/شلوار/, 'pants'],
      [/بلوز|تاپ/, 'blouse'],
      [/شومیز/, 'shomiz'],
      [/پیراهن/, 'shirt'],
      [/شکت|ژاکت/, 'cardigan'],
      [/دورس/, 'sweatshirt'],
      [/تیشرت|کراپ/, 'tshirt'],
    ],
    fallback: 'tshirt',
  },
  {
    // Posts carry a model code, fabric, colours and pack size but almost never a price ("message us for the price").
    match: /pooshak\s*aria|پوشاک آریا/i,
    parser: 'coded',
    owner: { telegram: '900000202', displayName: 'مدیر آی‌سان' },
    store: {
      name: 'تولید و پخش آی‌سان (ذبیحی)',
      slug: 'aysan-zabihi',
      tagline: 'تولید و پخش عمدهٔ پوشاک زنانه',
      description: 'تولید و پخش آی‌سان (ذبیحی)؛ پوشاک زنانهٔ فری‌سایز (۳۸ تا ۴۶) در بسته‌های عمده با کالکشن‌های بهاره، تابستانه و پاییزه‌زمستانه. قیمت هر مدل را از فروشنده استعلام کنید.',
      group: 'upper-body',
      location: { city: 'تهران', country: 'ایران', address: 'تهران، بازار' },
      contact: { telegram: '@pooshakaria', phone: '09118055243' },
    },
    intro: (title) => `${title}؛ تولید و پخش آی‌سان (ذبیحی). فروش عمده در بسته‌های مشخص؛ برای قیمت و موجودی از فروشنده استعلام کنید.`,
    categories: [
      [/کاپشن|پافر|بارونی|بامبر|میو/, 'jacket'],
      [/جکت|\sکت\s|^کت|بلیزر/, 'blazer'],
      [/شومیز/, 'shomiz'],
      [/پیراهن/, 'shirt'],
      [/سارافون/, 'sarafan'],
      [/مانتو/, 'manteau'],
      [/ژاکت|کاردیگان/, 'cardigan'],
      [/پالتو|شنل|پانچو/, 'overcoat'],
      [/شلوار/, 'pants'],
      [/تاپ|بلوز/, 'blouse'],
    ],
    fallback: 'tunic',
  },
];

// The same business also posts from a channel of its own ("Picha Store"): a different format, products added to the shop above.
PROFILES.push({
  ...PROFILES.find((p) => p.parser === 'coded'),
  match: /picha\s*store/i,
  parser: 'pinned',
  append: true,
  categories: [
    [/اسلش/, 'slash-pants'],
    [/شلوارک/, 'shorts'],
    [/بگ/, 'baggy-pants'],
    [/^ست\s/, 'lounge-set'],
    [/لگ/, 'leggings'],
    [/ساپورت/, 'supporter'],
    [/تیشرت|کراپ/, 'tshirt'],
    [/شلوار/, 'pants'],
  ],
  fallback: 'pants',
});

const PHOTOS_PER_PRODUCT = 8;

// ---------------------------------------------------------------------------
// Reading the export
// ---------------------------------------------------------------------------

const decode = (s) => s
  .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const textOf = (html) => decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g, (_, h, t) => t || h).replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').trim();

/** `{ title, channelPhoto, posts: [{ date, text, photos: [file…] }] }`; an album (consecutive "joined" messages) is one post. */
function readExport(dir, { from = null } = {}) {
  const files = fs.readdirSync(dir).filter((f) => /^messages\d*\.html$/.test(f)).sort((a, b) => (parseInt(a.replace(/\D/g, '') || '1', 10) - parseInt(b.replace(/\D/g, '') || '1', 10)));
  const out = { dir, title: '', channelPhoto: null, posts: [] };
  let current = null;
  for (const file of files) {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!out.title) out.title = decode((html.match(/<div class="text bold">\s*([\s\S]*?)\s*<\/div>/) || [])[1] || '').trim();
    for (const part of html.split(/<div class="message /).slice(1)) {
      const cls = part.slice(0, part.indexOf('"'));
      if (cls.startsWith('service')) {
        const note = textOf((part.match(/<div class="body details">([\s\S]*?)<\/div>/) || [])[1] || '');
        const photo = part.match(/class="userpic_link" href="([^"]+)"/);
        if (photo && /photo changed/.test(note)) out.channelPhoto = photo[1]; // the latest wins
        continue;
      }
      // a chat that holds posts forwarded from the channel: take only those that came from it
      if (from) {
        const source = (part.match(/<div class="forwarded body">\s*<div class="from_name">\s*([\s\S]*?)<span/) || [])[1];
        if (!source || !from.test(decode(source.replace(/<[^>]+>/g, '')))) continue;
      }
      const dateAttr = (part.match(/class="pull_right date details" title="([^"]+)"/) || [])[1] || '';
      const m = dateAttr.match(/(\d\d)\.(\d\d)\.(\d{4}) (\d\d:\d\d:\d\d)/);
      const date = m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}` : null;
      const photos = [...part.matchAll(/class="photo_wrap[^"]*" href="([^"]+)"/g)].map((x) => x[1]);
      const raw = (part.match(/<div class="text">([\s\S]*?)<\/div>\s*(?:<span class="reactions">|<\/div>|<div class="signature)/) || [])[1];
      const text = raw ? textOf(raw) : '';
      // "joined" only means the same sender posted again; an album is the run of messages sent in the same moment.
      // A message that brings its own caption after a captioned one starts the next post.
      const sameMoment = current && date && current.last && Math.abs(Date.parse(date) - Date.parse(current.last)) <= 2000;
      const newCaption = current && text && current.text && !current.text.includes(text) && !text.includes(current.text);
      if (!current || !sameMoment || newCaption) {
        current = { date, last: date, text, photos: [...photos] };
        out.posts.push(current);
      } else {
        current.photos.push(...photos);
        current.last = date;
        // Telegram can repeat the caption on each message of an album; keep the fullest copy once.
        if (text.length > current.text.length) current.text = text;
      }
    }
  }
  // Photos sent on their own, a few minutes around a captioned post, are more photos of that product.
  const near = (a, b) => a?.date && b?.date && Math.abs(Date.parse(a.last || a.date) - Date.parse(b.date)) <= 10 * 60 * 1000;
  const merged = [];
  let pending = [];
  for (const post of out.posts) {
    if (post.text) {
      post.photos.unshift(...pending.filter((p) => near(p, post)).flatMap((p) => p.photos));
      pending = [];
      merged.push(post);
    } else if (post.photos.length) {
      const previous = merged.at(-1);
      if (previous && near(previous, post) && pending.length === 0) { previous.photos.push(...post.photos); previous.last = post.last; }
      else pending.push(post);
    }
  }
  out.posts = merged;
  return out;
}

// ---------------------------------------------------------------------------
// Reading one post as a product
// ---------------------------------------------------------------------------

const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const toLatin = (s) => s.replace(/[۰-۹]/g, (d) => String(PERSIAN.indexOf(d))).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/(\d)\uFE0F?\u20E3/g, '$1');
const toPersian = (s) => String(s).replace(/\d/g, (d) => PERSIAN[d]);
const decor = /[^\p{L}\p{N}\s\-+&/().،:×٪%.]/gu;
const clean = (s) => s.replace(decor, ' ').replace(/[ \t]+/g, ' ').replace(/\s*&\s*/g, '×').trim();

// Lines from here on are the channel's footer (how to order, where to find them), not the product.
const FOOTER = /ارسال به سراسر|فروش\s*فقط|حداق\s*سفارش برای ارسال|ثبت سفارش|شماره تماس|ادرس|آدرس|خرید حضوری|تلفن|آیدی|اینستاگرام|instagram|@\w+|https?:|^_[\s_-]*$|جهت خرید/i;
const HEADER = /تولید\s*و?\s*پخش|^#/;

const number = (s) => {
  const n = Number(String(s).replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n >= 1000 && n <= 200_000_000 ? n : null;
};

function readProduct(raw) {
  // Arabic letter forms (ي ك ى) are common in typed Persian; the rest of the platform uses the Persian ones.
  const text = raw.replace(/ي/g, 'ی').replace(/ى/g, 'ی').replace(/ك/g, 'ک');
  const latin = toLatin(text);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const latinLines = latin.split('\n').map((l) => l.trim()).filter(Boolean);

  const titleIndex = lines.findIndex((l) => !HEADER.test(l) && clean(l).length >= 3 && !/^[_\s-]+$/.test(l));
  if (titleIndex < 0) return null;
  const title = clean(lines[titleIndex]).replace(/\s+/g, ' ');
  if (title.length < 3 || /^(سلام|موجود|ثبت سفارش)/.test(title)) return null;

  // Prices: a sale shows the old price and the current one; otherwise the first "قیمت".
  let price = null;
  let compareAtPrice = null;
  const was = latin.match(/قیمت\s*قبل\s*از\s*حراج\s*[:：]?\s*([\d/,٬.]+)/);
  const now = latin.match(/قیم[تة]\s*حال\s*حاظر\s*[:：]?\s*([\d/,٬.]+)/);
  if (was && now) { compareAtPrice = number(was[1]); price = number(now[1]); }
  if (!price) { const m = latin.match(/قیمت\s*[:：]?\s*([\d/,٬.]+)/); if (m) price = number(m[1]); }
  if (!price) return null;
  if (compareAtPrice && compareAtPrice <= price) compareAtPrice = null;

  const details = [];
  for (let i = titleIndex + 1; i < lines.length; i++) {
    if (FOOTER.test(lines[i]) || /^_/.test(lines[i])) { if (/^_/.test(lines[i])) continue; break; }
    const line = clean(lines[i]);
    if (!line || /^قیم[تة]/.test(line) || /قبل از حراج|حال حاظر/.test(line) || /^[×\s]*$/.test(line)) continue;
    details.push(line);
  }

  const properties = [];
  const add = (name, value) => { if (value && !properties.some((p) => p.name === name)) properties.push({ name, value: toPersian(value.trim().replace(/(\d)(?=[^\d\s.\/×])/g, '$1 ')) }); };
  for (const [i, line] of latinLines.entries()) {
    const original = clean(lines[i] ?? line);
    let m;
    if ((m = line.match(/قواره\s*[:：]?\s*([\d&×x/ ]+)/))) add('قواره', clean(m[1]));
    if ((m = line.match(/حداقل\s*سفارش\s*(?!برای)(.+)/))) add('حداقل سفارش', clean(m[1]));
    if ((m = line.match(/جنس\s*[:：]\s*(.+)/))) add('جنس', clean(m[1]));
    if ((m = line.match(/سایز\s*[:：]?\s*(.+)/))) add('سایز', clean(m[1]));
    if ((m = line.match(/عرض\s*سینه\s*[:：]?\s*(.+)/))) add('عرض سینه', clean(m[1]));
    if ((m = line.match(/(\d+)\s*(?:رنگ|طرح)/)) && !/تعداد\s*[:：]?\s*\d+\s*عدد/.test(line)) add(/طرح/.test(line) && !/رنگ/.test(line) ? 'تعداد طرح' : 'تعداد رنگ', m[1]);
    if ((m = line.match(/تعداد\s*[:：]?\s*(\d+)\s*عدد/))) add('تعداد در بسته', `${m[1]} عدد`);
    if ((m = line.match(/^کد\s*(\d+)/)) || (m = original && line.match(/\bکد\s*(\d+)/))) add('کد', m[1]);
  }

  const hash = text.match(/#([^\s#]+)/);
  const collection = hash ? hash[1].replace(/_/g, ' ') : null;
  return { title, price, compareAtPrice, details, properties, collection };
}

/**
 * One product per post, written as "📍" lines: the first is what it is, the rest are facts
 * ("📍جنس: …", "📍پک: ۶ عددی", "📍شلوار: قد ۱۰۵ سانت"). Prices are never in the post.
 */
function readPinned(raw) {
  const text = raw.replace(/ي/g, 'ی').replace(/ى/g, 'ی').replace(/ك/g, 'ک');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let title = null;
  const properties = [];
  const details = [];
  const add = (name, value) => { const v = String(value || '').trim(); if (v && !properties.some((p) => p.name === name)) properties.push({ name, value: toPersian(v.replace(/(\d)(?=[^\d\s.\/×])/g, '$1 ')) }); };
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('📍')) continue;
    const pin = clean(line.replace(/^📍+/, '')).replace(/\s+/g, ' ');
    let m;
    if ((m = pin.match(/^جنس\s*[:：]?\s*(.+)/))) add('جنس', m[1]);
    else if ((m = pin.match(/^سایز\s*[:：]?\s*(.+)/))) add('سایز', m[1].replace(/^سایز\s*/, ''));
    else if ((m = pin.match(/^پک\s*[:：]?\s*(.+)/))) add('بسته', m[1]);
    else if ((m = pin.match(/^رنگ\s*بندی\s*[:：]?\s*(.*)/))) {
      // the colour names sometimes follow on a line of their own
      const next = lines[i + 1];
      const names = next && !next.startsWith('📍') && !/🌹|لطفا/.test(next) ? clean(next) : '';
      add('رنگ‌بندی', [m[1], names].filter(Boolean).join(' — '));
    }
    else if ((m = toLatin(pin).match(/^(.+?)\s*[:：]\s*قد\s*(\d+)/))) add(`قد ${m[1].trim()}`, `${m[2]} سانتی‌متر`);
    else if ((m = toLatin(pin).match(/^قد\s*(.+?)\s*[:：]\s*(\d+)/))) add(`قد ${m[1].trim()}`, `${m[2]} سانتی‌متر`);
    else if (!title) title = pin;
    else if (pin.length > 2) details.push(pin);
  }
  if (!title || title.length < 3) return null;
  // "پک: ۶ عددی" / "۱۲ تایی" / "هر پک ۸ تا": that many pieces to a pack. "تعداد دلخواه" has no fixed size: sold by the piece.
  const packText = lines.find((l) => /^📍\s*پک/.test(l)) || '';
  const packSize = Number((toLatin(packText).match(/(\d{1,3})\s*(?:عدد|تا)/) || [])[1]);
  const saleUnit = packSize >= 2 ? { kind: 'pack', size: packSize, label: 'پک' } : null;
  return { title: toPersian(title), price: null, compareAtPrice: null, details, properties, collection: null, saleUnit };
}

// Model-code posts (آی‌سان): one product per code, however many times it was re-posted in new colours.
const CODE = /کد\s*[,،:.]?\s*(\d{1,4})/;
const FOOTER_CODED = /سفارش|تماس|wa\.me|@\w|^\d[\d ]{8,}|آیدی|پرفروش|تنخور|قیمت عالی|جهت مطلع|مطلع شدن|💥|📲|📞|📱|^_+$/;
const NOISE = /(مجدد|جدید|شارژ(\s*شد)?|رسید|رنگ\s*بندی|رنگ‌بندی|رنگهای|پر\s*فروش|مدل|کالکشن|☝️?|👆+)/g;

function readCoded(raw) {
  const text = raw.replace(/ي/g, 'ی').replace(/ى/g, 'ی').replace(/ك/g, 'ک');
  const latin = toLatin(text);
  const m = latin.match(CODE);
  if (!m) return null;
  const lines = latin.split('\n').map((l) => l.trim()).filter(Boolean);
  const codeIndex = lines.findIndex((l) => CODE.test(l));
  const codeLine = lines[codeIndex];
  const after = clean(codeLine.replace(/.*?کد\s*[,،:.]?\s*\d{1,4}/, '')).replace(NOISE, ' ').replace(/\s+(در|با)\s*\d.*$/, '').replace(/^[\s:،.\-–—]+|[\s:،.\-–—]+$/g, '').replace(/\s+/g, ' ').trim();
  const before = clean(codeLine.replace(/کد\s*[,،:.]?\s*\d{1,4}.*$/, '')).replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  const named = after || (before.length <= 24 ? before : '');
  // "در ۴ رنگ" / "۵ رنگ" describes colours, not what the garment is.
  const kind = /^(در|با)?\s*\d*\s*رنگ|^[\d\s]+$|^(در|با)\s*\d/.test(named) ? '' : toPersian(named.slice(0, 60).trim());

  const properties = [];
  const add = (name, value) => { const v = String(value || '').trim(); if (v && !properties.some((p) => p.name === name)) properties.push({ name, value: toPersian(v.replace(/(\d)(?=[^\d\s.\/×])/g, '$1 ')) }); };
  const details = [];
  let past = false;
  for (const [i, line] of lines.entries()) {
    let r;
    if ((r = line.match(/(?:جنس\s*)?پارچه(?:\s*ی)?\s*[:：.,،]?\s*(.+)/))) add('پارچه', clean(r[1]));
    if ((r = line.match(/رنگ\s*بندی\s*[:：]?\s*(.+)/)) && /\d/.test(r[1])) add('رنگ‌بندی', clean(r[1]));
    else if ((r = line.match(/^رنگ\s*[:：]\s*(.+)/))) add('رنگ', clean(r[1]));
    else if ((r = line.match(/(\d+)\s*رنگ/))) add('رنگ‌بندی', `${r[1]} رنگ`);
    if ((r = line.match(/فری\s*سایز.*|سایز\s*بندی\s*[:：]?\s*(.+)/))) add('سایز', clean(r[1] || r[0]));
    if ((r = line.match(/(?:پک|بسته(?:\s*های)?)\s*(\d+)\s*(?:تایی|عددی)?/))) add('بسته', `${r[1]} عددی`);
    if ((r = line.match(/قد\s*جلو\s*[:：]?\s*(\d+)/))) add('قد جلو', `${r[1]} سانتی‌متر`);
    if ((r = line.match(/قد\s*پشت\s*[:：]?\s*(\d+)/))) add('قد پشت', `${r[1]} سانتی‌متر`);
    if (i > codeIndex && !past) {
      if (FOOTER_CODED.test(line)) past = true;
      else { const d = clean(text.split('\n').map((l) => l.trim()).filter(Boolean)[i] ?? line); if (d.length > 2 && !/^[×\s]*$/.test(d)) details.push(d); }
    }
  }

  let price = null;
  const pm = latin.match(/(\d[\d/,٬.]{3,})\s*تومان/) || latin.match(/قیمت\s*[:：]?\s*(\d[\d/,٬.]*)/);
  if (pm) price = number(pm[1]);

  const fabric = properties.find((p) => p.name === 'پارچه')?.value;
  const codeFa = toPersian(m[1]);
  const title = kind ? `${kind} — کد ${codeFa}` : fabric ? `مدل کد ${codeFa} — ${fabric}` : `مدل کد ${codeFa}`;
  const collection = (latin.match(/کالکشن\s*([^\s\n]+)/) || [])[1] || null;
  return { code: m[1], title, kind, price, details, properties, collection, score: properties.length * 2 + (kind ? 3 : 0) + Math.min(details.length, 6) };
}

const STOP = new Set(['و', 'با', 'از', 'در', 'به', 'برای', 'یک', 'درجه', 'دار', 'وارداتی', 'اعلا', 'ساده']);
const SEASONS = { پاییز: 'پاییزه', زمستان: 'زمستانه', بهار: 'بهاره', تابستان: 'تابستانه' };
const tagsOf = (title, collection) => {
  const season = Object.keys(SEASONS).find((word) => collection?.includes(word));
  const words = title.split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^[\d×]+$/.test(w));
  return [...new Set([...(season ? [SEASONS[season]] : []), ...words])].slice(0, 6);
};

const jalaliMonth = (iso) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('fa-IR-u-ca-persian', { month: 'long', year: 'numeric' }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.month} ${parts.year}`;
};

// ---------------------------------------------------------------------------
// Building the shops
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const update = args.includes('--update'); // products already in the shop get the pack size they were missing
const forceProfile = option('profile'); // e.g. "picha": use that shop profile whatever the chat is called
const fromSource = option('from') ? new RegExp(option('from')) : null; // e.g. "آی\\s*سان": only posts forwarded from there
const dirs = args.filter((a, i) => !a.startsWith('--') && !['--profile', '--from'].includes(args[i - 1]));
if (!dirs.length) {
  console.log('Usage: npm run import:telegram -- [--replace] <ChatExport folder> [<ChatExport folder> …]');
  process.exit(1);
}

const plans = [];
for (const dir of dirs) {
  const data = readExport(dir, { from: fromSource });
  const profile = forceProfile ? PROFILES.find((p) => p.match.test(forceProfile)) : PROFILES.find((p) => p.match.test(data.title));
  if (!profile) { console.warn(`Skipping ${dir}: no shop profile for the channel "${data.title}".`); continue; }

  // One listing per (title, price, details): the same model re-posted in other colours is one product with more photos.
  const listings = new Map();
  let skipped = 0;
  if (profile.parser === 'coded') {
    const byCode = new Map();
    for (const post of data.posts) {
      if (!post.text || !post.photos.length) { skipped++; continue; }
      const read = readCoded(post.text);
      if (!read) { skipped++; continue; }
      const group = byCode.get(read.code) || { posts: [] };
      group.posts.push({ ...read, date: post.date, photos: post.photos });
      byCode.set(read.code, group);
    }
    for (const [code, group] of byCode) {
      const photos = group.posts.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).flatMap((p) => p.photos);
      if (photos.length < 2) { skipped += group.posts.length; continue; }
      // The fullest write-up wins; of equals, the newest.
      const best = group.posts.slice().sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)))[0];
      const price = best.price ?? group.posts.find((p) => p.price)?.price ?? null;
      listings.set(code, { title: best.title, price, compareAtPrice: null, details: best.details, properties: best.properties, collection: best.collection, photos, date: group.posts.map((p) => p.date).sort().at(-1) });
    }
  } else if (profile.parser === 'pinned') {
    for (const post of data.posts) {
      if (!post.text || !post.photos.length) { skipped++; continue; }
      const read = readPinned(post.text);
      if (!read) { skipped++; continue; }
      const signature = `${read.title}|${read.properties.map((p) => `${p.name}=${p.value}`).sort().join(';')}`;
      const existing = listings.get(signature);
      if (existing) existing.photos.push(...post.photos);
      else listings.set(signature, { ...read, photos: [...post.photos], date: post.date });
    }
  } else for (const post of data.posts) {
    if (!post.text || !post.photos.length) { skipped++; continue; }
    const product = readProduct(post.text);
    if (!product) { skipped++; continue; }
    const signature = `${product.title}|${product.price}|${product.properties.map((p) => `${p.name}=${p.value}`).sort().join(';')}`;
    const existing = listings.get(signature);
    if (existing) {
      existing.photos.push(...post.photos);
      existing.date = post.date || existing.date;
    } else {
      listings.set(signature, { ...product, photos: [...post.photos], date: post.date });
    }
  }

  // Two different offers under one name get told apart by the month they were posted.
  const items = [...listings.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const byTitle = new Map();
  for (const item of items) byTitle.set(item.title, (byTitle.get(item.title) || 0) + 1);
  for (const item of items) {
    if (byTitle.get(item.title) > 1) item.displayTitle = `${item.title} — ${jalaliMonth(item.date)}`;
    const rule = profile.categories.find(([re]) => re.test(item.title));
    item.category = rule ? rule[1] : profile.fallback;
  }
  // Still the same name (same month, different price or code): say which one it is.
  const shown = new Map();
  const ordinals = new Map();
  for (const item of items) { const t = item.displayTitle || item.title; shown.set(t, (shown.get(t) || 0) + 1); }
  for (const item of items) {
    const t = item.displayTitle || item.title;
    if (shown.get(t) < 2) continue;
    const code = item.properties.find((p) => p.name === 'کد')?.value;
    ordinals.set(t, (ordinals.get(t) || 0) + 1);
    item.displayTitle = code ? `${t} · کد ${code}` : item.price ? `${t} · ${toPersian(item.price.toLocaleString('en-US'))} تومان` : `${t} · مدل ${toPersian(ordinals.get(t))}`;
  }
  plans.push({ dir, data, profile, items, skipped });
}

if (args.includes('--dry')) {
  for (const { data, profile, items, skipped } of plans) {
    const counts = {};
    for (const item of items) counts[item.category] = (counts[item.category] || 0) + 1;
    console.log(`\n== ${profile.store.name}: ${items.length} products from ${data.posts.length} posts (${skipped} skipped)`, counts);
    for (const item of items.filter((_, i) => i % Math.ceil(items.length / 8) === 0)) {
      console.log(`- [${item.category}] ${item.displayTitle || item.title} | ${item.price}${item.compareAtPrice ? ` (was ${item.compareAtPrice})` : ''} | photos ${item.photos.length} | ${item.properties.map((p) => `${p.name}: ${p.value}`).join('; ')}`);
    }
  }
  process.exit(0);
}

const core = await createCore();
const { services } = core;

async function removeEarlier() {
  const accountIds = [];
  for (const profile of PROFILES) {
    const account = await services.accounts.findByIdentity('telegram', profile.owner.telegram);
    if (account) accountIds.push(account.id);
  }
  if (!accountIds.length) return;
  const stores = await core.store.collection(COLLECTIONS.stores).find({ where: { ownerAccountId: { $in: accountIds } } });
  const storeIds = stores.map((s) => s.id);
  if (core.config.storage.driver === 'json' && fs.existsSync(core.config.storage.file)) {
    const backup = `${core.config.storage.file}.bak-${Date.now()}`;
    fs.copyFileSync(core.config.storage.file, backup);
    console.log(`Backed up the database to ${backup}`);
  }
  // The photo files too, not only the rows that point at them.
  let files = 0;
  for (const row of await core.store.collection(COLLECTIONS.uploads).find({ where: { accountId: { $in: accountIds } } })) {
    try { fs.unlinkSync(path.join(core.config.uploads.dir, row.name)); files++; } catch { /* already gone */ }
  }
  console.log(`Deleted ${files} photo files.`);
  const keep = new Set([COLLECTIONS.categories, COLLECTIONS.events, COLLECTIONS.auditLogs, COLLECTIONS.searchLogs]);
  for (const name of Object.values(COLLECTIONS)) {
    if (keep.has(name)) continue;
    const collection = core.store.collection(name);
    if (name === COLLECTIONS.accounts) await collection.deleteWhere({ id: { $in: accountIds } });
    else if (name === COLLECTIONS.stores) await collection.deleteWhere({ id: { $in: storeIds } });
    else for (const [field, ids] of [['storeId', storeIds], ['accountId', accountIds], ['ownerAccountId', accountIds]]) await collection.deleteWhere({ [field]: { $in: ids } });
  }
  console.log(`Removed the earlier import (${stores.map((s) => s.name).join('، ')}).`);
}

if (replace) await removeEarlier();

const admin = await services.accounts.findByIdentity('email', 'admin@qbazz.app');
if (!admin) { console.error('No platform admin yet: run "npm run seed" once first.'); await core.close(); process.exit(1); }

const categories = await services.catalog.listCategories();
const cat = Object.fromEntries(categories.map((c) => [c.slug, c.id]));
if (!cat.scarves) { console.error('The "scarves" category group is missing; start the core once with the updated code so it syncs the taxonomy.'); await core.close(); process.exit(1); }

async function upload(accountId, file) {
  try {
    return (await services.uploads.saveImage(accountId, fs.readFileSync(file).toString('base64'))).url;
  } catch (err) {
    console.warn(`  photo skipped (${path.basename(file)}): ${err.message}`);
    return null;
  }
}

const summary = [];
for (const { dir, data, profile, items, skipped: unlisted } of plans) {
  let skipped = unlisted;
  const { account } = await services.accounts.resolveChannelIdentity({ channel: 'telegram', externalId: profile.owner.telegram, profile: { displayName: profile.owner.displayName } });
  const { store: shop } = { store: profile.store };
  const existingStore = profile.append ? (await core.store.collection(COLLECTIONS.stores).find({ where: { slug: shop.slug } }))[0] : null;
  const store = existingStore || await services.stores.create(account.id, {
    name: shop.name,
    slug: shop.slug,
    tagline: shop.tagline,
    description: shop.description,
    categoryIds: [cat[shop.group]],
    currency: 'IRT',
    location: shop.location,
    contact: shop.contact,
    settings: { paymentMethods: ['online'], fulfillmentMethods: ['delivery', 'pickup'], deliveryFee: 0, shippingPayer: 'buyer', prepTimeMinutes: 1440 },
  });
  const drawn = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed-logos', `${shop.slug}.png`);
  const logoFile = data.channelPhoto && fs.existsSync(path.join(dir, data.channelPhoto)) ? path.join(dir, data.channelPhoto) : fs.existsSync(drawn) ? drawn : null;
  if (logoFile && !existingStore) {
    const url = await upload(account.id, logoFile);
    if (url) await services.stores.update(store.id, { logoUrl: url });
  }

  const owner = existingStore ? ((await services.accounts.get(existingStore.ownerAccountId)) || account) : account;
  const have = new Map(existingStore ? (await core.store.collection(COLLECTIONS.products).find({ where: { storeId: store.id } })).map((p) => [p.title, p]) : []);
  const groupIds = new Set();
  let made = 0;
  let updated = 0;
  for (const item of items) {
    const title = item.displayTitle || item.title;
    if (have.has(title)) {
      const old = have.get(title);
      if (update && item.saleUnit && old.saleUnit?.kind !== 'pack') { await services.catalog.updateProduct(old.id, { saleUnit: item.saleUnit }, { actorAccountId: owner.id }); updated++; }
      skipped++;
      continue;
    }
    const urls = [];
    for (const file of item.photos) {
      if (urls.length >= PHOTOS_PER_PRODUCT) break;
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) continue;
      const url = await upload(owner.id, full);
      if (url) urls.push(url);
    }
    if (!urls.length) { skipped++; continue; }
    const description = [profile.intro(item.title), '', ...item.details.map((d) => `• ${toPersian(d)}`)].join('\n').trim();
    await services.catalog.createProduct(store.id, {
      title,
      description,
      ...(item.price ? { price: item.price, priceVisibility: 'public' } : { price: null, priceVisibility: 'inquire' }),
      ...(item.compareAtPrice ? { compareAtPrice: item.compareAtPrice } : {}),
      currency: 'IRT',
      images: urls,
      categoryId: cat[item.category],
      tags: tagsOf(item.title, item.collection),
      properties: item.properties,
      ...(item.saleUnit ? { saleUnit: item.saleUnit } : {}),
      status: 'active',
    }, { actorAccountId: owner.id });
    made++;
    const parent = categories.find((c) => c.id === cat[item.category])?.parentId;
    if (parent) groupIds.add(parent);
    if (made % 20 === 0) console.log(`  ${shop.name}: ${made}/${items.length} products`);
  }

  if (existingStore) {
    // the shop now sells in more groups than it started with
    await services.stores.update(store.id, { categoryIds: [...new Set([...(store.categoryIds || []), ...groupIds])] });
  } else {
    await services.stores.submitForReview(store.id, account.id);
    await services.admin.approveStore(admin.id, store.id);
  }
  if (profile.featured) await services.admin.setFeatured(admin.id, store.id, true);
  const live = await services.stores.get(store.id);
  if (live.status !== 'active') console.warn(`  WARNING: ${shop.name} is ${live.status}, not active — approve it in the admin area.`);
  summary.push(`${shop.name}: ${made} products from ${data.posts.length} posts (${skipped} not new${updated ? `, ${updated} given their pack size` : ''})`);
}

console.log(`\nImported\n  ${summary.join('\n  ')}`);
await core.close();
