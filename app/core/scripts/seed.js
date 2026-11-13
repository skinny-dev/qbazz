import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '../src/index.js';
import { COLLECTIONS } from '../src/models/schemas.js';

/**
 * Fills a database with enough to see every surface working, all of it in
 * Persian and priced in Toman: an admin, five live clothing shops (one per kind
 * of business the taxonomy covers), a shop waiting in the review queue, and two
 * buyers with delivered, rated orders.
 *
 *   npm run seed                    a fresh database
 *   npm run seed -- --force         add the samples next to what is there
 *   npm run seed -- --replace       remove the samples from an earlier run first,
 *                                   then seed (real shops are left alone)
 *
 * Stop the bot before seeding a JSON-file database: the bot holds the database
 * in memory and would write its own copy over the seed.
 */
const core = await createCore();
const { services } = core;

// Readable slugs are set by hand: Persian names transliterate to consonants only (mzon-stare),
// and a slug ends up in web URLs and Telegram share links.
// Toman has no minor unit, so a price written in Toman is already the stored integer.
const CURRENCY = 'IRT';
const toman = (amount) => amount;

const ADMIN_EMAIL = 'admin@qbazz.app';
// The fake Telegram ids the samples use. They are how --replace tells samples from real people.
const SAMPLE_TELEGRAM_IDS = ['900000001', '900000002', '900000003', '900000004', '900000005', '900000006', '900000100', '900000101'];

const args = new Set(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Product photos: real e-commerce clothing photos from the DummyJSON test
// catalogue (see seed-photos.json). Each is downloaded once, kept in a local
// cache folder, and stored in the app's own uploads - so after the first seed
// the shop works without the internet. A product gets photos only when one in
// the manifest genuinely matches it; the rest stay photo-less rather than
// showing a wrong garment.
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const manifestFile = JSON.parse(fs.readFileSync(path.join(here, 'seed-photos.json'), 'utf8'));
const manifest = manifestFile.photos;
const avatarSources = manifestFile.avatars || {};
const photoCache = path.join(here, '.seed-photo-cache');
const storedPhotos = new Map();
let photoFailures = 0;

/**
 * Downloads one photo with curl. Through some proxies a connection stays open
 * after the last byte, which makes node's fetch wait forever for a file that is
 * already complete; curl with a short time limit keeps what arrived, and a WebP
 * declares its own length, so "complete" can be checked rather than assumed.
 * Retried, since those proxies also drop the odd request.
 */
const run = promisify(execFile);

function isCompleteImage(buffer) {
  if (buffer.length < 500) return false;
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') return buffer.length >= buffer.readUInt32LE(4) + 8;
  return buffer[0] === 0xff || buffer[0] === 0x89; // JPEG / PNG: trust a finished transfer
}

async function fetchPhoto(src) {
  const file = path.join(photoCache, `${crypto.createHash('sha1').update(src).digest('hex')}.img`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  fs.mkdirSync(photoCache, { recursive: true });

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || '';
  let lastError = new Error('download failed');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // Direct first (this CDN is reachable without a proxy and much faster); the proxy only if that fails.
      await run('curl', ['-sS', '-L', '--max-time', attempt === 1 ? '20' : '45', '-o', file, ...(proxy && attempt > 1 ? ['-x', proxy] : []), src]);
    } catch (err) {
      lastError = err; // exit 28 = time limit; the bytes that arrived are still in the file
    }
    if (fs.existsSync(file)) {
      const buffer = fs.readFileSync(file);
      if (isCompleteImage(buffer)) return buffer;
      fs.rmSync(file, { force: true });
      lastError = new Error('incomplete download');
    }
  }
  throw lastError;
}

