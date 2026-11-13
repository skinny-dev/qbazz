/**
 * The platform's category tree: fashion, in two levels.
 *
 * Qbazz launches for clothing sellers only, so the taxonomy *is* the product
 * catalogue's shape — eight groups a shop is filed under, and the specific
 * kinds of garment inside each one that a single product is filed under.
 *
 * This file is the one place the tree is written down. Names live here in both
 * languages and are exposed to the i18n catalogs as `category.<slug>`, so a
 * category can never exist in one language and be missing in the other.
 *
 * Slugs are ASCII, stable and unique across the whole tree (they are stored,
 * used in URLs and keyed in the catalogs). A garment that appears under two
 * groups — کاپشن is both a top and autumn/winter outerwear — is two categories
 * with two slugs, so each can be browsed inside its own group.
 *
 * Persian is written with ‌ (ZWNJ, the half-space) escaped so it survives
 * editors that hide invisible characters.
 */
export const TAXONOMY = [
  {
    slug: 'upper-body', icon: '👕', en: 'Tops', fa: 'لباس‌های بالاتنه',
    children: [
      { slug: 'tshirt', en: 'T-shirt', fa: 'تیشرت' },
      { slug: 'shirt', en: 'Shirt', fa: 'پیراهن' },
      { slug: 'shomiz', en: 'Dress blouse (shomiz)', fa: 'شومیز' },
      { slug: 'blouse', en: 'Blouse', fa: 'بلوز' },
      { slug: 'tunic', en: 'Tunic', fa: 'تونیک' },
      { slug: 'hoodie', en: 'Hoodie', fa: 'هودی' },
      { slug: 'sweatshirt', en: 'Sweatshirt', fa: 'سویشرت' },
      { slug: 'pullover', en: 'Pullover', fa: 'پلیور' },
      { slug: 'cardigan', en: 'Cardigan', fa: 'ژاکت' },
      { slug: 'blazer', en: 'Blazer', fa: 'کت' },
      { slug: 'jacket', en: 'Jacket', fa: 'کاپشن' },
      { slug: 'overcoat', en: 'Overcoat', fa: 'پالتو' },
    ],
  },
  {
    slug: 'lower-body', icon: '👖', en: 'Bottoms', fa: 'لباس‌های پایین‌تنه',
    children: [
      { slug: 'pants', en: 'Pants', fa: 'شلوار' },
      { slug: 'jeans', en: 'Jeans', fa: 'شلوار جین' },
      { slug: 'trousers', en: 'Fabric trousers', fa: 'شلوار پارچه‌ای' },
      { slug: 'shorts', en: 'Shorts', fa: 'شلوارک' },
      { slug: 'skirt', en: 'Skirt', fa: 'دامن' },
      { slug: 'supporter', en: 'Thick leggings (sapport)', fa: 'ساپورت' },
      { slug: 'leggings', en: 'Leggings', fa: 'لگ' },
      { slug: 'baggy-pants', en: 'Baggy pants', fa: 'شلوار بگ' },
      { slug: 'slash-pants', en: 'Slash pants', fa: 'شلوار اسلش' },
    ],
  },
  {
    slug: 'one-piece', icon: '👗', en: 'One-piece', fa: 'لباس‌های یک‌تکه',
    children: [
      { slug: 'dress', en: 'One-piece dress', fa: 'پیراهن یک‌سره' },
      { slug: 'manteau', en: 'Manteau', fa: 'مانتو' },
      { slug: 'overalls', en: 'Overalls', fa: 'اورال' },
      { slug: 'evening-dress', en: 'Evening dress', fa: 'لباس مجلسی' },
      { slug: 'jumpsuit', en: 'Jumpsuit', fa: 'جامپ سوت' },
    ],
  },
  {
    slug: 'at-home', icon: '🏠', en: 'Homewear', fa: 'لباس‌های خانه',
    children: [
      { slug: 'comfort-wear', en: 'Comfort wear', fa: 'لباس‌های راحتی' },
      { slug: 'homewear', en: 'Home clothes', fa: 'لباس خانگی' },
      { slug: 'lounge-set', en: 'Lounge set', fa: 'ست راحتی' },
      { slug: 'lounge-tshirt', en: 'Lounge T-shirt', fa: 'تیشرت راحتی' },
      { slug: 'lounge-pants', en: 'Lounge pants', fa: 'شلوار راحتی' },
      { slug: 'sleepwear', en: 'Sleepwear', fa: 'لباس خواب' },
    ],
  },
  {
    slug: 'sportswear', icon: '🏃', en: 'Sportswear', fa: 'لباس‌های ورزشی',
    children: [
      { slug: 'sport-set', en: 'Sports set', fa: 'ست ورزشی' },
      { slug: 'sport-leggings', en: 'Sports leggings', fa: 'لگ ورزشی' },
      { slug: 'sport-top', en: 'Sports top', fa: 'تاپ ورزشی' },
      { slug: 'sport-shorts', en: 'Sports shorts', fa: 'شلوارک ورزشی' },
      { slug: 'sport-hoodie', en: 'Sports hoodie', fa: 'هودی ورزشی' },
    ],
  },
  {
    slug: 'autumn-winter', icon: '🧥', en: 'Autumn & winter', fa: 'پاییزه و زمستانه',
    children: [
      { slug: 'raincoat', en: 'Raincoat', fa: 'بارانی' },
      { slug: 'poncho', en: 'Poncho', fa: 'پانچو' },
      { slug: 'cape', en: 'Cape', fa: 'شنل' },
      { slug: 'outer-jacket', en: 'Winter jacket', fa: 'کاپشن' },
      { slug: 'puffer', en: 'Puffer', fa: 'پافر' },
      { slug: 'windbreaker', en: 'Windbreaker', fa: 'بادگیر' },
    ],
  },
  {
    slug: 'underwear', icon: '🩲', en: 'Underwear', fa: 'لباس زیر',
    children: [
      { slug: 'undershirt', en: 'Undershirt', fa: 'زیرپوش' },
      { slug: 'bra', en: 'Bra', fa: 'سوتین' },
      { slug: 'panties', en: 'Shorts (underwear)', fa: 'شورت' },
      { slug: 'briefs', en: 'Briefs', fa: 'بریف' },
      { slug: 'shapewear', en: 'Shapewear', fa: 'گن' },
      { slug: 'underpants', en: 'Long underpants', fa: 'زیرشلواری' },
      { slug: 'corset', en: 'Corset', fa: 'کورست' },
      { slug: 'fishnet', en: 'Fishnet', fa: 'فیشنت' },
      { slug: 'sarafan', en: 'Sarafan (pinafore)', fa: 'سارافون' },
    ],
  },
  {
    // Added for shops that sell headwear and wraps (wholesale shawl and scarf channels).
    slug: 'scarves', icon: '🧣', en: 'Scarves & shawls', fa: 'شال و روسری',
    children: [
      { slug: 'headscarf', en: 'Headscarf', fa: 'روسری' },
      { slug: 'shawl', en: 'Shawl', fa: 'شال' },
      { slug: 'mini-scarf', en: 'Mini scarf', fa: 'مینی اسکارف' },
      { slug: 'neck-scarf', en: 'Neck scarf', fa: 'شال گردن و اسکارف' },
      { slug: 'scarf-set', en: 'Scarf set', fa: 'ست شال و روسری' },
    ],
  },
];