/** Fetches every photo in the manifest, eight at a time, so a slow proxy costs minutes once instead of one by one. */
async function prefetchPhotos(keys) {
  const sources = [...new Set(keys.flatMap((key) => manifest[key] || []))];
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < sources.length) {
      const src = sources[next++];
      try { await fetchPhoto(src); } catch { /* reported when the product asks for it */ }
      done += 1;
      if (done % 8 === 0 || done === sources.length) console.log(`  photos downloaded: ${done}/${sources.length}`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
}

/** Stores the manifest photos for `key` as uploads owned by `accountId`; returns their URLs ([] if unavailable). */
async function storePhotos(key, accountId) {
  const sources = manifest[key];
  if (!sources) return [];
  const urls = [];
  for (const src of sources) {
    const cacheKey = `${accountId}|${src}`;
    try {
      if (!storedPhotos.has(cacheKey)) {
        const buffer = await fetchPhoto(src);
        storedPhotos.set(cacheKey, (await services.uploads.saveImage(accountId, buffer.toString('base64'))).url);
      }
      urls.push(storedPhotos.get(cacheKey));
    } catch (err) {
      photoFailures += 1;
      console.warn(`  photo skipped (${key}): ${err.message}`);
    }
  }
  return urls;
}

/** A profile picture for a person: a portrait from the manifest, keyed by their Telegram id. */
async function giveAvatar(account, key) {
  const src = avatarSources[key];
  if (!src) return;
  try {
    const buffer = await fetchPhoto(src);
    const uploaded = await services.uploads.saveImage(account.id, buffer.toString('base64'));
    await services.accounts.update(account.id, { avatarUrl: uploaded.url });
  } catch (err) {
    photoFailures += 1;
    console.warn(`  avatar skipped (${key}): ${err.message}`);
  }
}

/** A drawn logo (scripts/seed-logos/<slug>.png, made by make-logos.ps1) for a shop - or for the platform admin's profile. */
async function giveLogo(slug, ownerAccountId, apply) {
  const file = path.join(here, 'seed-logos', `${slug}.png`);
  if (!fs.existsSync(file)) return;
  const uploaded = await services.uploads.saveImage(ownerAccountId, fs.readFileSync(file).toString('base64'));
  await apply(uploaded.url);
}

// ---------------------------------------------------------------------------
// --replace: remove what an earlier run created, and only that.
// ---------------------------------------------------------------------------

async function removeEarlierSamples() {
  const accountIds = [];
  for (const id of SAMPLE_TELEGRAM_IDS) {
    const account = await services.accounts.findByIdentity('telegram', id);
    if (account) accountIds.push(account.id);
  }
  if (!accountIds.length) {
    console.log('No earlier sample data found.');
    return;
  }

  const stores = await core.store.collection(COLLECTIONS.stores).find({ where: { ownerAccountId: { $in: accountIds } } });
  const storeIds = stores.map((store) => store.id);

  if (core.config.storage.driver === 'json' && fs.existsSync(core.config.storage.file)) {
    const backup = `${core.config.storage.file}.bak-${Date.now()}`;
    fs.copyFileSync(core.config.storage.file, backup);
    console.log(`Backed up the database to ${backup}`);
  }

  // Keep the admin, the taxonomy and the history logs; everything the samples own goes.
  const keep = new Set([COLLECTIONS.categories, COLLECTIONS.events, COLLECTIONS.auditLogs, COLLECTIONS.searchLogs]);
  const removed = {};
  for (const name of Object.values(COLLECTIONS)) {
    if (keep.has(name)) continue;
    const collection = core.store.collection(name);
    let count = 0;
    if (name === COLLECTIONS.accounts) count += await collection.deleteWhere({ id: { $in: accountIds } });
    else if (name === COLLECTIONS.stores) count += await collection.deleteWhere({ id: { $in: storeIds } });
    else {
      for (const [field, ids] of [['storeId', storeIds], ['accountId', accountIds], ['ownerAccountId', accountIds]]) {
        count += await collection.deleteWhere({ [field]: { $in: ids } });
      }
    }
    if (count) removed[name] = count;
  }
  console.log(`Removed earlier samples (${stores.map((store) => store.name).join('، ')}):`, removed);
}

if (args.has('--replace')) {
  await removeEarlierSamples();
} else {
  const existing = await services.stores.list({ limit: 1 });
  if (existing.total > 0 && !args.has('--force')) {
    console.log('Database already has stores. Re-run with --replace to swap the earlier samples for these, or --force to add these anyway.');
    await core.close();
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const admin = await services.accounts.registerWithEmail({
  email: ADMIN_EMAIL,
  password: 'qbazz-admin-dev',
  displayName: 'مدیر Qbazz',
}).catch(async () => ({ account: await services.accounts.findByIdentity('email', ADMIN_EMAIL) }));
await services.accounts.setRole(admin.account.id, 'admin');

const categories = await services.catalog.listCategories();
const cat = Object.fromEntries(categories.map((category) => [category.slug, category.id]));

// ---------------------------------------------------------------------------
// Shops. Each one is a kind of clothing business the taxonomy has a place for.
// ---------------------------------------------------------------------------

// Added to a shop's list below. Same shape as the products in SHOPS.
const MORE_PRODUCTS = {
  'mezon-setareh': [
    {
      photo: 'Tartan Dress', type: 'dress', title: 'پیراهن چهارخانه تارتان', price: toman(1590000), stock: 6,
      description: 'پیراهن یقه‌دار با طرح تارتان کلاسیک، دامن کلوش و کمربند پارچه‌ای؛ مناسب پاییز و محیط کار.',
      tags: ['پیراهن', 'تارتان', 'چهارخانه'],
      properties: [['جنس', 'ویسکوز مخلوط'], ['رنگ', 'قرمز و مشکی'], ['سایز', '۳۶ تا ۴۴']],
    },
    {
      photo: 'SceneSKU womens-fashion 4', type: 'dress', title: 'پیراهن یقه‌ایستاده زیتونی', price: toman(1390000), compareAtPrice: toman(1650000), stock: 9,
      description: 'پیراهن اِی‌لاین با یقهٔ ایستاده، چین ظریف و آستین کوتاه پرچینی؛ ست‌کردنش با هر کفش و کیفی آسان است.',
      tags: ['پیراهن', 'زیتونی', 'یقه ایستاده'],
      properties: [['جنس', 'مخلوط نخی'], ['رنگ', 'سبز زیتونی'], ['سایز', '۳۶ تا ۴۶']],
    },
    {
      photo: 'SceneSKU womens-fashion 1', type: 'dress', title: 'پیراهن بلند بدون‌آستین تابستانه', price: toman(1750000), stock: 5,
      description: 'پیراهن بلند و گشاد بدون آستین با دکمهٔ جلو، دو جیب و چاک ظریف؛ نخی و خنک، مناسب بهار و تابستان.',
      tags: ['پیراهن', 'تابستانه', 'بدون آستین'],
      properties: [['جنس', 'مخلوط نخی نرم'], ['رنگ', 'روشن'], ['سایز', '۳۶ تا ۴۴']],
    },
    {
      photo: 'SceneSKU womens-fashion 2', type: 'dress', title: 'ست دامن بلند کمرکش و بلوز', price: toman(2900000), stock: 6,
      description: 'ست پاییزی: دامن بلند با کمر بالا و بلوز گشادِ یقه‌گرد آستین بلند؛ نرم، راحت و مناسب محل کار.',
      tags: ['ست', 'دامن بلند', 'پاییزه'],
      properties: [['جنس', 'پارچهٔ نرم و تنفس‌پذیر'], ['رنگ', 'طیف پاییزی'], ['سایز', '۳۶ تا ۴۴']],
    },
  ],
  'poshak-arian': [
    {
      photo: 'Man Plaid Shirt', type: 'shirt', title: 'پیراهن پلید مردانه', price: toman(820000), stock: 16,
      description: 'پیراهن چهارخانهٔ پلید با پارچهٔ نرم و دکمه‌های مات؛ برای روزهای خنک.',
      tags: ['پیراهن', 'پلید', 'چهارخانه'],
      properties: [['جنس', 'نخی'], ['رنگ', 'قرمز و سرمه‌ای'], ['سایز', 'M تا XXL']],
    },
    {
      photo: 'Men Check Shirt', type: 'shirt', title: 'پیراهن چک آستین کوتاه', price: toman(690000), stock: 20,
      description: 'پیراهن چک با آستین کوتاه و برش راحت؛ مناسب تابستان.',
      tags: ['پیراهن', 'چک', 'تابستانی'],
      properties: [['جنس', 'نخ پنبه'], ['رنگ', 'آبی و سفید'], ['سایز', 'M تا XXL']],
    },
    {
      photo: 'Man Short Sleeve Shirt', type: 'shirt', title: 'پیراهن آستین کوتاه ساده', price: toman(650000), stock: 25,
      description: 'پیراهن ساده با یقهٔ کلاسیک و پارچهٔ خنک؛ اتو نمی‌خواهد.',
      tags: ['پیراهن', 'ساده', 'آستین کوتاه'],
      properties: [['جنس', 'نخی پلی‌استر'], ['رنگ', 'آبی روشن'], ['سایز', 'M تا XXL']],
    },
  ],
};

const SHOPS = [
  {
    owner: { displayName: 'ستاره احمدی', telegram: '900000001' },
    store: {
      name: 'مزون ستاره',
      slug: 'mezon-setareh',
      tagline: 'مانتو و لباس مجلسی با دوخت اختصاصی',
      description: 'مزون طراحی و دوخت مانتو، لباس مجلسی و پیراهن‌های زنانه. پارچهٔ مرغوب، دوخت دقیق و ارسال به سراسر کشور.',
      categoryIds: [cat['one-piece']],
      currency: CURRENCY,
      location: { city: 'تهران', country: 'ایران', address: 'تهران، ونک، خیابان ملاصدرا' },
      contact: { phone: '+989121110001', telegram: '@mezon_setareh' },
      settings: { paymentMethods: ['online', 'bank_transfer'], fulfillmentMethods: ['delivery', 'pickup'], deliveryFee: toman(45000), freeDeliveryOver: toman(3000000), prepTimeMinutes: 1440 },
    },
    products: [
      {
        type: 'manteau', title: 'مانتو کتان اسپرت', price: toman(1850000), stock: 8,
        description: 'مانتوی کتان نخی با پارچهٔ خنک و ضدچروک، مناسب بهار و تابستان. آستین سه‌ربع و جیب‌دار.',
        tags: ['مانتو', 'کتان', 'اسپرت'],
        properties: [['جنس', 'کتان نخی'], ['رنگ', 'کرم'], ['سایز', '۳۶ تا ۴۴']],
      },
      {
        type: 'manteau', title: 'مانتو جلوباز مجلسی', price: toman(2650000), compareAtPrice: toman(3100000), stock: 4,
        description: 'مانتوی جلوباز با پارچهٔ کرپ و سجاف دست‌دوز؛ مناسب مهمانی و مراسم.',
        tags: ['مانتو', 'مجلسی', 'جلوباز'],
        properties: [['جنس', 'کرپ'], ['رنگ', 'سرمه‌ای'], ['سایز', '۳۸ تا ۴۶']],
      },
      {
        photo: 'SceneSKU womens-fashion 5', type: 'evening-dress', title: 'پیراهن پلیسهٔ نامتقارن آستین‌بلند', price: toman(3900000), stock: 3,
        description: 'پیراهن شیکِ پلیسه با لبهٔ نامتقارن، آستین بلند و کمربند؛ سبک و تنفس‌پذیر، مناسب مهمانی بهاری و پاییزی.',
        tags: ['لباس مجلسی', 'پلیسه', 'آستین بلند'],
        properties: [['جنس', 'پارچهٔ سبک و روان'], ['رنگ', 'مشکی'], ['سایز', '۳۶ تا ۴۲']],
      },
      {
        photo: 'Marni Red & Black Suit', type: 'jumpsuit', title: 'جامپ سوت کرپ', price: toman(2250000), stock: 6,
        description: 'جامپ سوت گشاد با کمربند پارچه‌ای؛ راحت، شیک و مناسب هر فصل.',
        tags: ['جامپ سوت', 'کرپ'],
        properties: [['جنس', 'کرپ حریر'], ['رنگ', 'مشکی'], ['سایز', 'فری‌سایز']],
      },
      {
        type: 'overalls', title: 'اورال جین دخترانه', price: toman(1650000), stock: 7,
        description: 'اورال جین با شستشوی ملایم و بندهای قابل تنظیم.',
        tags: ['اورال', 'جین'],
        properties: [['جنس', 'جین'], ['رنگ', 'آبی روشن'], ['سایز', '۳۶ تا ۴۲']],
      },
      {
        photo: 'SceneSKU womens-fashion 3', type: 'dress', title: 'پیراهن بلند کمربنددار کتان', price: toman(2250000), compareAtPrice: toman(2600000), stock: 10,
        description: 'پیراهن بلند یقه‌دار با کمربند، چاک کناری و پارچهٔ کتان خنک؛ هم برای محل کار، هم قرار روزمره.',
        tags: ['پیراهن', 'کتان', 'کمربنددار'],
        properties: [['جنس', 'کتان'], ['رنگ', 'یک‌رنگ'], ['سایز', '۳۶ تا ۴۶']],
      },
    ],
  },
  {
    owner: { displayName: 'آرین محمدی', telegram: '900000002' },
    store: {
      name: 'پوشاک آرین',
      slug: 'poshak-arian',
      tagline: 'پوشاک مردانه، شیک و راحت',
      description: 'تیشرت، پیراهن، شلوار و کت مردانه از برندهای ایرانی. مرجوعی تا هفت روز و ارسال از اصفهان به سراسر ایران.',
      categoryIds: [cat['upper-body'], cat['lower-body']],
      currency: CURRENCY,
      location: { city: 'اصفهان', country: 'ایران', address: 'اصفهان، خیابان چهارباغ بالا' },
      contact: { phone: '+989131110002' },
      settings: { paymentMethods: ['online', 'bank_transfer'], fulfillmentMethods: ['delivery'], deliveryFee: toman(50000), freeDeliveryOver: toman(2500000) },
    },
    products: [
      {
        photo: 'Gigabyte Aorus Men Tshirt', type: 'tshirt', title: 'تیشرت نخی یقه گرد', price: toman(420000), stock: 40,
        description: 'تیشرت ساده از نخ پنبه؛ نرم، بدون پرزدهی و مناسب استفادهٔ روزمره.',
        tags: ['تیشرت', 'نخی', 'مردانه'],
        properties: [['جنس', 'پنبه ۱۰۰٪'], ['رنگ', 'مشکی، سفید، سرمه‌ای'], ['سایز', 'M تا XXL']],
      },
      {
        photo: 'Blue & Black Check Shirt', type: 'shirt', title: 'پیراهن مردانه آستین بلند', price: toman(780000), stock: 22,
        description: 'پیراهن رسمی با یقهٔ کلاسیک و دوخت ایستاده؛ اتو نمی‌خواهد.',
        tags: ['پیراهن', 'رسمی', 'مردانه'],
        properties: [['جنس', 'نخی پلی‌استر'], ['رنگ', 'آبی آسمانی'], ['سایز', 'M تا XXL']],
      },
      {
        type: 'jeans', title: 'شلوار جین مستقیم', price: toman(1350000), compareAtPrice: toman(1600000), stock: 18,
        description: 'شلوار جین راسته با پارچهٔ کش‌دار و دوام بالا.',
        tags: ['جین', 'شلوار', 'مردانه'],
        properties: [['جنس', 'جین کش‌دار'], ['رنگ', 'سرمه‌ای'], ['سایز', '۳۰ تا ۳۸']],
      },
      {
        type: 'trousers', title: 'شلوار کتان', price: toman(990000), stock: 15,
        description: 'شلوار پارچه‌ای کتان با قد مچی؛ مناسب اداری و اسپرت.',
        tags: ['شلوار', 'کتان', 'پارچه‌ای'],
        properties: [['جنس', 'کتان'], ['رنگ', 'کرم'], ['سایز', '۳۰ تا ۳۸']],
      },
      {
        type: 'blazer', title: 'کت تک اسپرت', price: toman(3200000), stock: 5,
        description: 'کت تک با آستر کامل و دکمه‌های مات؛ برش مدرن.',
        tags: ['کت', 'اسپرت'],
        properties: [['جنس', 'پشم مخلوط'], ['رنگ', 'طوسی'], ['سایز', '۵۰ تا ۵۸']],
      },
      {
        type: 'pullover', title: 'پلیور بافت زمستانی', price: toman(1150000), stock: 12,
        description: 'پلیور بافت گرم و سبک با یقهٔ هفت.',
        tags: ['پلیور', 'زمستانی', 'بافت'],
        properties: [['جنس', 'اکریلیک پشمی'], ['رنگ', 'قهوه‌ای'], ['سایز', 'M تا XXL']],
      },
      {
        type: 'sweatshirt', title: 'سویشرت جیب‌دار', price: toman(890000), stock: 14,
        description: 'سویشرت کلاسیک با پارچهٔ داخل‌کرکی و جیب کنگرویی.',
        tags: ['سویشرت', 'مردانه'],
        properties: [['جنس', 'پنبه کرکی'], ['رنگ', 'زرشکی'], ['سایز', 'M تا XXL']],
      },
    ],
  },
  {
    owner: { displayName: 'پارسا کریمی', telegram: '900000003' },
    store: {
      name: 'ورزش‌پوش پارسا',
      slug: 'varzesh-push-parsa',
      tagline: 'لباس ورزشی برای تمرین و پیاده‌روی',
      description: 'ست، لگ، تاپ و هودی ورزشی با پارچهٔ تنفس‌پذیر و دوخت مقاوم. مناسب باشگاه، دویدن و یوگا.',
      categoryIds: [cat.sportswear],
      currency: CURRENCY,
      location: { city: 'مشهد', country: 'ایران', address: 'مشهد، بلوار وکیل‌آباد' },
      contact: { phone: '+989151110003' },
      settings: { paymentMethods: ['online', 'bank_transfer'], fulfillmentMethods: ['delivery'], deliveryFee: toman(40000), minOrder: toman(300000) },
    },
    products: [
      {
        type: 'sport-set', title: 'ست ورزشی دو تکه', price: toman(1250000), stock: 20,
        description: 'ست تاپ و لگ با پارچهٔ فوق‌کشسان و درز تخت؛ بدون تحریک پوست.',
        tags: ['ست ورزشی', 'یوگا', 'باشگاه'],
        properties: [['جنس', 'پلی‌آمید لایکرا'], ['رنگ', 'مشکی'], ['سایز', 'S تا XL']],
      },
      {
        type: 'sport-leggings', title: 'لگ ورزشی کمر بلند', price: toman(560000), compareAtPrice: toman(690000), stock: 35,
        description: 'لگ کمر بلند با کشسانی چهارطرفه و جیب کناری برای گوشی.',
        tags: ['لگ', 'ورزشی', 'کمر بلند'],
        properties: [['جنس', 'لایکرا'], ['رنگ', 'خاکستری'], ['سایز', 'S تا XL']],
      },
      {
        type: 'sport-top', title: 'تاپ ورزشی', price: toman(340000), stock: 30,
        description: 'تاپ ورزشی با فوم قابل‌جداشدن و پشت ضربدری.',
        tags: ['تاپ', 'ورزشی'],
        properties: [['جنس', 'پلی‌استر تنفس‌پذیر'], ['رنگ', 'یاسی'], ['سایز', 'S تا XL']],
      },
      {
        type: 'sport-shorts', title: 'شلوارک ورزشی', price: toman(290000), stock: 25,
        description: 'شلوارک سبک با کش کمر و جیب زیپ‌دار.',
        tags: ['شلوارک', 'ورزشی'],
        properties: [['جنس', 'میکروفایبر'], ['رنگ', 'سرمه‌ای'], ['سایز', 'M تا XXL']],
      },
      {
        photo: 'SceneSKU shoes 1', type: 'sportswear', title: 'کفش کتانی مردانه طوسی ساقه‌کوتاه', price: toman(1850000), stock: 14,
        description: 'کتانی سبک و راحت با زیرهٔ ضدلغزش؛ برای پیاده‌روی، باشگاه و استفادهٔ روزمره.',
        tags: ['کفش', 'کتانی', 'مردانه'],
        properties: [['جنس', 'پارچهٔ تنفس‌پذیر'], ['رنگ', 'طوسی'], ['سایز', '۴۰ تا ۴۵']],
      },
      {
        photo: 'SceneSKU shoes 2', type: 'sportswear', title: 'کفش تمرین زنانه صورتی', price: toman(1650000), compareAtPrice: toman(1950000), stock: 12,
        description: 'کفش تمرین سبک با پنجهٔ انعطاف‌پذیر و کفی نرم؛ مناسب هوازی، یوگا و تمرین‌های گروهی.',
        tags: ['کفش', 'تمرین', 'زنانه'],
        properties: [['جنس', 'توری تنفس‌پذیر'], ['رنگ', 'صورتی'], ['سایز', '۳۶ تا ۴۱']],
      },
      {
        photo: 'SceneSKU shoes 3', type: 'sportswear', title: 'کفش دویدن زنانه سبز فسفری', price: toman(2150000), stock: 10,
        description: 'کفش دویدن با جذب ضربهٔ بالا و رنگ شبرنگ‌نما که در تمرین صبح و غروب دیده می‌شوید.',
        tags: ['کفش', 'دویدن', 'زنانه'],
        properties: [['جنس', 'توری سبک و فوم ضربه‌گیر'], ['رنگ', 'سبز فسفری'], ['سایز', '۳۶ تا ۴۱']],
      },
      {
        photo: 'SceneSKU shoes 4', type: 'sportswear', title: 'کفش کتانی پارچه‌ای سفید', price: toman(1250000), stock: 20,
        description: 'کتانی کلاسیک سفید و ساده با ساقهٔ کوتاه؛ با همه‌چیز ست می‌شود.',
        tags: ['کفش', 'کتانی', 'سفید'],
        properties: [['جنس', 'کنفی'], ['رنگ', 'سفید'], ['سایز', '۳۶ تا ۴۴']],
      },
      {
        photo: 'SceneSKU shoes 5', type: 'sportswear', title: 'کفش اسپرت مدرن آبی‌بنفش', price: toman(2450000), stock: 8,
        description: 'کفش اسپرت با طراحی امروزی، رویهٔ دورنگ آبی و بنفش و کفی طبی.',
        tags: ['کفش', 'اسپرت'],
        properties: [['جنس', 'رویهٔ مش'], ['رنگ', 'آبی و بنفش'], ['سایز', '۳۸ تا ۴۵']],
      },
      {
        type: 'sport-hoodie', title: 'هودی ورزشی زیپ‌دار', price: toman(980000), stock: 16,
        description: 'هودی زیپ‌دار با کلاه دو لایه، مناسب گرم‌کردن و پیاده‌روی در هوای خنک.',
        tags: ['هودی', 'ورزشی', 'زیپ‌دار'],
        properties: [['جنس', 'پنبه و پلی‌استر'], ['رنگ', 'مشکی'], ['سایز', 'M تا XXL']],
      },
    ],
  },
  {
    owner: { displayName: 'لیلا صادقی', telegram: '900000004' },
    store: {
      name: 'گرمینه',
      slug: 'garmineh',
      tagline: 'پوشاک پاییزه و زمستانه، از تبریز',
      description: 'کاپشن، پالتو، بارانی و شنل برای روزهای سرد. پارچه و آستر گرم، دوخت تبریز، ارسال سریع.',
      categoryIds: [cat['autumn-winter']],
      currency: CURRENCY,
      location: { city: 'تبریز', country: 'ایران', address: 'تبریز، خیابان ولیعصر' },
      contact: { phone: '+989141110004' },
      settings: { paymentMethods: ['online', 'bank_transfer'], fulfillmentMethods: ['delivery', 'pickup'], deliveryFee: toman(55000), freeDeliveryOver: toman(4000000) },
    },
    products: [
      {
        type: 'puffer', title: 'کاپشن پافر سبک', price: toman(4300000), compareAtPrice: toman(4900000), stock: 9,
        description: 'پافر با پر مصنوعی سبک و ضدآب؛ گرم تا ده درجهٔ زیر صفر.',
        tags: ['پافر', 'کاپشن', 'زمستانی'],
        properties: [['جنس', 'پارچهٔ ضدآب با پر مصنوعی'], ['رنگ', 'سرمه‌ای'], ['سایز', 'S تا XXL']],
      },
      {
        type: 'raincoat', title: 'بارانی بلند', price: toman(1950000), stock: 11,
        description: 'بارانی بلند با کلاه و کمربند؛ ضدآب و سبک.',
        tags: ['بارانی', 'ضدآب'],
        properties: [['جنس', 'پلی‌استر ضدآب'], ['رنگ', 'زیتونی'], ['سایز', 'فری‌سایز']],
      },
      {
        type: 'poncho', title: 'پانچو بافت', price: toman(1350000), stock: 7,
        description: 'پانچوی بافت دست‌باف با ریشه‌های ظریف.',
        tags: ['پانچو', 'بافت'],
        properties: [['جنس', 'اکریلیک نرم'], ['رنگ', 'طوسی'], ['سایز', 'فری‌سایز']],
      },
      {
        type: 'cape', title: 'شنل پشمی', price: toman(2100000), stock: 5,
        description: 'شنل پشمی با دکمه‌های چوبی و یقهٔ بلند.',
        tags: ['شنل', 'پشمی'],
        properties: [['جنس', 'پشم'], ['رنگ', 'عسلی'], ['سایز', 'فری‌سایز']],
      },
      {
        type: 'windbreaker', title: 'بادگیر سبک', price: toman(1150000), stock: 20,
        description: 'بادگیر تاشو با کلاه جمع‌شونده؛ در کیف جا می‌شود.',
        tags: ['بادگیر', 'سبک'],
        properties: [['جنس', 'پاراشوت'], ['رنگ', 'مشکی'], ['سایز', 'M تا XXL']],
      },
      {
        type: 'outer-jacket', title: 'کاپشن دو رو', price: toman(3600000), stock: 8,
        description: 'کاپشن دو رو با آستر خزدار؛ از هر دو طرف قابل پوشیدن است.',
        tags: ['کاپشن', 'دو رو'],
        properties: [['جنس', 'میکرو با آستر خز'], ['رنگ', 'مشکی و کرم'], ['سایز', 'S تا XXL']],
      },
      {
        // A coat is a top, not autumn/winter wear: listing it files the shop under both groups.
        type: 'overcoat', title: 'پالتو پشمی دو ردیف', price: toman(5400000), stock: 4,
        description: 'پالتوی بلند پشمی با دو ردیف دکمه و آستر ابریشمی.',
        tags: ['پالتو', 'پشمی'],
        properties: [['جنس', 'پشم و کشمیر'], ['رنگ', 'شتری'], ['سایز', 'S تا XL']],
      },
    ],
  },
  {
    owner: { displayName: 'ماهور نیک‌خواه', telegram: '900000006' },
    store: {
      name: 'ماهور، لباس زیر',
      slug: 'mahoor-underwear',
      tagline: 'لباس زیر نخی و راحت',
      description: 'لباس زیر زنانه و مردانه از نخ مرغوب؛ بسته‌بندی بهداشتی و ارسال محرمانه به سراسر کشور.',
      categoryIds: [cat.underwear],
      currency: CURRENCY,
      location: { city: 'رشت', country: 'ایران', address: 'رشت، خیابان گلسار' },
      contact: { phone: '+989111110006' },
      settings: { paymentMethods: ['online', 'bank_transfer'], fulfillmentMethods: ['delivery'], deliveryFee: toman(35000), freeDeliveryOver: toman(1500000) },
    },
    products: [
      {
        type: 'undershirt', title: 'زیرپوش نخی مردانه', price: toman(180000), stock: 60,
        description: 'زیرپوش رکابی از نخ پنبه؛ جذب عرق بالا.',
        tags: ['زیرپوش', 'نخی'],
        properties: [['جنس', 'پنبه ۱۰۰٪'], ['رنگ', 'سفید'], ['سایز', 'M تا XXL']],
      },
      {
        type: 'bra', title: 'سوتین بدون درز', price: toman(420000), stock: 24,
        description: 'سوتین بدون سیم و بدون درز، با بندهای قابل تنظیم.',
        tags: ['سوتین', 'بدون درز'],
        properties: [['جنس', 'میکروفایبر'], ['رنگ', 'بژ'], ['سایز', '۷۵ تا ۹۰']],
      },
      {
        type: 'shapewear', title: 'گن شکم‌بند', price: toman(650000), compareAtPrice: toman(780000), stock: 15,
        description: 'گن با کشسانی متوسط و بدون برجستگی زیر لباس.',
        tags: ['گن', 'شکم‌بند'],
        properties: [['جنس', 'نایلون و لایکرا'], ['رنگ', 'بژ'], ['سایز', 'M تا 3XL']],
      },
      {
        type: 'panties', title: 'شورت نخی بسته سه‌تایی', price: toman(310000), stock: 45,
        description: 'بستهٔ سه‌تایی شورت نخی با کش نرم و بدون فشار.',
        tags: ['شورت', 'نخی'],
        properties: [['جنس', 'پنبه ۹۵٪ و لایکرا ۵٪'], ['رنگ', 'رنگی'], ['سایز', 'S تا XL']],
      },
      {
        type: 'briefs', title: 'بریف مردانه', price: toman(240000), stock: 40,
        description: 'بریف مردانه با دوخت راحت و کش پهن.',
        tags: ['بریف', 'مردانه'],
        properties: [['جنس', 'پنبه'], ['رنگ', 'مشکی'], ['سایز', 'M تا XXL']],
      },
      {
        type: 'underpants', title: 'زیرشلواری حرارتی', price: toman(380000), stock: 28,
        description: 'زیرشلواری داخل‌کرکی برای روزهای سرد زمستان.',
        tags: ['زیرشلواری', 'حرارتی', 'زمستانی'],
        properties: [['جنس', 'پنبه کرکی'], ['رنگ', 'طوسی'], ['سایز', 'M تا XXL']],
      },
    ],
  },
];

const created = [];
console.log('Downloading product photos (cached after the first run)…');
await prefetchPhotos([...Object.values(SHOPS).flatMap((shop) => shop.products), ...Object.values(MORE_PRODUCTS).flat()].map((p) => p.photo).filter(Boolean));

for (const shop of SHOPS) {
  const { account } = await services.accounts.resolveChannelIdentity({
    channel: 'telegram',
    externalId: shop.owner.telegram,
    profile: { displayName: shop.owner.displayName },
  });

  await giveAvatar(account, shop.owner.telegram);
  const store = await services.stores.create(account.id, shop.store);
  await giveLogo(shop.store.slug, account.id, (url) => services.stores.update(store.id, { logoUrl: url }));
  for (const { type, properties, photo, ...product } of [...shop.products, ...(MORE_PRODUCTS[shop.store.slug] || [])]) {
    await services.catalog.createProduct(store.id, {
      ...product,
      images: photo ? await storePhotos(photo, account.id) : [],
      categoryId: cat[type],
      properties: properties.map(([name, value]) => ({ name, value })),
      status: 'active',
    }, { actorAccountId: account.id });
  }

  await services.stores.submitForReview(store.id, account.id);
  await services.admin.approveStore(admin.account.id, store.id);
  created.push(store);
}

await giveLogo('qbazz-admin', admin.account.id, (url) => services.accounts.update(admin.account.id, { avatarUrl: url }));
await services.admin.setFeatured(admin.account.id, created[0].id, true);
await services.admin.setVerified(admin.account.id, created[1].id, true);

// ---------------------------------------------------------------------------
// Buyers with delivered, rated orders, so analytics and ratings are not empty.
// ---------------------------------------------------------------------------

async function deliveredOrder({ telegram, name, phone, address, storeIndex, productTitle, rating, comment }) {
  const { account: buyer } = await services.accounts.resolveChannelIdentity({
    channel: 'telegram',
    externalId: telegram,
    profile: { displayName: name },
  });
  await giveAvatar(buyer, telegram);
  const shop = created[storeIndex];
  const product = (await services.catalog.listProducts({ storeId: shop.id })).items.find((item) => item.title === productTitle);
  const cart = await services.carts.addItem(buyer.id, { productId: product.id, quantity: 1, channel: 'telegram' });
  const order = await services.orders.checkout(buyer.id, cart.id, {
    contact: { name, phone },
    address,
    fulfillmentMethod: 'delivery',
    paymentMethod: 'online',
    channel: 'telegram',
  });
  const ownerId = shop.ownerAccountId;
  await services.orders.markPaid(order.id, { provider: 'sandbox', refId: 'SEED-' + order.code });
  await services.orders.updateStatus(order.id, 'confirmed', { actorAccountId: ownerId });
  await services.orders.updateStatus(order.id, 'shipped', { actorAccountId: ownerId });
  await services.orders.updateStatus(order.id, 'delivered', { actorAccountId: ownerId });
  await services.orders.rate(order.id, buyer.id, { rating, comment });
}

await deliveredOrder({
  telegram: '900000100',
  name: 'نگار رضایی',
  phone: '+989123456789',
  address: { line1: 'تهران، خیابان ولیعصر، نبش کوچهٔ ۱۲، پلاک ۸', city: 'تهران' },
  storeIndex: 0,
  productTitle: 'مانتو کتان اسپرت',
  rating: 5,
  comment: 'مانتو دقیقاً مثل عکس بود؛ دوخت و پارچه عالی، ممنون از بسته‌بندی تمیزتان.',
});

await deliveredOrder({
  telegram: '900000101',
  name: 'کامران فرهادی',
  phone: '+989131234567',
  address: { line1: 'اصفهان، چهارباغ بالا، کوچهٔ شهید احمدی، پلاک ۱۵', city: 'اصفهان' },
  storeIndex: 1,
  productTitle: 'شلوار جین مستقیم',
  rating: 4,
  comment: 'کیفیت پارچه خوب بود و سایز درست آمد؛ فقط ارسال یک روز دیرتر رسید.',
});

// ---------------------------------------------------------------------------
// One shop left in the queue so the admin review screen has something to show.
// ---------------------------------------------------------------------------

const { account: hopeful } = await services.accounts.resolveChannelIdentity({
  channel: 'telegram',
  externalId: '900000005',
  profile: { displayName: 'نگین حسینی' },
});
await giveAvatar(hopeful, '900000005');
const pending = await services.stores.create(hopeful.id, {
  name: 'خانه‌پوش نگین',
  slug: 'khaneh-push-negin',
  tagline: 'لباس راحتی و خواب برای خانه',
  description: 'ست راحتی، لباس خواب و پوشاک خانگی از پارچه‌های نرم و نخی؛ دوخت شیراز.',
  categoryIds: [cat['at-home']],
  currency: CURRENCY,
  location: { city: 'شیراز', country: 'ایران', address: 'شیراز، بلوار چمران' },
  contact: { phone: '+989171110005' },
  settings: { paymentMethods: ['online', 'bank_transfer'], fulfillmentMethods: ['delivery'], deliveryFee: toman(40000) },
});
for (const product of [
  { type: 'lounge-set', title: 'ست راحتی نخی', price: toman(1150000), description: 'ست دو تکهٔ نخی با شلوار کش‌دار و تیشرت گشاد.', tags: ['ست راحتی', 'نخی'] },
  { type: 'sleepwear', title: 'لباس خواب ساتن', price: toman(890000), description: 'لباس خواب ساتن دو تکه با ژاکت بلند.', tags: ['لباس خواب', 'ساتن'] },
  { type: 'lounge-pants', title: 'شلوار راحتی', price: toman(420000), description: 'شلوار راحتی با کش کمر و جیب‌دار.', tags: ['شلوار راحتی'] },
  { type: 'lounge-tshirt', title: 'تیشرت راحتی', price: toman(350000), description: 'تیشرت راحتی گشاد از پنبهٔ نرم.', tags: ['تیشرت راحتی'] },
]) {
  const { type, ...data } = product;
  await services.catalog.createProduct(pending.id, { ...data, stock: 12, status: 'active', categoryId: cat[type] }, { actorAccountId: hopeful.id });
}
await giveLogo('khaneh-push-negin', hopeful.id, (url) => services.stores.update(pending.id, { logoUrl: url }));
await services.stores.submitForReview(pending.id, hopeful.id);

await core.close();

if (photoFailures) console.log(`${photoFailures} photo(s) could not be downloaded (offline?). Re-run the seed when online, or add photos from the web.`);
console.log(`
${created.length} فروشگاه فعال، ۱ فروشگاه در صف بررسی و ۲ سفارش تحویل‌شده ساخته شد.
Seeded ${created.length} live shops, 1 awaiting review, 2 delivered and rated orders. All in Persian, priced in Toman.

  Admin login   ${ADMIN_EMAIL} / qbazz-admin-dev
  Live shops    ${created.map((s) => s.slug).join(', ')}
  Review queue  ${pending.name}

Start the API:  npm run core
Then try:       curl http://localhost:8080/feed
`);