/**
 * The categories Qbazz shipped before it narrowed to fashion. They are retired
 * (or removed, when nothing uses them) rather than silently kept, so a shop
 * that was filed under "Electronics" does not appear under a category the
 * marketplace no longer has.
 */
export const LEGACY_CATEGORY_SLUGS = [
  'food-drinks', 'groceries', 'fashion', 'electronics', 'beauty', 'home', 'services', 'digital', 'handmade', 'other',
];

/**
 * The tree as flat rows, parents before children, with a global `order` that
 * keeps a group next to its own items when the whole list is sorted.
 */
export function flattenTaxonomy() {
  const rows = [];
  TAXONOMY.forEach((group, groupIndex) => {
    const base = (groupIndex + 1) * 100;
    rows.push({ slug: group.slug, parentSlug: null, icon: group.icon, order: base, en: group.en, fa: group.fa });
    group.children.forEach((child, childIndex) => {
      rows.push({ slug: child.slug, parentSlug: group.slug, icon: '', order: base + childIndex + 1, en: child.en, fa: child.fa });
    });
  });
  return rows;
}

/** `{ 'category.tshirt': 'تیشرت', … }` — spread into a language catalog. */
export function categoryNames(locale) {
  return Object.fromEntries(flattenTaxonomy().map((row) => [`category.${row.slug}`, row[locale] || row.en]));
}
